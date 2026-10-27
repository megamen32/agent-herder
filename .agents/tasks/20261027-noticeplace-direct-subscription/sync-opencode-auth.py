"""Copy only the effective native OpenCode credential to Herder's own env.

No credentials are printed. No native runtime is changed or restarted.
"""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("migration", root / "deploy/systemd/migrate-herder-env.py")
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)
pid = subprocess.check_output(["systemctl", "--user", "show", "opencode.service", "-p", "MainPID", "--value"], text=True).strip()
native = dict(x.split("=", 1) for x in Path("/proc", pid, "environ").read_bytes().decode().split("\0") if "=" in x)
password = native.get("OPENCODE_SERVER_PASSWORD")
if not password:
    raise SystemExit("Native OpenCode has no configured password; no write")
target = Path.home() / ".config/agent-herder/herder.env"
current = migration.parse_env_file(target.read_text())
if current.get("OPENCODE_SERVER_PASSWORD") == password:
    raise SystemExit("Herder credential already matches native runtime; no write")
backup = root / ".tmp/notice-direct-20261027/herder-env.before-auth-sync"
if backup.exists():
    raise SystemExit("Existing backup: inspect previous operation before retry")
shutil.copy2(target, backup)
backup.chmod(0o600)
current["OPENCODE_SERVER_PASSWORD"] = password
migration.write_file_atomically(target, migration.render_env_file(current), 0o600)
print("Updated only OPENCODE_SERVER_PASSWORD in Herder product env; protected backup retained")
