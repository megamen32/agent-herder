#!/usr/bin/env python3
"""Exercise the built CLI in private disposable homes; never use a live home."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import tempfile


def snapshot(root):
    return {
        str(path.relative_to(root)): (
            hashlib.sha256(path.read_bytes()).hexdigest(),
            path.stat().st_ino,
            path.stat().st_mtime_ns,
            stat.S_IMODE(path.stat().st_mode),
        )
        for path in root.rglob("*") if path.is_file()
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--temp-parent", type=Path,
                        default=Path(__file__).resolve().parents[3] / ".tmp")
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    args.temp_parent.mkdir(mode=0o700, exist_ok=True)

    def run(home):
        return subprocess.run([str(binary), str(home)], capture_output=True,
                              text=True, timeout=20)

    def private_home(parent):
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        home = parent / "herder-owner-home"
        home.mkdir(mode=0o700)
        return home

    def refused_untouched(home):
        before = snapshot(home)
        result = run(home)
        assert result.returncode != 0, result.stdout
        assert not result.stdout.strip(), result.stdout
        assert snapshot(home) == before, "refusal changed existing files"
        return result

    with tempfile.TemporaryDirectory(prefix="owner-bootstrap-test-", dir=args.temp_parent.resolve()) as temporary:
        root = Path(temporary)
        home = private_home(root / "fresh")
        result = run(home)
        assert result.returncode == 0, result.stderr
        seed = json.loads(result.stdout)
        assert set(seed) == {"database", "gate", "generation", "profile_seed"}
        authority = home / "authority"
        assert seed["database"] == str(authority / "state.db")
        assert seed["gate"] == str(authority / "gate")
        assert seed["profile_seed"] == str(authority / "seed.json")
        assert json.loads(Path(seed["profile_seed"]).read_text()) == seed
        assert stat.S_IMODE(authority.stat().st_mode) == 0o700
        assert all(stat.S_IMODE(p.stat().st_mode) == 0o600
                   for p in authority.iterdir() if p.is_file())
        with sqlite3.connect(Path(seed["database"]).as_uri() + "?mode=ro", uri=True) as db:
            assert db.execute("PRAGMA user_version").fetchone() == (4,)
            assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
            assert db.execute("SELECT generation FROM humanstop_authority").fetchall() == [(seed["generation"],)]
            assert db.execute("SELECT count(*) FROM session_search_fts").fetchone() == (0,)
            assert db.execute("SELECT count(*) FROM session_search_state").fetchone() == (0,)
        refused_untouched(home)

        existing = private_home(root / "existing")
        (existing / "authority").mkdir(mode=0o700)
        (existing / "authority" / "keep").write_bytes(b"existing authority must survive\x00\xff")
        refused_untouched(existing)

        target = private_home(root / "symlink-target")
        link_parent = root / "symlink"
        link_parent.mkdir(mode=0o700)
        link = link_parent / "herder-owner-home"
        link.symlink_to(target, target_is_directory=True)
        refused_untouched(link)
        assert not (target / "authority").exists()

        unsafe = private_home(root / "permissions")
        unsafe.chmod(0o755)
        refused_untouched(unsafe)
        assert not (unsafe / "authority").exists()

        writable = private_home(root / "writable-ancestor")
        writable.parent.chmod(0o770)
        refused_untouched(writable)
        assert not (writable / "authority").exists()

        ancestor_target = root / "ancestor-target"
        ancestor_home = private_home(ancestor_target)
        alias = root / "ancestor-alias"
        alias.symlink_to(ancestor_target, target_is_directory=True)
        refused_untouched(alias / "herder-owner-home")
        assert not (ancestor_home / "authority").exists()

        wrong = root / "wrong-name"
        wrong.mkdir(mode=0o700)
        refused_untouched(wrong)
        relative = Path(os.path.relpath(home, Path.cwd()))
        refused_untouched(relative)
        assert run(root / "missing" / "herder-owner-home").returncode != 0
    print(json.dumps({"result": "PASS", "schema_version": 4,
                      "checks": ["fresh-v4-and-authority", "duplicate-byte-inode-mtime-preservation",
                                 "existing-authority-preserved", "symlink-root-refused",
                                 "nonprivate-root-refused", "writable-ancestor-refused",
                                 "symlink-ancestor-refused", "wrong-name-refused",
                                 "relative-path-refused", "missing-root-refused"],
                      "binary": str(binary),
                      "sha256": hashlib.sha256(binary.read_bytes()).hexdigest()}))


if __name__ == "__main__":
    main()
