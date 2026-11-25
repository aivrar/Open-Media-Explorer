"""Save a filtered Library collection in the app's downloads folder."""

import json
import os
import tempfile
from datetime import datetime
from pathlib import Path

from worldmedia_downloads import DownloadError, _validated_download_root
from worldmedia_playlist_tables import (
    MAX_TABLE_ENTRIES, TOO_LARGE, TOO_MANY, _export_text, clean_export_station, export_station_lines,
)
from worldmedia_playlists import MAX_PLAYLIST_BYTES
from worldmedia_security import ApiError, sanitize_filename
from worldmedia_songlog import _publish

EXPORT_BODY_LIMIT = 6 * MAX_PLAYLIST_BYTES + 8 * 1024
TYPE_LABELS = {'All', 'Radio', 'TV', 'Audio', 'Video'}


def _export_data(body):
    if not isinstance(body, dict) or set(body) != {'format', 'collection', 'type', 'stations'}:
        raise ValueError('Choose a collection and export format.')
    kind, collection, type_label, values = (body[key] for key in ('format', 'collection', 'type', 'stations'))
    if (kind not in ('m3u8', 'json') or not isinstance(type_label, str)
            or type_label not in TYPE_LABELS or not isinstance(values, list)):
        raise ValueError('Choose a collection and export format.')
    collection = _export_text(collection, 75)
    if not collection:
        raise ValueError('Choose a collection to export.')
    stations = [station for value in values if (station := clean_export_station(value))]
    if not stations:
        if not values:
            raise ValueError('No items match this view.')
        if len(values) == 1:
            raise ValueError('1 item was left out because it had no playable stream address.')
        raise ValueError(f'{len(values)} items were left out because they had no playable stream address.')
    if kind == 'json' and len(stations) > MAX_TABLE_ENTRIES:
        raise ValueError(TOO_MANY)
    lines = ['#EXTM3U']
    for station in stations:
        lines.extend(export_station_lines(station))
    data = ('\n'.join(lines) + '\n').encode('utf-8')
    if len(data) > MAX_PLAYLIST_BYTES:
        raise ValueError(TOO_LARGE)
    if kind == 'json':
        data = (json.dumps({'worldmedia': 1, 'name': collection, 'stations': stations},
                           ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
        if len(data) > MAX_PLAYLIST_BYTES:
            raise ValueError(TOO_LARGE)
    return data, kind, collection, type_label, len(stations), len(values) - len(stations)


def export_library_playlist(body, paths, *, now=None):
    try:
        data, kind, collection, type_label, count, skipped = _export_data(body)
    except ValueError as error:
        raise ApiError(400, 'INVALID_PLAYLIST_EXPORT', str(error)) from error

    date = (now or datetime.now()).date().isoformat()
    name = sanitize_filename(f'World Media - {collection} - {type_label} - {date}', kind)
    stem = name[:-len(kind) - 1]
    temporary = None
    try:
        root = _validated_download_root(paths)
        root.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=root, prefix='.playlist-', suffix='.partial', delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        for attempt in range(1, 101):
            suffix = '' if attempt == 1 else f' - {attempt}'
            final = root / f'{stem}{suffix}.{kind}'
            try:
                _publish(temporary, final)
            except FileExistsError:
                continue
            return {'name': final.name, 'count': count, 'skipped': skipped}
        raise ApiError(409, 'PLAYLIST_EXPORT_NAME_COLLISION', 'Too many copies of this export. Choose a different view.')
    except DownloadError as error:
        raise ApiError(409, 'UNSAFE_DOWNLOAD_ROOT', str(error)) from error
    except OSError as error:
        raise ApiError(500, 'PLAYLIST_EXPORT_FAILED', 'Could not save the playlist in Downloads.', retryable=True) from error
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
