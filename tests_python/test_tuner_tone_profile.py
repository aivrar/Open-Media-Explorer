import json
import tempfile
import unittest
from pathlib import Path

from worldmedia_runtime import (
    RuntimePaths, load_profile_transfer, profile_transfer_extra_path,
    profile_transfer_path, save_profile_transfer,
)


class TunerToneProfileTests(unittest.TestCase):
    def test_toggles_are_saved_only_in_extra_preferences(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = RuntimePaths(root, root / "data", root / "downloads", root / "tools")
            legacy = {"worldmedia.settings.v1": '{"theme":"dark"}'}
            key = "worldmedia.settings-extra.v1"
            for shown in (True, False):
                with self.subTest(shown=shown):
                    extra = {key: json.dumps({"tunerToneKnobs": shown, "tunerStations": not shown})}
                    values = {**legacy, **extra}
                    self.assertEqual(save_profile_transfer(values, paths), values)
                    self.assertEqual(load_profile_transfer(paths), values)
                    main_file = profile_transfer_path(paths)
                    extra_file = profile_transfer_extra_path(paths)
                    self.assertEqual(json.loads(main_file.read_text(encoding="utf-8"))["values"], legacy)
                    self.assertEqual(json.loads(extra_file.read_text(encoding="utf-8"))["values"], extra)

            save_profile_transfer({}, paths)
            self.assertFalse(profile_transfer_extra_path(paths).exists())
