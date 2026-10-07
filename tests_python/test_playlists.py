from __future__ import annotations

import json
import unittest
import uuid
from types import SimpleNamespace
from pathlib import Path
from unittest import mock

from worldmedia_playlists import MAX_PLAYLIST_BYTES, PlaylistStore, parse_playlist
from worldmedia_catalog import BoundedFetcher
from worldmedia_media import SafeConnector
from worldmedia_security import ApiError
from worldmedia_runtime import PROFILE_TRANSFER_MAX_BYTES, load_profile_transfer

SIMPLE = '#EXTM3U\n#EXTINF:-1,Music\nhttps://example.org/live.m3u8\n'


class PlaylistTests(unittest.TestCase):
    def link_store(self, fetcher=None):
        store = PlaylistStore(Path('unused.json'), fetcher=fetcher)
        records = []
        store._read = lambda: records.copy()
        store._save = lambda entries: records.__setitem__(slice(None), entries)
        return store, records

    def test_direct_link_saves_without_fetching_and_preserves_stable_identity(self):
        fetcher = mock.Mock()
        store, records = self.link_store(fetcher)
        payload = {'url': 'https://example.org/live.m3u8?token=private', 'name': 'My TV', 'kind': 'stream', 'default_type': 'tv'}
        first = store.import_link(payload)
        item = first['playlist']['items'][0]
        self.assertEqual(item['title'], 'My TV')
        self.assertEqual(item['stream_kind'], 'hls')
        self.assertEqual(first['kind'], 'stream')
        payload['name'] = 'Renamed TV'
        second = store.import_link(payload)
        self.assertTrue(second['replaced'])
        self.assertEqual(item['id'], second['playlist']['items'][0]['id'])
        self.assertEqual(len(records), 1)
        fetcher.fetch.assert_not_called()

    def test_link_default_name_does_not_display_url_tokens(self):
        store, _ = self.link_store()
        saved = store.import_link({'url': 'https://radio.example.org/private-key?token=secret', 'name': '', 'kind': 'stream', 'default_type': 'radio'})
        self.assertEqual(saved['playlist']['name'], 'radio.example.org')
        self.assertEqual(saved['playlist']['items'][0]['type'], 'radio')
        self.assertNotIn('secret', saved['playlist']['id'])

    def test_remote_list_resolves_relative_streams_and_logos_against_final_url(self):
        fetcher = mock.Mock()
        fetcher.fetch.return_value = SimpleNamespace(data=b'#EXTM3U\n#EXTINF:-1 tvg-logo="../logo.png",Channel\nstreams/live.m3u8\n', url='https://cdn.example.org/lists/current.m3u')
        store, records = self.link_store(fetcher)
        saved = store.import_link({'url': 'https://example.org/playlist', 'name': 'My list', 'kind': 'playlist', 'default_type': 'tv'})
        item = saved['playlist']['items'][0]
        self.assertEqual(item['stream_url'], 'https://cdn.example.org/lists/streams/live.m3u8')
        self.assertEqual(item['_extra']['artworkUrl'], 'https://cdn.example.org/logo.png')
        self.assertEqual(store.list()[0]['items'][0]['stream_url'], item['stream_url'])
        self.assertEqual(records[0]['base_url'], 'https://cdn.example.org/lists/current.m3u')
        self.assertEqual(fetcher.fetch.call_args.kwargs['max_decoded'], MAX_PLAYLIST_BYTES)

    def test_bad_link_and_remote_failures_do_not_change_existing_lists(self):
        fetcher = mock.Mock()
        store, records = self.link_store(fetcher)
        store.import_file({'name': 'Keep.m3u', 'text': SIMPLE, 'default_type': 'tv'})
        prior = records.copy()
        for url in ['file:///c:/x', 'javascript:alert(1)', 'http://127.0.0.1/a', 'http://[::1]/a', 'https://name:pass@example.org/a', 'https://example.org/a\nb']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                store.import_link({'url': url, 'name': '', 'kind': 'playlist', 'default_type': 'tv'})
        fetcher.fetch.assert_not_called()
        payload = {'url': 'https://example.org/list', 'name': '', 'kind': 'playlist', 'default_type': 'tv'}
        fetcher.fetch.side_effect = TimeoutError('Timed out')
        with self.assertRaises(TimeoutError):
            store.import_link(payload)
        self.assertEqual(records, prior)
        fetcher.fetch.side_effect = None
        for body in [b'<html>Login</html>', b'#EXTM3U\n#EXT-X-TARGETDURATION:10\nhttps://example.org/segment.ts']:
            fetcher.fetch.return_value = SimpleNamespace(data=body, url=payload['url'])
            with self.assertRaises(ValueError):
                store.import_link(payload)
            self.assertEqual(records, prior)

    def test_online_fetch_rejects_hostname_resolving_to_private_address_before_connect(self):
        connector = SafeConnector(resolver=lambda _host, _port: [(2, 1, 6, '', ('127.0.0.1', 80))])
        store, records = self.link_store(BoundedFetcher(connector))
        with self.assertRaises(ApiError) as rejected:
            store.import_link({'url': 'https://example.org/channels.m3u', 'name': '', 'kind': 'playlist', 'default_type': 'tv'})
        self.assertEqual(rejected.exception.code, 'NON_GLOBAL_MEDIA_TARGET')
        self.assertEqual(records, [])

    def test_url_list_schema_reads_older_file_lists_and_rejects_bad_relative_targets(self):
        result = parse_playlist('#EXTM3U\n../ok.m3u8\n//127.0.0.1/private\nfile:///private\nhttps://example.org/a\tb\n', base_url='https://example.org/lists/test.m3u')
        self.assertEqual(result['items'][0]['stream_url'], 'https://example.org/ok.m3u8')
        self.assertEqual(result['skipped'], 3)

    def test_real_portable_store_survives_reload_and_removal(self):
        # Ordinary inherited workspace permissions: no private temp-directory
        # ACLs and no access to the user's portable test data.
        root = Path(__file__).resolve().parents[1] / 'build' / 'audit-tests' / uuid.uuid4().hex
        root.mkdir(parents=True)
        path = root / 'playlists.json'
        try:
            saved = PlaylistStore(path).import_file({'name': 'Music.m3u', 'text': SIMPLE, 'default_type': 'radio'})
            reloaded = PlaylistStore(path).list()
            self.assertEqual(reloaded[0]['items'][0]['type'], 'radio')
            self.assertEqual(reloaded[0]['items'][0]['id'], saved['playlist']['items'][0]['id'])
            PlaylistStore(path).remove(saved['playlist']['id'])
            self.assertEqual(PlaylistStore(path).list(), [])
            self.assertEqual(list(root.iterdir()), [path])  # No abandoned atomic-write files.
        finally:
            path.unlink(missing_ok=True)
            root.rmdir()

    def test_extended_mixed_playlist_and_capture_headers(self):
        result = parse_playlist('''\ufeff#EXTM3U
#EXTINF:-1 tvg-name="Fallback" tvg-logo="https://example.org/logo.png" group-title="News, local" tvg-country="US",News <script>
#EXTVLCOPT:http-referrer=https://example.org/
#EXTVLCOPT:http-user-agent=Example Player
https://example.org/tv.m3u8?key=secret
#EXTINF:-1 radio="true" group-title="Music",Radio
https://example.org/audio.m3u8
#EXTINF:-1,Plain audio
https://example.org/live.mp3
''')
        tv, radio, audio = result['items']
        self.assertEqual([tv['type'], radio['type'], audio['type']], ['tv', 'radio', 'radio'])
        self.assertEqual(tv['tags'], ['News, local'])
        self.assertEqual(tv['title'], 'News <script>')  # UI uses textContent, never HTML.
        self.assertEqual(tv['capture_headers'], {'referer': 'https://example.org/', 'userAgent': 'Example Player'})
        self.assertEqual(radio['capture_headers'], {})
        self.assertEqual(tv['_extra']['artworkUrl'], 'https://example.org/logo.png')
        self.assertEqual(tv['thumbnail'], '')  # Never render raw remote logos.
        self.assertNotIn('secret', tv['id'])
        self.assertEqual(tv['source_url'], '')

    def test_unsafe_entries_skipped_without_inheriting_metadata(self):
        result = parse_playlist(SIMPLE + '''#EXTINF:-1,Unsafe
file:///c:/private.mp3
javascript:alert(1)
http://127.0.0.1/private
http://[::1]/private
http://10.0.0.1/private
http://localhost/private
https://name:pass@example.org/private
../relative.ts
https://example.org/live|User-Agent=unsupported
https://example.org/other
''')
        self.assertEqual(result['skipped'], 9)
        self.assertEqual(len(result['items']), 2)
        self.assertEqual(result['items'][1]['title'], 'Channel 2')

    def test_hls_segment_and_master_manifests_are_not_channel_lists(self):
        for tag in ['#EXT-X-TARGETDURATION:10', '#EXT-X-STREAM-INF:BANDWIDTH=1234', '#EXT-X-ENDLIST']:
            with self.subTest(tag=tag), self.assertRaisesRegex(ValueError, 'playback manifest'):
                parse_playlist(SIMPLE + tag)

    def test_deduplication_and_stable_ids(self):
        first = parse_playlist(SIMPLE)['items'][0]
        duplicate = parse_playlist(SIMPLE + SIMPLE)
        self.assertEqual(duplicate['duplicates'], 1)
        changed = parse_playlist(SIMPLE.replace('Music', 'Renamed'))['items'][0]
        self.assertEqual(first['id'], changed['id'])
        self.assertNotEqual(first['id'], parse_playlist(SIMPLE, 'radio')['items'][0]['id'])

    def test_default_type_extgrp_and_unquoted_attributes(self):
        result = parse_playlist('#EXTM3U\n#EXTINF:-1 radio=false tvg-name=Name,\n#EXTGRP:Talk\nhttps://example.org/live.mpd', 'radio')
        item = result['items'][0]
        self.assertEqual(item['type'], 'tv')
        self.assertEqual(item['stream_kind'], 'dash')
        self.assertEqual(item['title'], 'Name')
        self.assertEqual(item['tags'], ['Talk'])

    def test_invalid_input_is_rejected_not_silently_truncated(self):
        for text, kind in [('', 'tv'), (None, 'tv'), ('#EXTM3U', 'tv'), (SIMPLE, []), (SIMPLE, 'video'), ('x' * (MAX_PLAYLIST_BYTES + 1), 'tv')]:
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                parse_playlist(text, kind)

    def test_store_replace_remove_and_failed_write(self):
        store = PlaylistStore(Path('unused-playlists.json'))
        records = []
        def save(_path, data):
            records[:] = data['playlists']
        with mock.patch.object(store, '_read', side_effect=lambda: records.copy()), mock.patch('worldmedia_playlists._atomic_write_json', side_effect=save) as writer:
            result = store.import_file({'name': 'Music.m3u', 'text': SIMPLE, 'default_type': 'tv'})
            self.assertFalse(result['replaced'])
            again = store.import_file({'name': 'music.m3u', 'text': SIMPLE.replace('Music', 'New name'), 'default_type': 'tv'})
            self.assertTrue(again['replaced'])
            self.assertEqual(len(records), 1)
            self.assertEqual(store.list()[0]['items'][0]['title'], 'New name')
            writer.side_effect = OSError('Disk full')
            with self.assertRaises(OSError):
                store.remove(again['playlist']['id'])
            self.assertEqual(len(records), 1)
            writer.side_effect = save
            store.remove(again['playlist']['id'])
            self.assertEqual(records, [])

    def test_corrupt_saved_store_cannot_be_overwritten(self):
        path = mock.Mock()
        path.exists.return_value = True
        path.stat.return_value.st_size = 50
        path.read_text.return_value = '{invalid'
        store = PlaylistStore(path)
        with mock.patch('worldmedia_playlists._atomic_write_json') as writer:
            with self.assertRaisesRegex(ValueError, 'has not been changed'):
                store.import_file({'name': 'test.m3u', 'text': SIMPLE, 'default_type': 'tv'})
            writer.assert_not_called()

    def test_escaped_profile_backup_is_not_rejected_as_oversized_on_load(self):
        values = {'worldmedia.favorites.v1': '\x00' * (PROFILE_TRANSFER_MAX_BYTES // 2)}
        raw = json.dumps({'version': 1, 'values': values})
        self.assertGreater(len(raw), PROFILE_TRANSFER_MAX_BYTES)
        path = mock.Mock()
        path.is_file.return_value = True
        path.stat.return_value.st_size = len(raw)
        path.read_text.return_value = raw
        with mock.patch('worldmedia_runtime.profile_transfer_path', return_value=path):
            self.assertEqual(load_profile_transfer(), values)


if __name__ == '__main__':
    unittest.main()
