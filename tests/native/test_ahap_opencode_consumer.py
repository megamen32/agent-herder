import json
import os
from pathlib import Path
import tempfile
import unittest

from ahap_opencode_consumer import load_manifest, render_command


class AhapOpenCodeConsumerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "releases" / "fixture"
        self.root.mkdir(parents=True)
        self.paths = {}
        for name in ("core", "adapter", "opencode"):
            path = self.root / name
            path.write_text("fixture " + name)
            path.chmod(0o755)
            self.paths[name] = str(path)
        self.manifest = {
            "artifact_root": str(self.root),
            **self.paths,
            "launch": ["/usr/bin/python3", "{core}", "--adapter", "{adapter}",
                       "--opencode", "{opencode}", "--prompt", "AHAP fixture marker"],
        }
        self.manifest_path = Path(self.temp.name) / "handoff.json"
        self.write_manifest()

    def tearDown(self):
        self.temp.cleanup()

    def write_manifest(self):
        self.manifest_path.write_text(json.dumps(self.manifest))

    def test_artifact_manifest_binds_three_immutable_artifacts(self):
        manifest, artifacts, command = load_manifest(self.manifest_path)
        self.assertEqual(set(artifacts), {"core", "adapter", "opencode"})
        rendered = render_command(command, artifacts)
        self.assertEqual(rendered[1], self.paths["core"])
        self.assertEqual(rendered[3], self.paths["adapter"])
        self.assertEqual(rendered[5], self.paths["opencode"])
        self.assertEqual(manifest["artifact_root"], str(self.root))

    def test_rejects_missing_or_out_of_root_artifacts(self):
        del self.manifest["adapter"]
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "adapter"):
            load_manifest(self.manifest_path)
        self.manifest["adapter"] = self.paths["adapter"]
        outside = Path(self.temp.name) / "outside"
        outside.write_text("not mounted")
        self.manifest["adapter"] = str(outside)
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "inside artifact_root"):
            load_manifest(self.manifest_path)

    def test_rejects_launch_without_all_artifact_bindings(self):
        self.manifest["launch"] = ["/bin/true", "{core}"]
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "bind core, adapter, and OpenCode"):
            load_manifest(self.manifest_path)

    def test_model_endpoint_cannot_be_selected_by_manifest(self):
        self.manifest["launch"] += ["--model-url", "{model_url}"]
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "controlled exclusively"):
            load_manifest(self.manifest_path)

    def test_manifest_must_be_absolute_regular_file(self):
        with self.assertRaisesRegex(ValueError, "regular absolute"):
            load_manifest(Path("relative-handoff.json"))


if __name__ == "__main__":
    unittest.main()
