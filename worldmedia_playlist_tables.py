"""JSON and CSV channel lists, turned into M3U before they are stored.

Like PLS and XSPF, only the equivalent M3U text is ever saved, so older
releases can still read playlists.json and every entry still goes through
parse_playlist's URL checks, limits and "Add as: Auto" rules (a station's
type becomes a radio="true"/"false" mark, which Auto counts).

JSON: a list of stations, or an object holding one under "stations",
"channels", "items", "entries", "playlist", "tracks" or "streams" (an
object's own "name" or "title" names the list). A station is an object with
at least a stream address, or just the address as a string. A Radio Browser
export works as it is. A station object can include a "backups" list of
alternate stream addresses in the order to try them.

CSV: a header row naming the columns (comma, semicolon or tab separated);
a list without one is read when a cell of the first row is a web address.

The field names, in the order they are tried (case does not matter):
  address  url_resolved, stream_url, streamurl, url, stream, link, file,
           location, src, href
  name     name, title, station, station name, channel, channel name, tvg-name
  picture  logo, logo url, favicon, image, image url, icon, thumbnail, artwork,
           tvg-logo
(spaces in a name count as underscores: "Stream URL" is stream_url)
  group    group, group-title, category, genre, tags (the first tag)
  type     type, media_type, kind ("radio"/"audio" or "tv"/"video"), or
           radio (true/false)
  country  countrycode, tvg-country, country
  language language, tvg-language

Nothing here fetches anything: online lists come through the same bounded
fetcher as every other playlist link.
"""
from __future__ import annotations

import csv
import io
import json
import re
from dataclasses import dataclass

from worldmedia_playlists import (
    BACKUP_STREAM_TAG, MAX_BACKUP_STREAMS, MAX_PLAYLIST_BYTES, PLAYLIST_TYPES, TRUE_MARKS, FALSE_MARKS,
    _LINE_BREAK, _URL_SCHEME, _label, _playlist_url, _web_url, _xspf_link, _xspf_name, is_pls,
)

MAX_TABLE_ENTRIES = 50_000
TOO_LARGE = 'Playlist file exceeds the 8 MiB import limit; split it into smaller files.'
TOO_MANY = f'This playlist has more than {MAX_TABLE_ENTRIES:,} entries; split it into smaller files.'

_FIELDS = {
    'url': ('url_resolved', 'stream_url', 'streamurl', 'url', 'stream', 'link', 'file', 'location', 'src', 'href'),
    'name': ('name', 'title', 'station', 'station_name', 'channel', 'channel_name', 'tvg-name', 'tvg_name'),
    'logo': ('logo', 'logo_url', 'favicon', 'image', 'image_url', 'icon', 'thumbnail', 'artwork', 'tvg-logo',
             'tvg_logo'),
    'group': ('group', 'group-title', 'group_title', 'category', 'genre', 'tags'),
    'type': ('type', 'media_type', 'kind'),
    'radio': ('radio',),
    'country': ('countrycode', 'country_code', 'tvg-country', 'tvg_country', 'country'),
    'language': ('language', 'tvg-language', 'tvg_language'),
}
_LIST_KEYS = ('stations', 'channels', 'items', 'entries', 'playlist', 'tracks', 'streams')
_RADIO_WORDS = frozenset({'radio', 'audio'})
_TV_WORDS = frozenset({'tv', 'video'})
_JSON_START = re.compile('\uFEFF?\\s*[\\[{]')


@dataclass(frozen=True)
class TablePlaylist:
    """A JSON or CSV list as M3U: its own title (JSON only), the M3U text, and
    how many entries had no stream address at all (added to "skipped")."""

    title: str
    text: str
    dropped: int


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ''


def _attribute(value: str, limit: int = 512) -> str:
    """A value that can sit inside a quoted #EXTINF attribute."""
    return _label(_xspf_name(value).replace('"', "'"), limit)


def _pick_key(fields: dict[str, object], kind: str) -> tuple[str, object]:
    """The first field of this kind that has a value, and its name."""
    for key in _FIELDS[kind]:
        value = fields.get(key)
        if value is not None and value != '':
            return key, value
    return '', None


def _pick(fields: dict[str, object], kind: str) -> object:
    return _pick_key(fields, kind)[1]


def _field_name(value: str) -> str:
    """A JSON key or CSV column name as matched: "Stream URL" is stream_url."""
    return re.sub(r'\s+', '_', value.strip().lower())


def _address(fields: dict[str, object]) -> str:
    """The first public web address among the address fields; else the first
    relative or other one, so parse_playlist counts the entry as skipped."""
    fallback = ''
    for key in _FIELDS['url']:
        value = _xspf_link(_text(fields.get(key)))
        if not value:
            continue
        if _web_url(value):
            return value
        fallback = fallback or value
    return fallback


def _radio_mark(fields: dict[str, object]) -> str:
    radio = fields.get('radio')
    if isinstance(radio, bool):
        return 'true' if radio else 'false'
    mark = _text(radio).lower()
    if mark in TRUE_MARKS:
        return 'true'
    if mark in FALSE_MARKS:
        return 'false'
    kind = _text(_pick(fields, 'type')).lower()
    if kind in _RADIO_WORDS:
        return 'true'
    if kind in _TV_WORDS:
        return 'false'
    return ''


def _entry_lines(fields: dict[str, object], base_url: str = '') -> list[str]:
    """The M3U lines of one station, or [] when it has no address."""
    url = _address(fields)
    if not url:
        return []
    attributes = ''
    mark = _radio_mark(fields)
    if mark:
        attributes += f' radio="{mark}"'
    logo = _xspf_link(_text(_pick(fields, 'logo')))
    if logo and '"' not in logo and (_web_url(logo) or not _URL_SCHEME.match(logo)):
        attributes += f' tvg-logo="{logo}"'
    group_key, group_value = _pick_key(fields, 'group')
    if isinstance(group_value, list):
        group_value = next((tag for tag in group_value if _text(tag)), '')
    elif group_key == 'tags':
        group_value = _text(group_value).split(',')[0]
    group = _attribute(_text(group_value), 160)
    if group:
        attributes += f' group-title="{group}"'
    country = _attribute(_text(_pick(fields, 'country')), 16)
    if country:
        attributes += f' tvg-country="{country}"'
    language = _attribute(_text(_pick(fields, 'language')), 32)
    if language:
        attributes += f' tvg-language="{language}"'
    name = _xspf_name(_text(_pick(fields, 'name')))
    backups = fields.get('backups')
    backup_lines = []
    if isinstance(backups, list):
        seen = {_playlist_url(url, base_url)}
        for value in backups:
            backup = _playlist_url(_xspf_link(_text(value)), base_url)
            if backup and backup not in seen:
                seen.add(backup)
                backup_lines.append(f'{BACKUP_STREAM_TAG}{backup}')
                if len(backup_lines) >= MAX_BACKUP_STREAMS:
                    break
    return [f'#EXTINF:-1{attributes},{name}', *backup_lines, url]


def _export_text(value, limit=512):
    return _label(_LINE_BREAK.sub(' ', value), limit) if isinstance(value, str) else ''


def _export_url(value):
    return _web_url(value.strip()) if isinstance(value, str) and not _LINE_BREAK.search(value) else ''


def clean_export_station(value: object) -> dict | None:
    """The portable fields of a Library item, subject to the playlist import rules."""
    if not isinstance(value, dict) or not isinstance(value.get('type'), str):
        return None
    media_type = value['type']
    if media_type not in PLAYLIST_TYPES:
        return None
    raw_backups = value.get('backups')
    backups = list(dict.fromkeys(filter(None, map(_export_url, raw_backups)))) if isinstance(raw_backups, list) else []
    url = _export_url(value.get('url'))
    kind = _export_text(value.get('kind'))
    headers = value.get('headers')
    if not url and backups:
        url, *backups = backups
        kind, headers = '', None
    if not url:
        return None
    clean_headers = {}
    if isinstance(headers, dict):
        for key in ('referer', 'userAgent'):
            header = headers.get(key)
            if isinstance(header, str) and _export_text(header, 1024) == header:
                if key != 'referer' or _export_url(header):
                    clean_headers[key] = header
    return {
        'url': url,
        'name': _export_text(value.get('name')) or 'Untitled',
        'type': media_type,
        'kind': kind,
        'delivery': _export_text(value.get('delivery')),
        'content_rating': _export_text(value.get('content_rating')),
        'group': _export_text(value.get('group')),
        'logo': _export_url(value.get('logo')) or _export_url(value.get('thumbnail')),
        'country': _export_text(value.get('country'), 16),
        'language': _export_text(value.get('language'), 32),
        'headers': clean_headers,
        'backups': [backup for backup in backups if backup != url][:MAX_BACKUP_STREAMS],
    }


def _export_attribute(key, value):
    if not value:
        return ''
    if '"' not in value:
        return f' {key}="{value}"'
    if "'" not in value:
        return f" {key}='{value}'"
    return ' ' + key + '="' + value.replace('"', '&quot;') + '"'


def export_station_lines(station: dict) -> list[str]:
    """The M3U entry shared by both Library export formats."""
    media_type = station['type']
    attrs = _export_attribute('radio', 'true' if media_type in {'radio', 'audio'} else 'false')
    attrs += _export_attribute('worldmedia-type', media_type)
    if station['kind'] in {'audio', 'video', 'hls', 'dash'}:
        attrs += _export_attribute('worldmedia-kind', station['kind'])
    if station['delivery'] in {'live', 'on-demand', 'unknown'}:
        attrs += _export_attribute('worldmedia-delivery', station['delivery'])
    if station['content_rating'] in {'explicit', 'not-explicit'}:
        attrs += _export_attribute('worldmedia-rating', station['content_rating'])
    for key, field in (('tvg-name', 'name'), ('tvg-logo', 'logo'), ('group-title', 'group'),
                       ('tvg-country', 'country'), ('tvg-language', 'language')):
        attrs += _export_attribute(key, station[field])
    lines = [f"#EXTINF:-1{attrs},{station['name']}"]
    if '"' in station['group'] and "'" in station['group']:
        lines.append(f"#EXTGRP:{station['group']}")
    if referer := station['headers'].get('referer'):
        lines.append(f'#EXTVLCOPT:http-referrer={referer}')
    if agent := station['headers'].get('userAgent'):
        lines.append(f'#EXTVLCOPT:http-user-agent={agent}')
    lines.extend(f'{BACKUP_STREAM_TAG}{backup}' for backup in station['backups'])
    lines.append(station['url'])
    return lines


def _lower_keys(value: dict) -> dict[str, object]:
    fields: dict[str, object] = {}
    for key, item in value.items():
        if isinstance(key, str):
            fields.setdefault(_field_name(key), item)
    return fields


def _check_size(text: str) -> None:
    if len(text.encode('utf-8')) > MAX_PLAYLIST_BYTES:
        raise ValueError(TOO_LARGE)


def looks_like_json(text: str) -> bool:
    """True when the text starts with '[' or '{' (after an optional BOM) and is
    not a PLS file, whose first line is [playlist]."""
    return isinstance(text, str) and bool(_JSON_START.match(text)) and not is_pls(text)


def read_json_playlist(text: str, *, base_url: str = '') -> TablePlaylist:
    _check_size(text)
    if not text.strip('\ufeff \t\r\n'):
        raise ValueError('This JSON playlist is empty.')
    try:
        value = json.loads(text.lstrip('\uFEFF'))
    except json.JSONDecodeError as error:
        # The parser's own wording ("Expecting value") means little to most
        # people; where the problem is does.
        raise ValueError(f'This JSON playlist could not be read. The file is not valid JSON '
                         f'(line {error.lineno}, column {error.colno}).') from None
    except (ValueError, RecursionError):
        raise ValueError('This JSON playlist could not be read. The file is not valid JSON, '
                         'or its lists are nested too deeply.') from None
    title = ''
    worldmedia = isinstance(value, dict) and value.get('worldmedia') == 1
    entries = value
    if isinstance(value, dict):
        fields = _lower_keys(value)
        title = _label(_xspf_name(_text(fields.get('name')) or _text(fields.get('title'))), 160)
        entries = next((fields[key] for key in _LIST_KEYS if isinstance(fields.get(key), list)), None)
        if entries is None:
            # One station on its own.
            entries = [value] if _address(fields) else None
    if not isinstance(entries, list):
        raise ValueError('This JSON file has no list of stations. Use a list of entries that each have a "url", '
                         'or an object with a "stations" or "channels" list.')
    if len(entries) > MAX_TABLE_ENTRIES:
        raise ValueError(TOO_MANY)
    lines, dropped = ['#EXTM3U'], 0
    for entry in entries:
        if isinstance(entry, str):
            entry = {'url': entry}
        if worldmedia:
            station = clean_export_station(entry)
            found = export_station_lines(station) if station else []
        else:
            found = _entry_lines(_lower_keys(entry), base_url) if isinstance(entry, dict) else []
        if found:
            lines += found
        else:
            dropped += 1
    if len(lines) == 1:
        raise ValueError('No entry in this JSON playlist has a stream address. Each entry needs a "url" '
                         '(or "stream_url") field.')
    return TablePlaylist(title, '\n'.join(lines) + '\n', dropped)


_DELIMITER_SAMPLE_RECORDS = 5


def _choose_delimiter(body: str) -> str:
    """Comma, semicolon or tab: the one that splits the first records (read
    as CSV, so separators inside quotes do not count and a quoted field may
    span lines) into the same number of columns most often, then into the
    most columns. Comma when none splits the first record."""
    best, best_score = ',', (0, 0)
    for delimiter in (',', ';', '\t'):
        widths: list[int] = []
        try:
            for row in csv.reader(io.StringIO(body, newline=''), delimiter=delimiter):
                if not any(cell.strip() for cell in row):
                    continue
                widths.append(len(row))
                if len(widths) >= _DELIMITER_SAMPLE_RECORDS:
                    break
        except csv.Error:
            continue
        if not widths or widths[0] < 2:
            continue
        score = (sum(1 for width in widths if width == widths[0]), widths[0])
        if score > best_score:
            best, best_score = delimiter, score
    return best


def _csv_rows(text: str) -> tuple[list[list[str]], str]:
    """The rows of a CSV text that are not blank, and the separator used
    (see _choose_delimiter)."""
    body = text.lstrip('\uFEFF')
    delimiter = _choose_delimiter(body)
    rows: list[list[str]] = []
    reader = csv.reader(io.StringIO(body, newline=''), delimiter=delimiter, strict=True)
    start = 1  # the line the record being read starts on
    try:
        while True:
            start = reader.line_num + 1
            try:
                row = next(reader)
            except StopIteration:
                break
            if not any(cell.strip() for cell in row):
                continue
            rows.append(row)
            if len(rows) > MAX_TABLE_ENTRIES + 1:
                raise ValueError(TOO_MANY)
    except csv.Error as error:
        problem = _csv_problem(str(error), reader.line_num, start)
        raise ValueError(f'This CSV playlist could not be read. {problem}') from None
    return rows, delimiter


def _csv_problem(detail: str, line: int, start: int | None = None) -> str:
    """The CSV reader's error in plain words, with the line it was on. A
    quotation mark that is never closed is only found at the end of the file:
    then the line its row starts on (`start`) is named instead."""
    if 'field larger than field limit' in detail:
        return f'Line {line} has a value that is too long.'
    if ('end of data' in detail or 'EOF' in detail) and start is not None:
        return (f'Near line {start}, a value in quotation marks is never closed. A value in quotation marks must '
                f'end with one right before the separator, and a quotation mark inside it is written twice.')
    if 'expected after' in detail or 'end of data' in detail or 'EOF' in detail or 'new-line' in detail:
        return (f'Line {line} has a quotation mark out of place. A value in quotation marks must end '
                f'with one right before the separator, and a quotation mark inside it is written twice.')
    return f'Line {line} is not in a form a CSV file can have.'


def _header_columns(row: list[str]) -> dict[str, int] | None:
    names = [_field_name(cell) for cell in row]
    if any(_web_url(name) for name in names):
        return None
    known = {key for keys in _FIELDS.values() for key in keys}
    if not any(name in _FIELDS['url'] for name in names):
        return None if not any(name in known for name in names) else {}
    return {name: index for index, name in reversed(list(enumerate(names))) if name in known}


def looks_like_csv(text: str) -> bool:
    """True when the first line that is not blank is a CSV header naming a
    stream address column (only used for online lists; files go by name)."""
    if not isinstance(text, str):
        return False
    first = next((line for line in text.lstrip('\uFEFF').splitlines() if line.strip()), '')
    if not first or first.lstrip().startswith(('#', '[', '{', '<')) or not re.search('[,;\t]', first):
        return False
    try:
        rows, _ = _csv_rows(first)
    except ValueError:
        return False
    return bool(rows) and bool(_header_columns(rows[0]))


def read_csv_playlist(text: str) -> TablePlaylist:
    _check_size(text)
    rows, _ = _csv_rows(text)
    if not rows:
        raise ValueError('This CSV playlist is empty.')
    columns = _header_columns(rows[0])
    if columns == {}:
        raise ValueError('This CSV playlist has no column for the stream address. Name one column "url" '
                         '(name, logo, group and type columns are used too).')
    if columns is None:
        # No header: the first web address in the first row is the address
        # column, and the first other column the name.
        at = next((index for index, cell in enumerate(rows[0]) if _web_url(cell.strip())), None)
        if at is None:
            raise ValueError('This CSV playlist has no header row and no stream addresses. Start it with a header row '
                             'such as: name,url')
        name_at = next((index for index in range(len(rows[0])) if index != at), None)
        columns = {'url': at, **({'name': name_at} if name_at is not None else {})}
    else:
        rows = rows[1:]
    lines, dropped = ['#EXTM3U'], 0
    for row in rows:
        fields = {key: row[index] for key, index in columns.items() if index < len(row)}
        found = _entry_lines(fields)
        if found:
            lines += found
        else:
            dropped += 1
    if len(lines) == 1:
        raise ValueError('No row in this CSV playlist has a stream address.')
    return TablePlaylist('', '\n'.join(lines) + '\n', dropped)


def read_table_playlist(text: object, file_name: str = '', *, base_url: str = '') -> TablePlaylist | None:
    """A JSON or CSV list as M3U, or None for any other playlist text.

    A file named .json or .csv is always read as that format (and refused with
    a clear message when it is not); without such a name the text decides."""
    if not isinstance(text, str):
        return None
    suffix = file_name.lower().rpartition('.')[2] if '.' in file_name else ''
    if suffix == 'json':
        return read_json_playlist(text, base_url=base_url)
    if suffix == 'csv':
        return read_csv_playlist(text)
    if looks_like_json(text):
        return read_json_playlist(text, base_url=base_url)
    if looks_like_csv(text):
        return read_csv_playlist(text)
    return None
