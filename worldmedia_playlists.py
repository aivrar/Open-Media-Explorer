"""User-owned M3U channel lists. Never fetched as catalogs or stored in cache.

Files and direct links are added offline. Online playlists use the existing
bounded, DNS-pinned public-network fetcher; playback/artwork use safe relays.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import threading
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit

from defusedxml.common import DefusedXmlException, DTDForbidden
from defusedxml.ElementTree import DefusedXMLParser

from worldmedia_catalog import BoundedFetcher
from worldmedia_media import SafeConnector
from worldmedia_runtime import _atomic_write_json

MAX_PLAYLIST_BYTES = 8 * 1024 * 1024
MAX_STORE_BYTES = 64 * 1024 * 1024
_ATTR = re.compile(r'([\w-]+)\s*=\s*(?:"([^"]*)"|\x27([^\x27]*)\x27|([^\s,]+))')


def _label(value: str, limit: int = 512) -> str:
    return re.sub(r'[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]', '', value).strip()[:limit]


def _web_url(value: str) -> str:
    if not value or len(value) > 4096 or re.search(r'[\x00-\x20\x7f\\|]', value):
        return ''
    try:
        url = urlsplit(value)
        host = (url.hostname or '').lower().rstrip('.')
        if (url.scheme not in {'http', 'https'} or not host or url.username is not None or url.password is not None
                or host == 'localhost' or host.endswith('.localhost') or url.port == 0):
            return ''
        try:
            if not ipaddress.ip_address(host).is_global:
                return ''
        except ValueError:
            pass  # Hostnames are DNS-checked when played, not during import.
        return value
    except ValueError:
        return ''


def _playlist_url(value: str, base_url: str) -> str:
    # Validate before urljoin: URL parsers can silently strip control characters.
    if not value or re.search(r'[\x00-\x20\x7f\\|]', value):
        return ''
    try:
        return _web_url(urljoin(base_url, value) if base_url else value)
    except ValueError:
        return ''


_PLS_KEY = re.compile(r'(file|title)(\d{1,9})')


def is_pls(text: str) -> bool:
    """True when the first line that is not blank or a comment is [playlist].
    Text that starts with #EXTM3U is always M3U."""
    if not isinstance(text, str):
        return False
    for raw in text.lstrip('\ufeff').splitlines():
        line = raw.strip()
        if line.upper().startswith('#EXTM3U'):
            return False
        if line and line[0] not in ';#':
            return line.lower() == '[playlist]'
    return False


def pls_to_m3u(text: str) -> str:
    """Rewrite a PLS playlist as the equivalent M3U text.

    Only M3U is ever stored, so older releases can still read playlists.json,
    and every entry then goes through parse_playlist's URL checks and limits.
    """
    if len(text.encode('utf-8')) > MAX_PLAYLIST_BYTES:
        raise ValueError('Playlist file exceeds the 8 MiB import limit; split it into smaller files.')
    entries: dict[int, dict[str, str]] = {}
    for raw in text.lstrip('\ufeff').splitlines():
        line = raw.strip()
        if not line or line[0] in ';#[':
            continue
        key, sep, value = line.partition('=')
        match = _PLS_KEY.fullmatch(key.strip().lower())
        if sep and match:
            entries.setdefault(int(match[2]), {})[match[1]] = value.strip()
    lines = ['#EXTM3U']
    for number in sorted(entries):
        url = entries[number].get('file', '')
        # A '#' line is a comment or directive in M3U, never an entry.
        if not url or url.startswith('#'):
            continue
        # The first comma after "-1" starts the name, so commas and '=' in it are kept as text.
        lines += [f"#EXTINF:-1,{_label(entries[number].get('title', ''))}", url]
    return '\n'.join(lines) + '\n'


XSPF_NS = 'http://xspf.org/ns/0/'
_XSPF_FIELDS = {'location', 'title', 'creator', 'image'}
_XSPF_MAX_DEPTH = 64
_XSPF_NOT_PLAYLIST = 'This file is XML or a web page, not an M3U, PLS or XSPF playlist.'
_XML_START = re.compile('\ufeff?\\s*<')
# Every character str.splitlines() breaks on: none may reach a stored M3U line.
_LINE_BREAK = re.compile('[\\n\\r\\x0b\\x0c\\x1c-\\x1e\\x85\\u2028\\u2029]')
_URL_SCHEME = re.compile(r'[A-Za-z][A-Za-z0-9+.-]*:')


class _NotXspf(ValueError):
    """XML (or HTML) whose root is not an XSPF <playlist>."""


def is_xml(text: str) -> bool:
    """True when the first non-blank character, after an optional BOM, is '<'.

    M3U and PLS never start that way, so such text is only ever read as XSPF:
    anything else that looks like XML is refused, never parsed as M3U."""
    return isinstance(text, str) and bool(_XML_START.match(text))


def _xspf_link(value: str) -> str:
    """A value that can sit on one M3U line; parse_playlist still checks it."""
    if not value or len(value) > 4096 or _LINE_BREAK.search(value) or value.startswith('#'):
        return ''
    return value


def _xspf_name(value: str) -> str:
    return _label(re.sub(r'\s+', ' ', value or ''))


class _XspfReader:
    """Streaming parser target. Never builds an XML tree: each track is turned
    into its two M3U lines when it ends, and dropped if it has no location."""

    def __init__(self):
        self.path: list[str] = []
        self.namespace = ''
        self.root_seen = False
        self.title = ''
        self.lines: list[str] = ['#EXTM3U']
        self._track: dict | None = None
        self._text: list[str] | None = None
        self._text_depth = 0

    def start(self, tag, attrib):
        namespace, _, local = tag[1:].partition('}') if tag.startswith('{') else ('', '', tag)
        if not self.path:
            if local != 'playlist' or namespace not in {'', XSPF_NS}:
                raise _NotXspf(_XSPF_NOT_PLAYLIST)
            self.namespace = namespace
            self.root_seen = True
        if len(self.path) >= _XSPF_MAX_DEPTH:
            raise ValueError('This XSPF playlist is nested too deeply to import.')
        # Extension elements in other namespaces are kept out of the path match.
        self.path.append(local if namespace == self.namespace else '')
        if self._text is not None:
            return
        if self.path == ['playlist', 'trackList', 'track']:
            # Only the chosen location is kept, however many a track lists.
            self._track = {'web': '', 'relative': '', 'other': ''}
        elif self.path == ['playlist', 'title'] or (
                self._track is not None and len(self.path) == 4 and local in _XSPF_FIELDS and self.path[3]):
            self._text = []
            self._text_depth = len(self.path)

    def data(self, text):
        if self._text is not None:
            self._text.append(text)

    def end(self, tag):
        depth = len(self.path)
        local = self.path.pop()
        if self._text is not None and depth == self._text_depth:
            value = ''.join(self._text).strip()
            self._text = None
            if depth == 2:
                self.title = self.title or _xspf_name(value)[:160]
            elif local == 'location':
                self._location(value)
            elif local not in self._track:
                self._track[local] = value
        elif depth == 3 and self._track is not None:
            self._finish(self._track)
            self._track = None

    def _location(self, value: str) -> None:
        # First public web address; else the first relative one (resolved for
        # online lists); else the first other one, so parse_playlist counts the
        # track as skipped instead of it vanishing.
        value = _xspf_link(value)
        track = self._track
        if not value or track['web']:
            return
        if _web_url(value):
            track['web'] = value
        elif not _URL_SCHEME.match(value):
            track['relative'] = track['relative'] or value
        else:
            track['other'] = track['other'] or value

    def _finish(self, track: dict) -> None:
        url = track['web'] or track['relative'] or track['other']
        if not url:
            return
        image = _xspf_link(track.get('image', ''))
        logo = f' tvg-logo="{image}"' if image and '"' not in image and (
            _web_url(image) or not _URL_SCHEME.match(image)) else ''
        name = _xspf_name(track.get('title', '')) or _xspf_name(track.get('creator', ''))
        self.lines += [f'#EXTINF:-1{logo},{name}', url]

    def close(self):
        return None


def read_xspf(text: str) -> tuple[str, str]:
    """Parse XSPF with DTDs and entities forbidden. Returns (playlist title, M3U text).

    Like PLS, only the equivalent M3U is ever stored, so older releases can still
    read playlists.json and every entry goes through parse_playlist's checks.
    Raises _NotXspf when the text is XML or HTML but not an XSPF playlist.
    """
    if len(text.encode('utf-8')) > MAX_PLAYLIST_BYTES:
        raise ValueError('Playlist file exceeds the 8 MiB import limit; split it into smaller files.')
    reader = _XspfReader()
    parser = DefusedXMLParser(target=reader, forbid_dtd=True, forbid_entities=True, forbid_external=True)
    text = text.lstrip('\ufeff')
    try:
        for start in range(0, len(text), 1 << 20):
            parser.feed(text[start:start + (1 << 20)])
        parser.close()
    except DTDForbidden as error:
        # A DOCTYPE comes before the root, so its name tells a web page from XSPF.
        if str(error.name).rpartition(':')[2] != 'playlist':
            raise _NotXspf(_XSPF_NOT_PLAYLIST) from None
        raise ValueError('This XSPF playlist contains a DTD or entity declarations, which are not allowed.') from None
    except DefusedXmlException:
        raise ValueError('This XSPF playlist contains a DTD or entity declarations, which are not allowed.') from None
    except (SyntaxError, RecursionError):
        if not reader.root_seen:
            raise _NotXspf(_XSPF_NOT_PLAYLIST) from None
        raise ValueError('This XSPF playlist is not valid XML.') from None
    return reader.title, '\n'.join(reader.lines) + '\n'


def xspf_to_m3u(text: str) -> str:
    """Rewrite an XSPF playlist as the equivalent M3U text."""
    return read_xspf(text)[1]


def as_m3u(text: str) -> str:
    """Playlist text as M3U: PLS and XSPF are converted, M3U is returned unchanged.

    Text that starts like XML is converted as XSPF or refused, never read as M3U."""
    if is_xml(text):
        return xspf_to_m3u(text)
    return pls_to_m3u(text) if is_pls(text) else text


def parse_playlist(text: str, default_type: str = 'tv', base_url: str = '') -> dict:
    if not isinstance(text, str) or not text.strip():
        raise ValueError('Choose a non-empty M3U, M3U8, PLS or XSPF channel playlist.')
    if len(text.encode('utf-8')) > MAX_PLAYLIST_BYTES:
        raise ValueError('Playlist file exceeds the 8 MiB import limit; split it into smaller files.')
    if not isinstance(default_type, str) or default_type not in {'tv', 'radio'}:
        raise ValueError('Default channel type must be TV or Radio.')
    if base_url and not _web_url(base_url):
        raise ValueError('Playlist base URL is invalid.')
    if re.search(r'^\s*#EXT-X-', text, re.MULTILINE | re.IGNORECASE):
        raise ValueError('This is an HLS playback manifest. Use Add link and choose Single channel for its public URL.')
    items, seen = [], set()
    attrs, title, group, headers = {}, '', '', {}
    skipped = duplicates = 0
    for raw in text.lstrip('\ufeff').splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.upper().startswith('#EXTINF:'):
            # Only a comma outside a quoted attribute starts the display name.
            quote = ''
            split_at = len(line)
            for index, char in enumerate(line):
                if char in {'"', "'"}:
                    if not quote:
                        quote = char
                    elif quote == char:
                        quote = ''
                elif char == ',' and not quote:
                    split_at = index
                    break
            attrs = {m[1].lower(): next((v for v in m.groups()[1:] if v is not None), '')
                     for m in _ATTR.finditer(line[:split_at])}
            title = _label(line[split_at + 1:])
            group = _label(attrs.get('group-title', ''))
            headers = {}
            continue
        if line.upper().startswith('#EXTGRP:'):
            group = _label(line.partition(':')[2])
            continue
        if line.lower().startswith('#extvlcopt:'):
            key, _, value = line.partition(':')[2].partition('=')
            mapped = {'http-referrer': 'referer', 'http-referer': 'referer', 'http-user-agent': 'userAgent'}.get(key.lower())
            if mapped and len(value) <= 1024 and not re.search(r'[\x00-\x1f\x7f]', value):
                if mapped != 'referer' or _web_url(value):
                    headers[mapped] = value
            continue
        if line.startswith('#'):
            continue
        url = _playlist_url(line, base_url)
        if not url:
            skipped += 1
        else:
            path = urlsplit(url).path.lower()
            audio = bool(re.search(r'\.(mp3|aac|ogg|oga|flac|wav|m4a)$', path))
            radio = attrs.get('radio', '').lower()
            media_type = ('radio' if radio in {'true', '1', 'yes'} else 'tv'
                          if radio in {'false', '0', 'no'} else 'radio' if audio else default_type)
            kind = ('hls' if path.endswith('.m3u8') else 'dash' if path.endswith('.mpd')
                    else 'audio' if media_type == 'radio' else 'video')
            identity = 'playlist:' + hashlib.sha256((media_type + '\n' + url).encode('utf-8')).hexdigest()
            if identity in seen:
                duplicates += 1
            else:
                seen.add(identity)
                items.append({
                    'id': identity, 'source': 'playlist', 'title': title or _label(attrs.get('tvg-name', '')) or f'Channel {len(items) + 1}',
                    'description': group, 'type': media_type, 'stream_url': url,
                    'stream_kind': kind, 'delivery': 'live', 'download_url': '',
                    'download_name': '', 'thumbnail': '', 'source_url': '',
                    'country': _label(attrs.get('tvg-country', ''), 16),
                    'language': _label(attrs.get('tvg-language', ''), 32),
                    'year': None, 'license': 'See provider terms', 'tags': [group] if group else [],
                    'content_rating': 'unrated', 'capture_headers': dict(headers),
                    '_extra': {'artworkUrl': _playlist_url(attrs.get('tvg-logo', ''), base_url)},
                })
        attrs, title, group, headers = {}, '', '', {}
    if not items:
        raise ValueError('No supported public HTTP(S) channels found. Local files, relative paths, private IPs and non-web streams are not supported.')
    return {'items': items, 'skipped': skipped, 'duplicates': duplicates}


class PlaylistStore:
    def __init__(self, path: Path, *, fetcher=None):
        self.path = path
        self._lock = threading.RLock()
        self._fetcher = fetcher
        self._import_slots = threading.BoundedSemaphore(2)

    def _read(self) -> list[dict]:
        if not self.path.exists():
            return []
        try:
            if self.path.stat().st_size > MAX_STORE_BYTES:
                raise ValueError('Playlist store is too large.')
            return self._entries(self.path.read_text(encoding='utf-8'))
        except (ValueError, UnicodeError) as error:
            raise ValueError('Saved playlists could not be read. Restore playlists.json from a backup; the existing file has not been changed.') from error

    @staticmethod
    def _entries(text: str) -> list[dict]:
        """Validate the store's JSON text and return its playlists (ValueError if invalid)."""
        data = json.loads(text)
        if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('playlists'), list):
            raise ValueError('Invalid playlist store.')
        for entry in data['playlists']:
            required = {'id', 'name', 'text', 'default_type'}
            if (not isinstance(entry, dict) or not required.issubset(entry)
                    or set(entry) - required - {'base_url'}):
                raise ValueError('Invalid saved playlist.')
            if any(not isinstance(value, str) for value in entry.values()):
                raise ValueError('Invalid saved playlist values.')
            parse_playlist(entry['text'], entry['default_type'], entry.get('base_url', ''))
        return data['playlists']

    @staticmethod
    def _public(entry: dict) -> dict:
        return {'id': entry['id'], 'name': entry['name'], **parse_playlist(entry['text'], entry['default_type'], entry.get('base_url', ''))}

    def list(self) -> list[dict]:
        with self._lock:
            return [self._public(entry) for entry in self._read()]

    def _save(self, entries: list[dict]) -> None:
        data = {'version': 1, 'playlists': entries}
        if len(json.dumps(data).encode('utf-8')) > MAX_STORE_BYTES:
            raise ValueError('Saved playlists exceed 64 MiB. Remove an unused playlist before importing another.')
        _atomic_write_json(self.path, data)

    def import_file(self, payload: dict) -> dict:
        if set(payload) != {'name', 'text', 'default_type'} or not isinstance(payload['name'], str):
            raise ValueError('Import requires a playlist name, text, and default channel type.')
        name = _label(payload['name'], 160)
        if not name:
            raise ValueError('Playlist name is required.')
        text = as_m3u(payload['text'])
        parsed = parse_playlist(text, payload['default_type'])
        identity = hashlib.sha256(name.lower().encode('utf-8')).hexdigest()
        entry = {'id': identity, 'name': name, 'text': text, 'default_type': payload['default_type']}
        return self._store(entry, parsed)

    def _store(self, entry: dict, parsed: dict) -> dict:
        with self._lock:
            entries = self._read()
            replaced = any(old['id'] == entry['id'] for old in entries)
            entries = [old for old in entries if old['id'] != entry['id']]
            entries.append(entry)
            self._save(entries)
        return {'playlist': {'id': entry['id'], 'name': entry['name'], **parsed}, 'replaced': replaced}

    def import_link(self, payload: dict) -> dict:
        if (set(payload) != {'url', 'name', 'default_type', 'kind'}
                or not all(isinstance(value, str) for value in payload.values())):
            raise ValueError('Add link requires a URL, optional name, TV/Radio choice, and link type.')
        url = _web_url(payload['url'].strip())
        if not url:
            raise ValueError('Paste a public HTTP or HTTPS stream/playlist URL, without embedded login credentials.')
        url = urlunsplit(urlsplit(url)._replace(fragment=''))
        kind = payload['kind']
        default_type = payload['default_type']
        if kind not in {'stream', 'playlist'} or default_type not in {'tv', 'radio'}:
            raise ValueError('Choose Single channel or Online playlist, and TV or Radio.')
        name = _label(payload['name'], 160) or _label(urlsplit(url).hostname or 'My channel', 160)
        base_url = ''
        if kind == 'stream':
            # Do not download a live stream just to save its address. A real
            # connection is validated by the media relay when the user plays it.
            if urlsplit(url).path.lower().endswith(('.m3u', '.pls', '.xspf')):
                raise ValueError('This looks like a channel list. Choose Online playlist instead.')
            radio = 'true' if default_type == 'radio' else 'false'
            text = f'#EXTM3U\n#EXTINF:-1 radio="{radio}",{name}\n{url}\n'
        else:
            if not self._import_slots.acquire(blocking=False):
                raise ValueError('Another playlist import is running. Please wait and try again.')
            try:
                fetcher = self._fetcher or BoundedFetcher(SafeConnector(
                    connect_timeout=8, header_timeout=8, idle_timeout=8,
                ))
                fetched = fetcher.fetch(url, accept='application/vnd.apple.mpegurl, audio/x-mpegurl, audio/x-scpls, application/xspf+xml, text/plain, */*;q=0.5',
                    allowed_types=('application/vnd.apple.mpegurl', 'application/x-mpegurl', 'application/mpegurl',
                                   'audio/x-mpegurl', 'audio/mpegurl', 'text/plain', 'text/x-mpegurl',
                                   'audio/x-scpls', 'audio/scpls',
                                   'application/xspf+xml', 'application/xml', 'text/xml',
                                   'application/octet-stream', 'binary/octet-stream'),
                    max_compressed=MAX_PLAYLIST_BYTES, max_decoded=MAX_PLAYLIST_BYTES)
                try:
                    text = fetched.data.decode('utf-8-sig')
                except UnicodeDecodeError:
                    text = fetched.data.decode('cp1252', errors='replace')
                not_a_list = ('That URL did not return an M3U, PLS or XSPF channel list. For a stream, choose Single channel; '
                              'website pages and login pages cannot be imported.')
                if is_xml(text):
                    try:
                        title, text = read_xspf(text)
                    except _NotXspf:
                        raise ValueError(not_a_list) from None
                    # With no name typed, the list's own title beats the host name.
                    name = _label(payload['name'], 160) or title or name
                else:
                    text = as_m3u(text)
                if not text.lstrip().upper().startswith('#EXTM3U'):
                    raise ValueError(not_a_list)
                base_url = fetched.url  # Relative entries follow the final redirect location.
            finally:
                self._import_slots.release()
        parsed = parse_playlist(text, default_type, base_url)
        identity = hashlib.sha256(('link\n' + url).encode('utf-8')).hexdigest()
        entry = {'id': identity, 'name': name, 'text': text, 'default_type': default_type}
        if base_url:
            entry['base_url'] = base_url
        return {**self._store(entry, parsed), 'kind': kind}

    def backup_snapshot(self, read_file) -> tuple[bytes | None, list[dict] | None]:
        """For a backup: the saved file's bytes and the playlists parsed from those same
        bytes, read once under the store lock so an import or removal cannot change it.

        ``read_file(path)`` returns the bytes, or None when there is no file. The
        playlists are None when the file cannot be read. Nothing is ever written."""
        with self._lock:
            raw = read_file(self.path)
            if raw is None:
                return None, []
            try:
                if len(raw) > MAX_STORE_BYTES:
                    raise ValueError('Playlist store is too large.')
                return raw, self._entries(raw.decode('utf-8'))
            except (ValueError, UnicodeError, RecursionError):
                return raw, None

    def remove(self, identity: str) -> None:
        if not isinstance(identity, str) or not re.fullmatch(r'[a-f0-9]{64}', identity):
            raise ValueError('Playlist ID is invalid.')
        with self._lock:
            entries = self._read()
            self._save([entry for entry in entries if entry['id'] != identity])
