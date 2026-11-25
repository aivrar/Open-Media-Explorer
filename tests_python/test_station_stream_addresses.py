import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from worldmedia_backup import create_backup
from worldmedia_playlists import PlaylistStore, validate_stream_addresses
from worldmedia_runtime import (
    RuntimePaths, load_profile_transfer, profile_transfer_extra_path, profile_transfer_path, save_profile_transfer,
)


class StationStreamAddressTests(unittest.TestCase):
    def test_address_validation_shares_the_import_rules(self):
        validate_stream_addresses({'urls': ['https://station.example/live', 'http://backup.example/live']})
        for invalid in ('http://localhost/live', 'http://192.168.0.1/live', 'http://[::1]/live',
                        'https://host.example:0/live', 'https://user:pwd@host.example/live',
                        'https://host.example/s p', 'https://host.example/a|b', 'ftp://host.example/live'):
            with self.subTest(address=invalid), self.assertRaisesRegex(ValueError, 'public HTTP or HTTPS'):
                validate_stream_addresses({'urls': [invalid]})
        with self.assertRaisesRegex(ValueError, 'up to five'):
            validate_stream_addresses({'urls': ['https://station.example/live'] * 7})

    def test_addresses_live_in_the_extra_profile_and_its_backup(self):
        key = 'worldmedia.stationstreams.v1'
        raw = '{"version":1,"stations":{"playlist:a":{"main":"https://station.example/live"}}}'
        settings = {'worldmedia.settings.v1': '{}'}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            paths = RuntimePaths(portable_root=root, state_root=root / 'WorldMediaWindows-data',
                                 downloads_root=root / 'downloads', tools_root=root / 'tools')
            store = PlaylistStore(paths.state_root / 'state' / 'playlists.json')
            values = {**settings, key: raw}
            self.assertEqual(save_profile_transfer(values, paths), values)
            self.assertEqual(json.loads(profile_transfer_path(paths).read_text())['values'], settings)
            extra = profile_transfer_extra_path(paths)
            self.assertEqual(json.loads(extra.read_text())['values'], {key: raw})
            self.assertEqual(load_profile_transfer(paths), values)

            result = create_backup(paths, store)
            with zipfile.ZipFile(result['path']) as archive:
                saved = json.loads(archive.read(f'WorldMediaWindows-data/state/{extra.name}'))
                self.assertEqual(saved['values'], {key: raw})

            save_profile_transfer({}, paths)
            self.assertEqual(load_profile_transfer(paths), {})
            self.assertFalse(extra.exists())
