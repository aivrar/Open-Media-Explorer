import json
import tempfile
import unittest
from pathlib import Path

from worldmedia_runtime import (
    RuntimePaths, load_profile_transfer, profile_transfer_extra_path,
    profile_transfer_path, save_profile_transfer,
)


class PartResumeProfileTests(unittest.TestCase):
    def test_resume_is_saved_in_extra_preferences_and_removed_on_clear(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = RuntimePaths(
                portable_root=root, state_root=root / "data",
                downloads_root=root / "downloads", tools_root=root / "tools",
            )
            settings = "worldmedia.settings.v1"
            resume = "worldmedia.partresume.v1"
            bookmark = json.dumps([{
                "id": "librivox:4441", "partKey": "chapter.mp3", "position": 760,
            }])
            values = {settings: "{}", resume: bookmark}

            self.assertEqual(save_profile_transfer(values, paths), values)
            self.assertEqual(load_profile_transfer(paths), values)
            legacy = json.loads(profile_transfer_path(paths).read_text(encoding="utf-8"))
            extra = profile_transfer_extra_path(paths)
            self.assertEqual(legacy["values"], {settings: "{}"})
            self.assertEqual(json.loads(extra.read_text(encoding="utf-8"))["values"], {resume: bookmark})

            save_profile_transfer({}, paths)
            self.assertEqual(load_profile_transfer(paths), {})
            self.assertFalse(extra.exists())
