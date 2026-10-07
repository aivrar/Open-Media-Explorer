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


def parse_playlist(text: str, default_type: str = 'tv', base_url: str = '') -> dict:
    if not isinstance(text, str) or not text.strip():
        raise ValueError('Choose a non-empty M3U or M3U8 channel playlist.')
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
            data = json.loads(self.path.read_text(encoding='utf-8'))
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
        except (ValueError, UnicodeError) as error:
            raise ValueError('Saved playlists could not be read. Restore playlists.json from a backup; the existing file has not been changed.') from error

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
        parsed = parse_playlist(payload['text'], payload['default_type'])
        identity = hashlib.sha256(name.lower().encode('utf-8')).hexdigest()
        entry = {'id': identity, 'name': name, 'text': payload['text'], 'default_type': payload['default_type']}
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
            if urlsplit(url).path.lower().endswith('.m3u'):
                raise ValueError('This looks like an M3U channel list. Choose Online playlist instead.')
            radio = 'true' if default_type == 'radio' else 'false'
            text = f'#EXTM3U\n#EXTINF:-1 radio="{radio}",{name}\n{url}\n'
        else:
            if not self._import_slots.acquire(blocking=False):
                raise ValueError('Another playlist import is running. Please wait and try again.')
            try:
                fetcher = self._fetcher or BoundedFetcher(SafeConnector(
                    connect_timeout=8, header_timeout=8, idle_timeout=8,
                ))
                fetched = fetcher.fetch(url, accept='application/vnd.apple.mpegurl, audio/x-mpegurl, text/plain, */*;q=0.5',
                    allowed_types=('application/vnd.apple.mpegurl', 'application/x-mpegurl', 'application/mpegurl',
                                   'audio/x-mpegurl', 'audio/mpegurl', 'text/plain', 'text/x-mpegurl',
                                   'application/octet-stream', 'binary/octet-stream'),
                    max_compressed=MAX_PLAYLIST_BYTES, max_decoded=MAX_PLAYLIST_BYTES)
                try:
                    text = fetched.data.decode('utf-8-sig')
                except UnicodeDecodeError:
                    text = fetched.data.decode('cp1252', errors='replace')
                if not text.lstrip().upper().startswith('#EXTM3U'):
                    raise ValueError('That URL did not return an M3U channel list. For a stream, choose Single channel; website pages and login pages cannot be imported.')
                base_url = fetched.url  # Relative entries follow the final redirect location.
            finally:
                self._import_slots.release()
        parsed = parse_playlist(text, default_type, base_url)
        identity = hashlib.sha256(('link\n' + url).encode('utf-8')).hexdigest()
        entry = {'id': identity, 'name': name, 'text': text, 'default_type': default_type}
        if base_url:
            entry['base_url'] = base_url
        return {**self._store(entry, parsed), 'kind': kind}

    def remove(self, identity: str) -> None:
        if not isinstance(identity, str) or not re.fullmatch(r'[a-f0-9]{64}', identity):
            raise ValueError('Playlist ID is invalid.')
        with self._lock:
            entries = self._read()
            self._save([entry for entry in entries if entry['id'] != identity])
