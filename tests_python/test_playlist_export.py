import json
import tempfile
import unittest
from dataclasses import replace
from datetime import datetime
from pathlib import Path

from worldmedia_playlist_export import export_library_playlist
from worldmedia_playlists import BACKUP_STREAM_TAG, PlaylistStore
from worldmedia_runtime import get_runtime_paths, runtime_status
from worldmedia_security import ApiError

NOW = datetime(2026, 11, 25)


class PlaylistExportTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.paths = get_runtime_paths(portable=root, state=root)
        self.store = PlaylistStore(root / 'playlists.json')
        self.channels = [
            {'name': 'TV: Caf\u00e9, "live"', 'type': 'tv', 'group': 'News "Today" & Today\'s',
             'url': 'https://tv.example.org/edited', 'kind': 'hls', 'delivery': 'live',
             'logo': 'https://img.example.org/tv.png?x=1&y=2',
             'backups': ['https://tv.example.org/a.m3u8', 'https://tv.example.org/b.m3u8'],
             'country': 'MX', 'language': 'es', 'headers': {'referer': 'https://tv.example.org/watch'}},
            {'name': 'Radio', 'type': 'radio', 'group': 'Music', 'url': 'https://radio.example.org/live'},
            {'name': 'Audio', 'type': 'audio', 'group': 'Podcasts', 'delivery': 'on-demand',
             'url': 'https://media.example.org/audio.mp3'},
            {'name': 'Video', 'type': 'video', 'group': 'Shows', 'delivery': 'on-demand', 'content_rating': 'explicit',
             'url': 'https://media.example.org/video.mp4'},
        ]
        self.body = {'collection': 'Favorites', 'type': 'All', 'stations': self.channels}

    def test_both_saved_formats_round_trip_through_playlist_import(self):
        imported = {}
        for kind in ('m3u8', 'json'):
            with self.subTest(kind=kind):
                answer = export_library_playlist({**self.body, 'format': kind}, self.paths, now=NOW)
                self.assertEqual(answer, {'name': f'World Media - Favorites - All - 2026-11-25.{kind}',
                                          'count': 4, 'skipped': 0})
                content = (self.paths.downloads_root / answer['name']).read_bytes().decode('utf-8')
                if kind == 'm3u8':
                    self.assertTrue(content.startswith('#EXTM3U\n'))
                    self.assertIn('tvg-name=', content)
                    self.assertIn('group-title=', content)
                    self.assertIn(f"{BACKUP_STREAM_TAG}{self.channels[0]['backups'][0]}\n", content)
                else:
                    self.assertEqual(json.loads(content)['stations'][0]['backups'], self.channels[0]['backups'])
                result = self.store.import_file({'name': answer['name'], 'text': content, 'default_type': 'auto'})
                imported[kind] = result['playlist']['items']
                for station, item in zip(self.channels, imported[kind], strict=True):
                    self.assertEqual((item['title'], item['type'], item['stream_url'], item['description']),
                                     (station['name'], station['type'], station['url'], station['group']))
                    self.assertEqual(item['delivery'], station.get('delivery', 'live'))
                    self.assertEqual(item['content_rating'], station.get('content_rating', 'unrated'))
                    self.assertEqual(item['capture_headers'], station.get('headers', {}))
                    self.assertEqual(item['_extra']['artworkUrl'], station.get('logo', ''))
                    self.assertEqual(item['_extra'].get('backupStreamUrls', []), station.get('backups', []))
                self.assertEqual(imported[kind][0]['stream_kind'], 'hls')
        self.assertEqual(imported['m3u8'], imported['json'])

    def test_repeated_exports_keep_both_files_and_duplicate_displayed_items(self):
        station = self.channels[0]
        second = {**station, 'group': 'Another category', 'backups': []}
        body = {**self.body, 'format': 'm3u8', 'type': 'TV', 'stations': [station, second]}
        first_answer = export_library_playlist(body, self.paths, now=NOW)
        other_answer = export_library_playlist(body, self.paths, now=NOW)
        self.assertEqual(first_answer['name'], 'World Media - Favorites - TV - 2026-11-25.m3u8')
        self.assertEqual(other_answer['name'], 'World Media - Favorites - TV - 2026-11-25 - 2.m3u8')
        files = sorted(self.paths.downloads_root.iterdir())
        self.assertEqual(len(files), 2)
        self.assertEqual(files[0].read_bytes(), files[1].read_bytes())
        playlist = self.store.import_file({'name': first_answer['name'], 'text': files[0].read_text(encoding='utf-8'),
                                           'default_type': 'auto'})['playlist']
        self.assertEqual([item['description'] for item in playlist['items']], [station['group'], second['group']])
        self.assertEqual(playlist['duplicates'], 0)

    def test_unimportable_addresses_are_reported_and_empty_export_creates_no_file(self):
        invalid = {**self.channels[0], 'url': 'http://localhost/stream', 'backups': []}
        body = {**self.body, 'format': 'json', 'stations': [invalid]}
        with self.assertRaisesRegex(ApiError, '1 item was left out because it had no playable stream address'):
            export_library_playlist(body, self.paths, now=NOW)
        self.assertFalse(self.paths.downloads_root.exists())
        answer = export_library_playlist({**body, 'stations': [invalid, self.channels[1]]}, self.paths, now=NOW)
        self.assertEqual((answer['count'], answer['skipped']), (1, 1))

    def test_dangling_downloads_link_cannot_create_its_target(self):
        paths = get_runtime_paths(portable=self.paths.portable_root / 'portable', state=self.paths.state_root)
        paths.portable_root.mkdir()
        target = self.paths.portable_root / 'outside'
        try:
            paths.downloads_root.symlink_to(target, target_is_directory=True)
        except (NotImplementedError, OSError) as error:
            self.skipTest(f'Directory symlinks are unavailable: {error}')
        self.assertFalse(paths.downloads_root.exists())
        self.assertTrue(paths.downloads_root.is_symlink())

        with self.assertRaises(ApiError) as caught:
            export_library_playlist({**self.body, 'format': 'json'}, paths, now=NOW)
        self.assertEqual(caught.exception.code, 'UNSAFE_DOWNLOAD_ROOT')
        self.assertFalse(runtime_status(paths)['portable_writable'])
        self.assertFalse(target.exists())

    def test_resolved_downloads_path_must_stay_inside_portable_root(self):
        paths = get_runtime_paths(portable=self.paths.portable_root / 'portable', state=self.paths.state_root)
        target = self.paths.portable_root / 'outside'
        paths = replace(paths, downloads_root=paths.portable_root / '..' / target.name)
        with self.assertRaisesRegex(ApiError, 'outside the portable root'):
            export_library_playlist({**self.body, 'format': 'json'}, paths, now=NOW)
        self.assertFalse(target.exists())
        self.assertFalse(paths.portable_root.exists())

    def test_dangling_downloads_junction_is_refused(self):
        try:
            from _winapi import CreateJunction
        except ImportError:
            self.skipTest('Junctions are a Windows feature.')
        paths = get_runtime_paths(portable=self.paths.portable_root / 'portable', state=self.paths.state_root)
        paths.portable_root.mkdir()
        target = self.paths.portable_root / 'outside'
        target.mkdir()
        CreateJunction(str(target), str(paths.downloads_root))
        target.rmdir()
        with self.assertRaises(ApiError) as caught:
            export_library_playlist({**self.body, 'format': 'json'}, paths, now=NOW)
        self.assertEqual(caught.exception.code, 'UNSAFE_DOWNLOAD_ROOT')
        self.assertFalse(target.exists())
