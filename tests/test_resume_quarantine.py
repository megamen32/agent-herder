import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "deploy/fleet"))
from prepare_resume_quarantine import stage, digest, encoded, job_settled
from apply_resume_quarantine import apply, process_birth, validate_scoped_writer_schema, SCHEMA_OBJECTS

class QuarantineImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.waits = self.root / "waits"
        self.jobs = self.root / "jobs"
        self.waits.mkdir(mode=0o700)
        self.jobs.mkdir(mode=0o700)
        self.wait_id = "wait_" + "a" * 32
        self.wait = self.waits / (self.wait_id + ".json")
        self.write(self.wait, {"id": self.wait_id, "owner": {"harness": "codex", "sessionId": "old-native", "hostId": "node"},
                              "state": "cancelled", "message": "historical", "dependencies": [], "completed": {},
                              "createdAt": "2026-01-01T00:00:00Z"})
        self.job_dir = self.jobs / "old-job"
        self.job_dir.mkdir(mode=0o700)
        self.write(self.job_dir / "meta.json", {"job_id": "old-job", "state": "running", "execute_resume": True,
                                               "resume": {"agent": "codex", "session_id": "old-native"}})
        self.ledger = self.root / "receipts.json"
        self.write(self.ledger, {"version": 1, "receipts": {"old-key": {"idempotency_key": "old-key",
            "fingerprint": "c" * 64, "status": "accepted", "receipt_ref": "receipt", "result_ref": "result",
            "target": {"agent": "codex", "session_id": "old-native"}}}})
        self.db = self.root / "owner.db"
        self.gate = self.root / "owner.gate"
        self.gate.touch(mode=0o600)
        self.create_authority_database(4)
        child = subprocess.run([sys.executable, "-c", "from pathlib import Path;print(Path('/proc/self/stat').read_text())"], check=True, capture_output=True, text=True)
        raw = child.stdout.strip()
        pid = int(raw.split(" ", 1)[0]); ticks = raw[raw.rfind(")") + 2:].split()[19]
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        sources = [str(self.waits), str(self.jobs), str(self.ledger)]
        self.drain = {"version": 1, "kind": "herder-legacy-writer-drain", "epoch": "epoch",
                      "platform": "linux", "hostname": socket.gethostname(), "node_ref": "node",
                      "completed_at": now, "sources": sources, "writers": [{"pid": pid,
                      "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(), "start_ticks": ticks,
                      "executable_sha256": digest(Path(sys.executable).resolve().read_bytes()), "sources": sources,
                      "observation": {"observed_at": now, "result": "identity_absent", "provider_operation_id": "fixture-exit",
                                      "target": "fixture-local-child", "method": "wait-for-exit"}}]}
        self.drain_path = self.root / "drain.json"; self.write(self.drain_path, self.drain)
        self.config = {"version": 1, "epoch": "epoch", "authority": "mcp:shell:node:AgentHerder", "node_ref": "node",
                       "writer_drain": {"path": str(self.drain_path), "sha256": digest(self.drain_path.read_bytes())},
                       "resume_after": str(self.waits), "resume_receipts": str(self.ledger), "legacy_jobs": str(self.jobs),
                       "profiles": [{"harness": "codex", "node_ref": "node", "instance_ref": "profile",
                                     "authority_generation": "generation", "database": str(self.db), "gate": str(self.gate)}]}

    def create_authority_database(self, version):
        # Exercise the real Rust schema and all writer/immutability triggers.
        connection = sqlite3.connect(self.db)
        connection.execute("PRAGMA foreign_keys=ON")
        store = ROOT / "crates/herder/src/store"
        for name in ("schema.sql", "migration_v1_v2.sql", "migration_v2_v3.sql"):
            connection.executescript((store / name).read_text())
        if version == 4:
            connection.executescript((store / "migration_v3_v4.sql").read_text())
        connection.create_function("herder_writer_version", 0, lambda: version, deterministic=True)
        os.chmod(self.db, 0o600)
        dm, gm = self.db.stat(), self.gate.stat()
        connection.execute("INSERT INTO humanstop_authority VALUES(1,?,?,?,?,?,?)",
                           ("generation", gm.st_dev, gm.st_ino, dm.st_dev, dm.st_ino, "fixture"))
        connection.commit()
        connection.close()

    def tearDown(self):
        for p in self.root.rglob("*"):
            if p.is_dir(): os.chmod(p, 0o700)
        self.tmp.cleanup()

    def write(self, path, value):
        if path.exists(): os.chmod(path, 0o600)
        path.write_bytes(encoded(value)); os.chmod(path, 0o600)

    def staged(self):
        return stage(self.config, self.root / "staged")

    def rows(self):
        with sqlite3.connect(self.db) as c:
            return c.execute("SELECT scope,setting_key,value_json FROM settings").fetchall()

    def test_real_v3_authority_import_preserves_schema(self):
        self.db.unlink()
        self.create_authority_database(3)
        with sqlite3.connect(self.db) as c:
            before = c.execute(SCHEMA_OBJECTS).fetchall()
        pin, plan = self.staged()
        result = apply(pin["path"], pin["sha256"], self.root / "receipt.json")
        self.assertEqual(result["installed"][0]["admission"], "stored")
        with sqlite3.connect(self.db) as c:
            self.assertEqual(c.execute("PRAGMA user_version").fetchone()[0], 3)
            self.assertEqual(c.execute(SCHEMA_OBJECTS).fetchall(), before)
        self.assertEqual(digest(self.rows()[0][2].encode()), plan["imports"][0]["sha256"])

    def test_actual_missing_writer_function_failure_recovers_sealed_plan(self):
        from unittest.mock import patch
        pin, plan = self.staged()
        receipt = self.root / "receipt.json"
        def unfenced_old_connection(c):
            c.execute("PRAGMA foreign_keys=ON")
            c.execute("BEGIN IMMEDIATE")
            validate_scoped_writer_schema(c)
        with sqlite3.connect(self.db) as c:
            schema_before = c.execute(SCHEMA_OBJECTS).fetchall()
        with patch("apply_resume_quarantine.configure_scoped_writer", side_effect=unfenced_old_connection):
            with self.assertRaisesRegex(sqlite3.OperationalError, "no such function: herder_writer_version"):
                apply(pin["path"], pin["sha256"], receipt)
        self.assertEqual(self.rows(), [])
        self.assertFalse(receipt.exists())
        self.assertEqual(self.wait.stat().st_mode & 0o777, 0o400)
        self.assertEqual(self.waits.stat().st_mode & 0o777, 0o500)
        result = apply(pin["path"], pin["sha256"], receipt)
        self.assertEqual(result["installed"][0]["admission"], "stored")
        self.assertEqual(digest(self.rows()[0][2].encode()), plan["imports"][0]["sha256"])
        with sqlite3.connect(self.db) as c:
            self.assertEqual(c.execute("PRAGMA user_version").fetchone()[0], 4)
            self.assertEqual(c.execute(SCHEMA_OBJECTS).fetchall(), schema_before)

    def test_schema_drift_is_rejected_before_source_sealing(self):
        pin, _ = self.staged()
        with sqlite3.connect(self.db) as c:
            trigger = c.execute("SELECT sql FROM sqlite_schema WHERE name='v1_guard_settings_insert'").fetchone()[0]
        for change, restore in (
            ("DROP TRIGGER v1_guard_settings_insert", trigger),
            ("CREATE VIEW unreviewed AS SELECT 1", "DROP VIEW unreviewed"),
            ("PRAGMA user_version=5", "PRAGMA user_version=4"),
        ):
            with self.subTest(change=change):
                with sqlite3.connect(self.db) as c:
                    c.execute(change)
                with self.assertRaisesRegex(ValueError, "scoped_writer_schema"):
                    apply(pin["path"], pin["sha256"], self.root / "receipt.json")
                self.assertEqual(self.rows(), [])
                self.assertEqual(self.wait.stat().st_mode & 0o777, 0o600)
                self.assertEqual(self.waits.stat().st_mode & 0o777, 0o700)
                with sqlite3.connect(self.db) as c:
                    c.execute(restore)

    def test_stale_fixed_writer_version_remains_fenced(self):
        with sqlite3.connect(self.db) as c:
            c.create_function("herder_writer_version", 0, lambda: 3, deterministic=True)
            with self.assertRaisesRegex(sqlite3.IntegrityError, "unsupported schema version for writer"):
                c.execute("INSERT INTO settings VALUES('fixture','stale','{}',1,'now')")
        self.assertEqual(self.rows(), [])

    def test_invalid_wildcard_hold_is_rejected_before_publish(self):
        self.config["scope_overrides"] = {"resume-after:" + self.wait_id: [{"node_ref":"node", "instance_ref":"profile", "native_session_id":"*"}]}
        with self.assertRaisesRegex(ValueError, "reviewed_scope_invalid"):
            self.staged()
        self.assertEqual(self.rows(), [])

    def test_import_validates_native_snapshot_before_sealing(self):
        pin, plan = self.staged()
        snapshot_path = Path(plan["imports"][0]["path"])
        snapshot = json.loads(snapshot_path.read_bytes())
        snapshot["records"][0]["holds"][0]["native_session_id"] = "*"
        self.write(snapshot_path, snapshot)
        changed = digest(snapshot_path.read_bytes())
        plan["imports"][0]["sha256"] = changed
        config_path = Path(plan["canonical_config"]["path"])
        config = json.loads(config_path.read_bytes())
        config["quarantine"]["snapshots"][0]["sha256"] = changed
        self.write(config_path, config)
        plan["canonical_config"]["sha256"] = digest(config_path.read_bytes())
        self.write(Path(pin["path"]), plan)
        with self.assertRaisesRegex(ValueError, "quarantine_snapshot_hold_invalid"):
            apply(pin["path"], digest(Path(pin["path"]).read_bytes()), self.root / "receipt.json")
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.wait.stat().st_mode & 0o777, 0o600)

    def test_receipt_publication_failure_recovers_exact_committed_import(self):
        from unittest.mock import patch
        pin, plan = self.staged()
        receipt = self.root / "receipt.json"
        with patch("quarantine_io.rename_noreplace", side_effect=OSError("crash before atomic receipt")):
            with self.assertRaisesRegex(OSError, "crash before atomic receipt"):
                apply(pin["path"], pin["sha256"], receipt)
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        self.assertFalse(receipt.exists())
        result = apply(pin["path"], pin["sha256"], receipt)
        self.assertEqual(result["installed"][0]["admission"], "existing")
        self.assertEqual(self.rows(), rows)
        self.assertEqual(receipt.stat().st_nlink, 1)
        self.assertEqual(receipt.stat().st_mode & 0o777, 0o400)

    def test_foreign_receipt_refuses_before_any_import(self):
        pin, _ = self.staged()
        receipt = self.root / "receipt.json"
        self.write(receipt, {"epoch":"foreign"})
        with self.assertRaisesRegex(ValueError, "import_receipt_conflict"):
            apply(pin["path"], pin["sha256"], receipt)
        self.assertEqual(self.rows(), [])

    def test_detached_launch_and_finished_are_not_native_admission(self):
        target = {"agent": "codex", "session_id": "old-native"}
        result = {**target, "ok": True, "executed": True, "used_last": False, "launch_returncode": 0, "pid": 1234}
        row = {"state": "finished", "execute_resume": True, "resume": target, "resume_result": result}
        self.assertEqual(job_settled(row), "unknown")
        row["execute_resume"] = False; result["executed"] = False
        self.assertEqual(job_settled(row), "not_submitted")
        result["admission_unknown"] = True
        self.assertEqual(job_settled(row), "unknown")
        result["admission_unknown"] = False; result["admitted"] = True; result["executed"] = True
        self.assertEqual(job_settled(row), "accepted")
        result["session_id"] = "different"
        self.assertEqual(job_settled(row), "unknown")

    def test_exact_sources_unknown_scopes_and_replay_import(self):
        original = self.wait.read_bytes()
        pin, plan = self.staged()
        self.assertEqual(plan["counts"], {"waits": 1, "receipts": 1, "jobs": 1, "unknown": 2})
        self.assertEqual(self.rows(), [])
        receipt = apply(pin["path"], pin["sha256"], self.root / "receipt.json")
        self.assertEqual(receipt["native_handoffs"], 0)
        self.assertEqual(receipt["historical_outcomes_changed"], 0)
        self.assertEqual(self.wait.read_bytes(), original)
        self.assertEqual(self.wait.stat().st_mode & 0o777, 0o400)
        self.assertEqual(self.waits.stat().st_mode & 0o777, 0o500)
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(digest(rows[0][2].encode()), plan["imports"][0]["sha256"])
        records = json.loads(rows[0][2])["records"]
        self.assertIn("old-job", next(r for r in records if r["record_ref"] == "agent-resume-job:old-job")["request_keys"])
        record = records[0]
        self.assertEqual(record["outcome"], "unknown")
        self.assertEqual(record["holds"][0]["native_session_id"], "old-native")
        self.assertEqual(apply(pin["path"], pin["sha256"], self.root / "receipt.json"), receipt)
        self.assertEqual(self.rows(), rows)

    def test_changed_source_refuses_before_sealing_or_import(self):
        pin, plan = self.staged()
        self.wait.write_bytes(self.wait.read_bytes() + b" ")
        with self.assertRaisesRegex(ValueError, "legacy_source_changed"):
            apply(pin["path"], pin["sha256"], self.root / "receipt.json")
        self.assertEqual(self.rows(), [])
        self.assertEqual(self.waits.stat().st_mode & 0o777, 0o700)

    def test_live_writer_cannot_be_declared_drained(self):
        self.drain["writers"][0]["pid"] = os.getpid()
        self.drain["writers"][0]["start_ticks"] = process_birth(os.getpid())
        self.write(self.drain_path, self.drain)
        self.config["writer_drain"]["sha256"] = digest(self.drain_path.read_bytes())
        pin, _ = self.staged()
        with self.assertRaisesRegex(ValueError, "legacy_writer_still_alive"):
            apply(pin["path"], pin["sha256"], self.root / "receipt.json")
        self.assertEqual(self.rows(), [])

    def test_foreign_setting_and_authority_generation_are_never_replaced(self):
        pin, _ = self.staged()
        with sqlite3.connect(self.db) as c:
            c.create_function("herder_writer_version", 0, lambda: 4, deterministic=True)
            c.execute("INSERT INTO settings VALUES('migration:legacy','quarantine:v1','foreign',1,'now')")
        with self.assertRaisesRegex(ValueError, "existing_epoch_conflict"):
            apply(pin["path"], pin["sha256"], self.root / "receipt.json")
        self.assertEqual(self.rows()[0][2], "foreign")
        self.assertEqual(self.wait.stat().st_mode & 0o777, 0o600)

    def test_missing_target_mapping_requires_specific_reviewed_profile_hold(self):
        self.config["profiles"][0]["harness"] = "zcode"
        with self.assertRaisesRegex(ValueError, "reviewed_scope_required"):
            self.staged()
        self.config["scope_overrides"] = {
            "resume-after:" + self.wait_id: [{"node_ref": "node", "instance_ref": "profile", "native_session_id": None}],
            "agent-resume-job:old-job": [{"node_ref": "node", "instance_ref": "profile", "native_session_id": None}]}
        pin, plan = self.staged()
        snapshot = json.loads(Path(plan["imports"][0]["path"]).read_bytes())
        self.assertTrue(all(r["holds"][0]["native_session_id"] is None for r in snapshot["records"] if r["outcome"] == "unknown"))

if __name__ == "__main__":
    unittest.main()
