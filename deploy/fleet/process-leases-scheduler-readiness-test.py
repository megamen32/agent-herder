#!/usr/bin/env python3
"""Paired rollout proofs with a harmless real Node process and isolated files."""
import copy
import datetime
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader("scheduler_readiness", str(Path(__file__).with_name("process-leases-scheduler-readiness.py")))
spec = importlib.util.spec_from_loader(loader.name, loader)
readiness = importlib.util.module_from_spec(spec)
loader.exec_module(readiness)


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def save(path, value, mode=0o400):
    data = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode() if not isinstance(value, bytes) else value
    path.write_bytes(data)
    path.chmod(mode)
    return hashlib.sha256(data).hexdigest()


class SchedulerProofContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.binary_root = tempfile.TemporaryDirectory(prefix="herder-ts-readiness-node-")
        cls.node = Path(cls.binary_root.name) / "node"
        shutil.copyfile(Path(shutil.which("node")).resolve(), cls.node)
        cls.node.chmod(0o500)
        cls.node_hash = hashlib.sha256(cls.node.read_bytes()).hexdigest()

    @classmethod
    def tearDownClass(cls):
        cls.binary_root.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="herder-ts-readiness-test-")
        self.root = Path(self.temp.name)
        self.tree = self.root / "compiled"
        self.tree.mkdir(mode=0o700)
        self.source = "a" * 40
        files = {name: b"// isolated compiled fixture\n" for name in readiness.REQUIRED_FILES}
        files["index.js"] = b"require('node:http').createServer((q,r)=>r.end('fixture')).listen(0,'127.0.0.1',function(){process.stdout.write(String(this.address().port)+'\\n')});\n"
        self.manifest = {"version": 1, "kind": "herder-canonical-ts-runtime", "capability": readiness.CAPABILITY,
            "source_commit": self.source, "root": str(self.tree), "entry": "index.js",
            "files": {name: save(self.tree / name, data) for name, data in files.items()},
            "node_binary": str(self.node), "node_sha256": self.node_hash}
        self.tree.chmod(0o500)
        self.manifest_path = self.root / "runtime.json"
        self.manifest_hash = save(self.manifest_path, self.manifest)
        exited = subprocess.run([str(self.node), "-e", "process.stdout.write(require('node:fs').readFileSync('/proc/self/stat','utf8'))"],
            text=True, capture_output=True, timeout=5, check=True).stdout
        old_pid = int(exited.split(" ", 1)[0])
        old_start = exited.rsplit(")", 1)[1].split()[19]
        epoch = "paired-fixture-epoch"
        self.waits = self.root / "old-waits"
        self.waits.mkdir(mode=0o500)
        self.receipts = self.root / "old-receipts.json"
        save(self.receipts, {"version": 1, "receipts": {}})
        self.drain = {"version": 1, "kind": "herder-legacy-writer-drain", "epoch": epoch,
            "platform": "linux", "hostname": socket.gethostname(), "node_ref": "server-100", "completed_at": stamp(),
            "sources": [str(self.waits), str(self.receipts)], "writers": [{"pid": old_pid,
                "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(), "start_ticks": old_start,
                "executable_sha256": self.node_hash, "sources": [str(self.waits), str(self.receipts)],
                "observation": {"observed_at": stamp(), "result": "identity_absent", "provider_operation_id": "fixture-short-process-exit",
                    "target": "fixture:local-process", "method": "wait-for-exit"}}]}
        self.drain["completed_at"] = self.drain["writers"][0]["observation"]["observed_at"]
        self.drain_path = self.root / "drain.json"
        drain_hash = save(self.drain_path, self.drain)
        waits_snapshot, receipts_snapshot = self.root / "waits-snapshot.json", self.root / "receipts-snapshot.json"
        self.config = {"version": 1, "mode": "canonical", "epoch": epoch, "authority": readiness.AUTHORITY,
            "writer_drain": {"path": str(self.drain_path), "sha256": drain_hash},
            "resume_after": {"directory": str(self.waits), "snapshot": str(waits_snapshot), "sha256": save(waits_snapshot, {"epoch": epoch})},
            "resume_receipts": {"path": str(self.receipts), "snapshot": str(receipts_snapshot), "sha256": save(receipts_snapshot, {"epoch": epoch})}}
        self.config_path = self.root / "canonical.json"
        self.config_hash = save(self.config_path, self.config)
        self.env = {**os.environ, "AGENT_HERDER_CANONICAL_MODE": "canonical", "AGENT_HERDER_CANONICAL_CONFIG": str(self.config_path),
            "AGENT_HERDER_CANONICAL_CONFIG_SHA256": self.config_hash,
            "AGENT_HERDER_TS_RUNTIME_MANIFEST": str(self.manifest_path), "AGENT_HERDER_TS_RUNTIME_MANIFEST_SHA256": self.manifest_hash,
            "AGENT_HERDER_WEB_PORT": "18787"}
        for key in ("NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_AUDIT"):
            self.env.pop(key, None)
        # Ephemeral socket is read independently, never the real Herder port.
        self.child = subprocess.Popen([str(self.node), str(self.tree / "index.js")], env=self.env,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.port = int(self.child.stdout.readline().strip())
        self.unit_file = self.root / "agent-herder.service"
        save(self.unit_file, b"[Service]\n# isolated systemd observation fixture\n", 0o600)
        self.unit_override = {}
        self.addCleanup(self.cleanup)
        self.addCleanup(patch.stopall)
        patch.object(readiness, "PORT", self.port).start()
        patch.object(readiness, "ENDPOINT", "http://127.0.0.1:" + str(self.port) + "/api/canonical-runtime-status").start()
        # Keep the production launch env contract while the socket uses a test
        # ephemeral port. Only this /proc environment value is adjusted below.
        self.env["AGENT_HERDER_WEB_PORT"] = str(self.port)
        self.child.terminate(); self.child.wait(timeout=5)
        self.child.stdout.close(); self.child.stderr.close()
        entry = self.tree / "index.js"
        entry.chmod(0o600)
        text = files["index.js"].replace(b".listen(0,", (".listen(" + str(self.port) + ",").encode())
        self.manifest["files"]["index.js"] = save(entry, text)
        self.manifest_path.chmod(0o600)
        self.manifest_hash = save(self.manifest_path, self.manifest)
        self.env["AGENT_HERDER_TS_RUNTIME_MANIFEST_SHA256"] = self.manifest_hash
        self.child = subprocess.Popen([str(self.node), str(entry)], env=self.env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(self.child.stdout.readline().strip(), str(self.port))
        patch.object(readiness.subprocess, "run", side_effect=self.systemctl).start()
        self.response = {"version": 1, "kind": "herder-canonical-runtime-status", "challenge": "b" * 64,
            "observedAt": stamp(), "process": {**readiness.birth(self.child.pid), "entry": str(entry),
                "entry_sha256": self.manifest["files"]["index.js"], "node_binary": str(self.node), "node_sha256": self.node_hash},
            "runtime": {"manifest": str(self.manifest_path), "manifest_sha256": self.manifest_hash,
                "source_commit": self.source, "capability": readiness.CAPABILITY,
                "resume_after_authority": "canonical", "legacy_fallback": False},
            "canonical": {"config": str(self.config_path), "config_sha256": self.config_hash, "epoch": epoch,
                "authority": readiness.AUTHORITY, "writer_drain_sha256": drain_hash}, "migration_ready": False, "readiness_scope": "preflight", "probe": None}

    def cleanup(self):
        if self.child.poll() is None:
            self.child.terminate(); self.child.wait(timeout=5)
        self.child.stdout.close(); self.child.stderr.close()
        for directory, dirs, _ in os.walk(self.root):
            Path(directory).chmod(0o700)
            for name in dirs:
                (Path(directory) / name).chmod(0o700)
        self.temp.cleanup()

    def systemctl(self, argv, **kwargs):
        self.assertEqual(argv[:4], ["/usr/bin/systemctl", "--user", "show", readiness.UNIT])
        values = {"Id": readiness.UNIT, "LoadState": "loaded", "ActiveState": "active", "SubState": "running",
            "MainPID": str(self.child.pid), "NeedDaemonReload": "no", "FragmentPath": str(self.unit_file),
            "DropInPaths": "", "ExecStart": "{ path=" + str(self.node) + " ; argv[]=" + str(self.node) + " " + str(self.tree / "index.js") + " ; ignore_errors=no ; }",
            "Environment": " ".join(key + "=" + self.env[key] for key in readiness.ENV_KEYS), "EnvironmentFiles": ""}
        values.update(self.unit_override)
        return subprocess.CompletedProcess(argv, 0, "\n".join(key + "=" + value for key, value in values.items()), "")

    def receipt(self, consumer=False):
        response = copy.deepcopy(self.response)
        response["observedAt"] = stamp()
        request = {"endpoint": readiness.ENDPOINT, "challenge": response["challenge"]}
        value = {"version": 1, "kind": "herder-canonical-scheduler-proof", "stage": "consumer" if consumer else "preflight",
            "target": readiness.CONTROLLER, "unit": readiness.UNIT, "method": "http_get",
            "provider_operation_id": "fixture-authenticated-read", "observed_at_unix_ms": readiness.now_ms(),
            "request": request, "response": response}
        if consumer:
            response["migration_ready"] = True
            response["readiness_scope"] = "operational"
            if "quarantine" in response:
                response["quarantine"]["native_verified"] = True
                response["quarantine"]["authorities"] = copy.deepcopy(self.quarantine_authorities)
            value["job_id"] = "rollout-" + "c" * 32
            request["probe"] = {"harness": "codex", "native_session_id": "fixture-native-session"}
            response["probe"] = {"request": request["probe"], "gateBlocked": True,
                "decision": {"version": 1, "configured": True, "complete": True, "blocked": True,
                    "reason": "waiting_process", "mapped": True, "sessionRefs": ["session:fixture"],
                    "ruleRefs": ["process-rule:fixture"], "observedAt": stamp()}}
        value["response_sha256"] = readiness.json_hash(response)
        return value

    def pin(self, path, value):
        if path.exists():
            path.chmod(0o600)
        return save(path, value)

    def activate_quarantine(self):
        """Sealed, isolated old records; no real Herder source or native authority."""
        epoch = self.config["epoch"]
        jobs = self.root / "old-jobs"
        jobs.mkdir(mode=0o700)
        job_dir = jobs / "job-1"
        job_dir.mkdir(mode=0o700)
        job = job_dir / "meta.json"
        save(job, {"job_id": "job-1", "state": "completed", "execute_resume": True,
                   "resume": {"agent": "codex", "session_id": "fixture-native-session"},
                   "resume_result": {"ok": True, "executed": True}})
        job_dir.chmod(0o500)
        jobs.chmod(0o500)
        wait_id = "wait_" + "e" * 32
        self.waits.chmod(0o700)
        wait = self.waits / (wait_id + ".json")
        save(wait, {"id": wait_id, "state": "delivery_unknown", "owner": {
            "harness": "codex", "sessionId": "fixture-native-session"}, "dependencies": [],
            "message": "fixture", "createdAt": stamp(), "completed": {}})
        self.waits.chmod(0o500)
        receipt_key = "fixture-old-resume"
        self.pin(self.receipts, {"version": 1, "receipts": {receipt_key: {
            "idempotency_key": receipt_key, "fingerprint": "f" * 64, "status": "ambiguous",
            "target": {"agent": "codex", "session_id": "fixture-native-session"}}}})
        self.drain["sources"].append(str(jobs))
        self.drain["writers"][0]["sources"].append(str(jobs))
        drain_hash = self.pin(self.drain_path, self.drain)
        self.config["writer_drain"]["sha256"] = drain_hash

        def digest(path):
            return hashlib.sha256(path.read_bytes()).hexdigest()

        def identity(path):
            info = path.stat()
            return {"device": str(info.st_dev), "inode": str(info.st_ino)}

        waits_seal = {"version": 1, "kind": "herder-resume-after-retained", "epoch": epoch,
            "directory": str(self.waits), "directory_identity": identity(self.waits), "sealed_at": stamp(),
            "records": [{"id": wait_id, "sha256": digest(wait)}]}
        self.config["resume_after"]["sha256"] = self.pin(Path(self.config["resume_after"]["snapshot"]), waits_seal)
        receipts_seal = {"version": 1, "kind": "herder-resume-receipts-retained", "epoch": epoch,
            "path": str(self.receipts), "file_identity": identity(self.receipts), "sealed_at": stamp(),
            "sha256": digest(self.receipts)}
        self.config["resume_receipts"]["sha256"] = self.pin(Path(self.config["resume_receipts"]["snapshot"]), receipts_seal)
        jobs_seal = self.root / "jobs-snapshot.json"
        jobs_hash = save(jobs_seal, {"version": 1, "kind": "herder-legacy-jobs-retained", "epoch": epoch,
            "directory": str(jobs), "directory_identity": identity(jobs), "sealed_at": stamp(),
            "records": [{"id": "job-1", "sha256": digest(job)}]})
        sources = {str(path): digest(path) for path in (wait, self.receipts, job)}
        inventory = hashlib.sha256("".join(sorted(
            path + "\0" + value + "\n" for path, value in sources.items())).encode()).hexdigest()
        profiles = [{"harness": "codex", "node_ref": "server-100", "instance_ref": "primary", "authority_generation": "generation-one"},
                    {"harness": "opencode", "node_ref": "server-100", "instance_ref": "secondary", "authority_generation": "generation-two"}]
        records = []
        for ref, path, row, keys in [
            ("resume-after:" + wait_id, wait, json.loads(wait.read_bytes()), [wait_id, "resume-after:" + wait_id]),
            ("agent-resume-job:job-1", job, json.loads(job.read_bytes()), [
                "job-1", "agent-resume:job:job-1", "compat-resume:v1:" + hashlib.sha256(b"agent-resume:job:job-1").hexdigest()]),
            ("resume-receipt:" + hashlib.sha256(receipt_key.encode()).hexdigest(), self.receipts,
             json.loads(self.receipts.read_bytes())["receipts"][receipt_key],
             [receipt_key, "compat-resume:v1:" + hashlib.sha256(receipt_key.encode()).hexdigest()]),
        ]:
            records.append({"record_ref": ref, "source_path": str(path), "source_sha256": digest(path),
                "record_sha256": hashlib.sha256(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest(),
                "request_keys": keys, "outcome": "unknown", "holds": [{
                    "node_ref": p["node_ref"], "instance_ref": p["instance_ref"], "native_session_id": "fixture-native-session"} for p in profiles]})
        snapshots, authorities = [], []
        for index, profile in enumerate(profiles):
            path = self.root / ("quarantine-" + str(index) + ".json")
            digest_value = save(path, {"version": 1, "kind": "herder-legacy-quarantine", "epoch": epoch,
                **{key: profile[key] for key in ("authority_generation", "node_ref", "instance_ref")},
                "writer_drain_sha256": drain_hash, "inventory_sha256": inventory,
                "sources": [{"path": path, "sha256": value} for path, value in sorted(sources.items())], "records": records})
            snapshots.append({**profile, "path": str(path), "sha256": digest_value})
            authorities.append({"version": 1, "configured": True, "epoch": epoch, "required_epoch": epoch,
                **{key: profile[key] for key in ("authority_generation", "node_ref", "instance_ref")},
                "snapshot_sha256": digest_value, "writer_drain_sha256": drain_hash, "inventory_sha256": inventory})
        self.config["quarantine"] = {"inventory_sha256": inventory,
            "legacy_jobs": {"directory": str(jobs), "snapshot": str(jobs_seal), "sha256": jobs_hash},
            "snapshots": snapshots}
        self.config_hash = self.pin(self.config_path, self.config)
        self.response["canonical"].update(config_sha256=self.config_hash, writer_drain_sha256=drain_hash)
        self.response["quarantine"] = {"version": 1, "configured": True, "local_verified": True,
            "native_verified": False, "inventory_sha256": inventory,
            "snapshots": [{key: p[key] for key in ("harness", "node_ref", "instance_ref", "authority_generation", "sha256")}
                          for p in snapshots], "authorities": []}
        self.quarantine_authorities = authorities
        self.env["AGENT_HERDER_CANONICAL_CONFIG_SHA256"] = self.config_hash
        self.child.terminate(); self.child.wait(timeout=5)
        self.child.stdout.close(); self.child.stderr.close()
        self.child = subprocess.Popen([str(self.node), str(self.tree / "index.js")], env=self.env,
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(self.child.stdout.readline().strip(), str(self.port))
        self.response["process"].update(readiness.birth(self.child.pid))

    def verify(self, receipt=None):
        return readiness.validate_receipt(receipt or self.receipt(), self.source, stage="preflight")

    def test_live_process_immutable_source_drain_and_actual_gate_are_paired(self):
        identity = self.verify()["identity"]
        receipt = self.receipt(consumer=True)
        evidence = readiness.validate_receipt(receipt, self.source, stage="consumer", expected=identity,
            challenge=self.response["challenge"], job_id=receipt["job_id"], minimum=readiness.now_ms() - 1000)
        self.assertEqual(evidence["identity"], identity)
        self.assertTrue(evidence["gate"]["gateBlocked"])
        self.assertEqual(identity["listener"]["port"], self.port)

    def test_stale_readiness_and_wrong_source_are_not_admitted(self):
        receipt = self.receipt()
        receipt["observed_at_unix_ms"] -= 61000
        with self.assertRaisesRegex(ValueError, "stale"):
            self.verify(receipt)
        with self.assertRaisesRegex(ValueError, "same source commit"):
            readiness.validate_receipt(self.receipt(), "d" * 40, stage="preflight")

    def test_consumer_cannot_switch_pid_epoch_or_challenge(self):
        identity = self.verify()["identity"]
        for kind in ("pid", "epoch", "challenge"):
            with self.subTest(kind=kind):
                receipt = self.receipt(consumer=True)
                if kind == "pid": receipt["response"]["process"]["pid"] += 1
                if kind == "epoch": receipt["response"]["canonical"]["epoch"] = "another-epoch"
                if kind == "challenge": receipt["request"]["challenge"] = "d" * 64
                receipt["response_sha256"] = readiness.json_hash(receipt["response"])
                with self.assertRaisesRegex(ValueError, "different|changed PID"):
                    readiness.validate_receipt(receipt, self.source, stage="consumer", expected=identity,
                        challenge=self.response["challenge"], job_id=receipt["job_id"])

    def test_status_process_cannot_replace_actual_service_main_pid(self):
        self.unit_override["MainPID"] = str(self.child.pid + 1)
        with self.assertRaisesRegex(ValueError, "MainPID"):
            self.verify()

    def test_service_restart_cannot_fall_back_to_legacy_environment(self):
        self.unit_override["Environment"] = "AGENT_HERDER_CANONICAL_MODE=legacy"
        with self.assertRaisesRegex(ValueError, "persistent systemd Environment"):
            self.verify()
        self.unit_override["Environment"] = " ".join(key + "=" + self.env[key] for key in readiness.ENV_KEYS)
        self.unit_override["Environment"] += " NODE_OPTIONS=--require=/fixture/unpinned.js"
        with self.assertRaisesRegex(ValueError, "executable injection"):
            self.verify()

    def test_live_retained_writer_cannot_be_declared_drained(self):
        writer = self.drain["writers"][0]
        writer.update(readiness.birth(self.child.pid))
        self.drain_path.chmod(0o600)
        digest = save(self.drain_path, self.drain)
        self.config["writer_drain"]["sha256"] = digest
        self.config_path.chmod(0o600)
        self.response["canonical"].update(config_sha256=save(self.config_path, self.config), writer_drain_sha256=digest)
        with self.assertRaisesRegex(ValueError, "writer is still alive"):
            self.verify()

    def test_mutable_or_uninventoried_compiled_code_is_rejected(self):
        entry = self.tree / "canonical-herder.js"
        entry.chmod(0o600)
        with self.assertRaisesRegex(ValueError, "permissions"):
            self.verify()
        entry.chmod(0o400)
        self.tree.chmod(0o700)
        save(self.tree / "extra.js", b"// unpinned import")
        self.tree.chmod(0o500)
        with self.assertRaisesRegex(ValueError, "unpinned file"):
            self.verify()

    def test_incomplete_or_disagreeing_gate_cannot_prove_readiness(self):
        identity = self.verify()["identity"]
        for change in ({"complete": False}, {"configured": False}, {"blocked": False}, {"observedAt": "2000-01-01T00:00:00.000Z"}):
            with self.subTest(change=change):
                receipt = self.receipt(consumer=True)
                receipt["response"]["probe"]["decision"].update(change)
                receipt["response_sha256"] = readiness.json_hash(receipt["response"])
                with self.assertRaises(ValueError):
                    readiness.validate_receipt(receipt, self.source, stage="consumer", expected=identity,
                        challenge=self.response["challenge"], job_id=receipt["job_id"], minimum=readiness.now_ms() - 1000)

    def test_reobservation_rejects_a_changed_unit_configuration(self):
        identity = self.verify()["identity"]
        self.unit_file.write_bytes(b"[Service]\n# changed during rollout\n")
        with self.assertRaisesRegex(ValueError, "configuration changed"):
            readiness.observe(identity)

    def test_quarantine_preflight_and_complete_native_consumer_are_distinct(self):
        self.activate_quarantine()
        preflight = self.verify()
        self.assertEqual(preflight["readiness_scope"], "preflight")
        self.assertFalse(preflight["quarantine"]["native_verified"])
        receipt = self.receipt(consumer=True)
        consumer = readiness.validate_receipt(receipt, self.source, stage="consumer", expected=preflight["identity"],
            challenge=self.response["challenge"], job_id=receipt["job_id"])
        self.assertTrue(consumer["quarantine"]["native_verified"])
        self.assertEqual(len(consumer["quarantine"]["authorities"]), 2)

    def test_quarantine_requires_every_pinned_native_authority(self):
        self.activate_quarantine()
        expected = self.verify()["identity"]
        cases = ("absent", "missing", "duplicate", "epoch", "required_epoch", "authority_generation",
                 "snapshot_sha256", "writer_drain_sha256", "inventory_sha256", "native_verified", "snapshot_omitted")
        for change in cases:
            with self.subTest(change=change):
                receipt = self.receipt(consumer=True)
                q = receipt["response"]["quarantine"]
                if change == "absent":
                    del receipt["response"]["quarantine"]
                elif change == "missing":
                    q["authorities"].pop()
                elif change == "duplicate":
                    q["authorities"][1] = copy.deepcopy(q["authorities"][0])
                elif change == "native_verified":
                    q["native_verified"] = False
                elif change == "snapshot_omitted":
                    q["snapshots"].pop()
                else:
                    q["authorities"][0][change] = "wrong-identity"
                receipt["response_sha256"] = readiness.json_hash(receipt["response"])
                with self.assertRaises(ValueError):
                    readiness.validate_receipt(receipt, self.source, stage="consumer", expected=expected,
                        challenge=self.response["challenge"], job_id=receipt["job_id"])

    def test_quarantine_preflight_cannot_claim_operational_readiness(self):
        self.activate_quarantine()
        for change in ("migration_ready", "readiness_scope", "native_verified", "authorities"):
            with self.subTest(change=change):
                receipt = self.receipt()
                if change == "migration_ready":
                    receipt["response"][change] = True
                elif change == "readiness_scope":
                    receipt["response"][change] = "operational"
                elif change == "native_verified":
                    receipt["response"]["quarantine"][change] = True
                else:
                    receipt["response"]["quarantine"][change] = copy.deepcopy(self.quarantine_authorities)
                receipt["response_sha256"] = readiness.json_hash(receipt["response"])
                with self.assertRaises(ValueError):
                    self.verify(receipt)

    def test_quarantine_jobs_must_be_in_the_writer_drain(self):
        self.activate_quarantine()
        jobs = self.config["quarantine"]["legacy_jobs"]["directory"]
        self.drain["sources"].remove(jobs)
        self.drain["writers"][0]["sources"].remove(jobs)
        digest = self.pin(self.drain_path, self.drain)
        self.config["writer_drain"]["sha256"] = digest
        self.response["canonical"].update(config_sha256=self.pin(self.config_path, self.config), writer_drain_sha256=digest)
        with self.assertRaisesRegex(ValueError, "configured legacy jobs"):
            self.verify()

    def test_quarantine_snapshot_epoch_generation_and_record_coverage_are_pinned(self):
        self.activate_quarantine()
        profile = self.config["quarantine"]["snapshots"][0]
        path = Path(profile["path"])
        original = json.loads(path.read_bytes())
        for change in ("epoch", "authority_generation", "inventory_sha256", "record_omitted", "source_omitted", "record_sha256"):
            with self.subTest(change=change):
                snapshot = copy.deepcopy(original)
                if change == "record_omitted":
                    snapshot["records"].pop()
                elif change == "source_omitted":
                    snapshot["sources"].pop()
                elif change == "record_sha256":
                    snapshot["records"][0][change] = "0" * 64
                else:
                    snapshot[change] = "wrong-identity"
                profile["sha256"] = self.pin(path, snapshot)
                with self.assertRaises(ValueError):
                    readiness.quarantine(self.config)
        profile["sha256"] = self.pin(path, original)
        readiness.quarantine(self.config)

    def test_quarantine_original_and_derived_request_keys_cannot_be_omitted(self):
        self.activate_quarantine()
        self.verify()
        profile = self.config["quarantine"]["snapshots"][0]
        path = Path(profile["path"])
        original = json.loads(path.read_bytes())
        for index, record in enumerate(original["records"]):
            for key in record["request_keys"]:
                with self.subTest(record=record["record_ref"], omitted=key):
                    snapshot = copy.deepcopy(original)
                    snapshot["records"][index]["request_keys"].remove(key)
                    profile["sha256"] = self.pin(path, snapshot)
                    with self.assertRaisesRegex(ValueError, "request key coverage"):
                        readiness.quarantine(self.config)
        profile["sha256"] = self.pin(path, original)
        self.verify()

    def test_quarantine_retained_jobs_cannot_change_or_be_omitted(self):
        self.activate_quarantine()
        jobs = Path(self.config["quarantine"]["legacy_jobs"]["directory"])
        metadata = jobs / "job-1" / "meta.json"
        original = metadata.read_bytes()
        self.pin(metadata, {"job_id": "job-1", "state": "completed", "changed": True})
        with self.assertRaisesRegex(ValueError, "source digest changed"):
            readiness.quarantine(self.config)
        self.pin(metadata, original)
        jobs.chmod(0o700)
        (jobs / "omitted-job").mkdir(mode=0o500)
        jobs.chmod(0o500)
        with self.assertRaisesRegex(ValueError, "directory inventory changed"):
            readiness.quarantine(self.config)

    def test_fifo_never_blocks_the_readiness_verifier(self):
        fifo = self.root / "fifo-proof"
        os.mkfifo(fifo, 0o600)
        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, "regular file"):
            readiness.read_file(str(fifo))
        self.assertLess(time.monotonic() - started, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
