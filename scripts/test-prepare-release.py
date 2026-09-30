import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("prepare_release", Path(__file__).with_name("prepare-release.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReleaseTests(unittest.TestCase):
    def test_first_version(self):
        self.assertEqual(module.select_release(releases=[], commit="abc", minimum="0.1.1"), ("v0.1.1", None))

    def test_patch_increments_include_failed_drafts(self):
        releases = [{"tag_name": "v0.1.9"}, {"tag_name": "v0.2.1", "draft": True}, {"tag_name": "unrelated"}]
        self.assertEqual(module.select_release(releases=releases, commit="abc", minimum="0.1.1"), ("v0.2.2", None))

    def test_retry_reuses_source_release(self):
        release = {"tag_name": "v0.1.1", "body": "Source commit: abc", "draft": True}
        self.assertEqual(module.select_release(releases=[release], commit="abc", minimum="0.1.1"), ("v0.1.1", release))

    def test_version_only_changes_package_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "src-tauri").mkdir()
            for name in ["package.json", "src-tauri/tauri.conf.json"]:
                (root / name).write_text(json.dumps({"version": "0.1.0"}))
            (root / "src-tauri/Cargo.toml").write_text('[package]\nversion = "0.1.0"\n[dependencies]\nserde = { version = "=1.0.229" }\n')
            module.write_version(root=root, version="0.1.1")
            self.assertEqual(json.loads((root / "package.json").read_text())["version"], "0.1.1")
            self.assertIn('serde = { version = "=1.0.229" }', (root / "src-tauri/Cargo.toml").read_text())


if __name__ == "__main__":
    unittest.main()
