"""Assemble the verified canonical build without making another checkout."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(root / "deploy/fleet"))
spec = importlib.util.spec_from_file_location("builder", root / "deploy/fleet/build-release-candidate.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
catalog = root.parent / ".notice-herder-release-20261027"
before = (catalog / "node-config.json").read_bytes() if (catalog / "node-config.json").exists() else None
release = builder.assemble(sha, root, catalog)
builder.release_packages_tree(release, root / "node_modules")
builder.write_bundle_manifest(sha, release, catalog, root)
checks, manifest, _, bundle = builder.checks(sha, release, catalog, before)
for name, passed, detail in checks:
    print(name, "PASS" if passed else "FAIL", detail)
if not all(passed for _, passed, _ in checks):
    raise SystemExit("Release checks failed; do not activate")
print(json.dumps({"release": str(release), "sha": sha, "bundle": bundle["bundleFingerprint"]}))
