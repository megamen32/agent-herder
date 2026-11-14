import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("remote_wait_reader", Path(__file__).with_name("process-leases-wait-status.py"))
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


class RemoteWaitProof(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        os.chmod(self.root, 0o700)
        self.command = {"principal_ref": "p", "session_ref": "session", "request_key": "request",
                        "argv": ["/bin/true"], "cwd": "/executor/repo", "deadline_unix_ms": 9999999999999,
                        "stop_grace_ms": 500}
        h = hashlib.sha256()
        for key in ("principal_ref", "session_ref", "request_key"):
            value = self.command[key].encode()
            h.update(len(value).to_bytes(8, "big"))
            h.update(value)
        self.ref = "exec-" + h.hexdigest()
        self.directory = self.root / self.ref
        self.directory.mkdir(mode=0o700)
        self.executor = {"executor_ref": "remote", "node_ref": "executor-node", "root_device": 1,
                         "root_inode": 2, "worker_sha256": "a" * 64, "endpoint_config_sha256": "c" * 64}
        command = dict(self.command)
        command["executor"] = self.executor
        request = {"mode": "remote_start", "request": command}
        payload = hashlib.sha256(encoded(request)).hexdigest()
        remote_request = {"mode": "start", "request": self.command}
        command_hash = hashlib.sha256(encoded(remote_request)).hexdigest()
        self.receipt = {"execution_ref": self.ref, "node_ref": "executor-node", "tree_complete": True,
                        "process_may_be_running": False, "exit_code": 0}
        self.record = {"schema_version": 1, "execution_ref": self.ref, "node_ref": "controller-node",
                       "principal_ref": "p", "session_ref": "session", "request_key": "request",
                       "request": request, "payload_hash": payload, "process": None, "observed_members": [],
                       "receipt": self.receipt, "finalization_pending": False}
        self.rule = {"execution_ref": self.ref, "principal": "p", "session_ref": "session", "request_key": "request"}
        self.config = {"execution_root": str(self.root), "node_ref": "controller-node", "remote_executors": [self.executor]}
        handle = {"version": 1, "controller_node_ref": "controller-node", "executor_node_ref": "executor-node",
                  "executor_ref": "remote", "execution_ref": self.ref, "controller_payload_hash": payload,
                  "command_hash": command_hash, "worker_sha256": "a" * 64, "endpoint_config_sha256": "c" * 64,
                  "root_device": 1, "root_inode": 2, "deadline_unix_ms": self.command["deadline_unix_ms"],
                  "deadline_boot_ms": 1000, "boot_id": "boot", "nonce": "b" * 64}
        envelope = {"version": 1, "request_id": "d" * 64, "controller_node_ref": "controller-node",
                    "executor_node_ref": "executor-node", "executor_ref": "remote"}
        original = dict(envelope)
        original["operation"] = {"action": "reconcile", "handle": handle}
        remote_record = dict(self.record, node_ref="executor-node", payload_hash=command_hash, request=remote_request)
        response = dict(envelope)
        response["observation"] = {"handle": handle, "snapshot": {"record": remote_record},
                                   "source": {"execution_ref": self.ref, "executor_node": "executor-node",
                                              "request_digest": command_hash}}
        self.control = {"version": 1, "controller_node_ref": "controller-node", "execution_ref": self.ref,
                        "controller_payload_hash": payload, "start_dispatched": True, "start_permit": {},
                        "handle": handle, "observation": {"request": original, "response": response},
                        "terminal_observed_at_unix_ms": 1234}
        self.write(self.root / "store.json", {"schema_version": 1, "node_ref": "controller-node"})
        self.persist()

    def tearDown(self):
        self.temp.cleanup()

    def write(self, path, value):
        path.write_bytes(encoded(value))
        os.chmod(path, 0o600)

    def persist(self):
        self.write(self.directory / "record.json", self.record)
        self.write(self.directory / "receipt.json", self.receipt)
        self.write(self.directory / "remote-control.json", self.control)

    def test_accepts_only_correlated_remote_receipt(self):
        self.assertTrue(reader.execution(self.config, self.rule))

    def test_missing_remote_receipt_keeps_wait_asleep(self):
        self.record["receipt"] = None
        self.persist()
        self.assertFalse(reader.execution(self.config, self.rule))

    def test_finalization_failure_keeps_wait_asleep(self):
        self.record["finalization_pending"] = True
        self.persist()
        self.assertFalse(reader.execution(self.config, self.rule))

    def test_changed_executor_pin_is_not_a_local_fallback(self):
        config = copy.deepcopy(self.config)
        config["remote_executors"][0]["worker_sha256"] = "f" * 64
        with self.assertRaises(ValueError):
            reader.execution(config, self.rule)

    def test_replaced_handle_or_response_identity_is_blocked(self):
        # Durable JSON has independent objects even when the fixture initially
        # used one Python handle in several proof locations.
        original = json.loads(encoded(self.control))
        for field, value in [("root_inode", 3), ("nonce", "e" * 64), ("executor_node_ref", "controller-node")]:
            with self.subTest(field=field):
                self.control = copy.deepcopy(original)
                self.control["handle"][field] = value
                self.persist()
                with self.assertRaises(ValueError):
                    reader.execution(self.config, self.rule)
        self.control = copy.deepcopy(original)
        self.control["observation"]["response"]["request_id"] = "e" * 64
        self.persist()
        with self.assertRaises(ValueError):
            reader.execution(self.config, self.rule)

    def test_receipt_from_controller_node_is_not_remote_evidence(self):
        self.receipt["node_ref"] = "controller-node"
        self.persist()
        with self.assertRaises(ValueError):
            reader.execution(self.config, self.rule)

    def test_changed_command_bytes_and_foreign_principal_are_blocked(self):
        self.record["request"]["request"]["argv"] = ["/bin/false"]
        self.persist()
        with self.assertRaises(ValueError):
            reader.execution(self.config, self.rule)
        rule = dict(self.rule, principal="foreign")
        with self.assertRaises(ValueError):
            reader.execution(self.config, rule)

    def test_record_only_receipt_cannot_replace_durable_receipt(self):
        self.write(self.directory / "receipt.json", dict(self.receipt, exit_code=8))
        with self.assertRaises(ValueError):
            reader.execution(self.config, self.rule)


if __name__ == "__main__":
    unittest.main()
