"""Offline acceptance fixtures. No native runtime, network, or model is used."""
import argparse
import base64
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("process_lease_canary", Path(__file__).with_name("process_lease_canary.py"))
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)

SESSION = "session:qa"
NATIVE = "sess_qa"
MARKER = "RESUMED_QA exit=0"


def native_message(ident, role, text="", parent=None, types=None):
    info = {"messageId": ident, "role": role, "sessionId": NATIVE}
    if parent is not None:
        info["parentMessageId"] = parent
    parts = [{"type": kind, **({"text": text} if kind == "text" else {})} for kind in (types or ["text"])]
    return {"info": info, "parts": parts}


def export(messages):
    raw = json.dumps({"session": {"sessionId": NATIVE}, "messages": messages}).encode()
    return {"session_ref": SESSION, "format": "native", "encoding": "base64", "complete": True,
            "source": qa.NATIVE_EXPORT_SOURCE, "timestampCoverage": "native",
            "bytes_base64": base64.b64encode(raw).decode()}


def successful_rows():
    return qa.parse_native_export(export([
        native_message("msg_user", "user", "wake"),
        native_message("msg_answer", "assistant", MARKER, "msg_user", ["step-start", "reasoning", "text", "step-finish"]),
    ]), SESSION, NATIVE)[1]


class ExportTests(unittest.TestCase):
    def test_complete_native_ids_parent_and_accounting_parts_are_preserved(self):
        user = native_message("msg_user", "user", "wake")
        user["info"].update(anchor={"sourceCommandId": "agent-herder:auto:original"}, metadata={"inputId": "input_original"})
        proof, rows = qa.parse_native_export(export([user, native_message("msg_answer", "assistant", MARKER, "msg_user",
                                                                        ["step-start", "text", "step-finish"])]), SESSION, NATIVE)
        self.assertEqual(proof["scope"], "current_native_conversation")
        self.assertEqual(proof["message_count"], 2)
        self.assertEqual(rows[0]["sourceCommandId"], "agent-herder:auto:original")
        self.assertEqual(rows[0]["inputId"], "input_original")
        self.assertEqual(rows[1]["parentMessageId"], "msg_user")
        self.assertEqual(rows[1]["part_types"], ["step-start", "text", "step-finish"])
        self.assertEqual(rows[1]["nativeMessageId"], "msg_answer")

    def test_tail_or_truthy_complete_never_counts_as_full_history(self):
        for complete in (False, None, "true", 1):
            with self.subTest(complete=complete):
                value = export([]); value["complete"] = complete
                with self.assertRaisesRegex(RuntimeError, "incomplete_or_misbound"):
                    qa.parse_native_export(value, SESSION, NATIVE)

    def test_wrong_canonical_target_native_target_or_source_is_rejected(self):
        variants = []
        value = export([]); value["session_ref"] = "session:foreign"; variants.append(value)
        value = export([]); value["source"] = dict(qa.NATIVE_EXPORT_SOURCE, location="bounded tail"); variants.append(value)
        value = export([]); value["timestampCoverage"] = "none"; variants.append(value)
        value = export([]); value["bytes_base64"] = base64.b64encode(json.dumps({"session": {"sessionId": "foreign"}, "messages": []}).encode()).decode(); variants.append(value)
        for value in variants:
            with self.subTest(value=value):
                with self.assertRaises(RuntimeError):
                    qa.parse_native_export(value, SESSION, NATIVE)

    def test_no_synthetic_or_duplicate_message_identity_fallback(self):
        for rows in ([native_message("generated-1", "user")],
                     [native_message("msg_same", "user"), native_message("msg_same", "assistant")]):
            with self.subTest(rows=rows):
                with self.assertRaises(RuntimeError):
                    qa.parse_native_export(export(rows), SESSION, NATIVE)
        row = native_message("msg_user", "user"); del row["info"]["messageId"]
        with self.assertRaisesRegex(RuntimeError, "identity_missing"):
            qa.parse_native_export(export([row]), SESSION, NATIVE)

    def test_invalid_base64_json_and_unbounded_messages_fail_closed(self):
        for encoded in ("!!!", base64.b64encode(b"not json").decode()):
            value = export([]); value["bytes_base64"] = encoded
            with self.assertRaisesRegex(RuntimeError, "invalid_native_export_encoding"):
                qa.parse_native_export(value, SESSION, NATIVE)
        with self.assertRaisesRegex(RuntimeError, "unavailable_or_unbounded"):
            qa.parse_native_export(export([native_message("msg_x", "user")] * 10001), SESSION, NATIVE)


class ReplyCountTests(unittest.TestCase):
    def test_exact_receipt_parent_and_one_reply_allow_accounting_metadata(self):
        proof = qa.verify_reply_rows(successful_rows(), [], "msg_user", MARKER, ["msg_answer"])
        self.assertEqual(proof["native_user_ids"], ["msg_user"])
        self.assertEqual(proof["native_parent_message_id"], "msg_user")
        self.assertIn("step-finish", proof["native_part_types"]["msg_answer"])

    def test_one_matching_marker_cannot_hide_a_second_assistant_turn(self):
        rows = successful_rows()
        rows.append({"id": "msg_extra", "role": "assistant", "text": "another turn", "parentMessageId": "msg_user", "part_types": ["text"]})
        with self.assertRaisesRegex(RuntimeError, "unexpected_native_assistant_turns"):
            qa.verify_reply_rows(rows, [], "msg_user", MARKER, ["msg_answer"])

    def test_foreign_ack_extra_input_wrong_parent_and_lost_baseline_fail(self):
        for change in ("ack", "input", "parent", "baseline"):
            with self.subTest(change=change):
                rows = successful_rows(); baseline = []; ack = "msg_user"
                if change == "ack": ack = "msg_foreign"
                if change == "input": rows.append({"id": "msg_other", "role": "user", "text": "extra", "part_types": ["text"]})
                if change == "parent": rows[1]["parentMessageId"] = "msg_foreign"
                if change == "baseline": baseline = ["msg_missing"]
                with self.assertRaises(RuntimeError):
                    qa.verify_reply_rows(rows, baseline, ack, MARKER, ["msg_answer"])

    def test_real_tool_file_and_other_native_actions_are_not_accounting(self):
        for kind in ("tool", "file", "patch", "snapshot", "compaction", "subtask"):
            with self.subTest(kind=kind):
                rows = successful_rows(); rows[1]["part_types"].append(kind)
                with self.assertRaisesRegex(RuntimeError, "unexpected_native_tool_or_attachment"):
                    qa.verify_reply_rows(rows, [], "msg_user", MARKER, ["msg_answer"])


class Clock:
    def __init__(self): self.now = 0.0
    def monotonic(self): return self.now
    def time(self): return 1_700_000_000 + self.now
    def sleep(self, seconds): self.now += seconds


class StableIdleTests(unittest.TestCase):
    def run_wait(self, *, busy_at=None, gap_at=None, incomplete=False):
        clock = Clock()
        client = mock.Mock(state={"session_ref": SESSION, "native_session_id": NATIVE, "kind": "zcode"})
        def listing(*args):
            native = {"id": NATIVE, "harness": "zcode", "status": "running" if clock.now == busy_at else "idle", "needsPermission": False}
            return {"native_coverage_complete": not incomplete, "sessions": [{"session_ref": SESSION, "native": native}]}
        client.call.side_effect = listing
        gapped = False
        def read(*args):
            nonlocal gapped
            if clock.now == gap_at and not gapped:
                clock.now += 6; gapped = True
            return {"complete": True}, successful_rows()
        with mock.patch.object(qa, "messages", side_effect=read), \
                mock.patch.object(qa.time, "monotonic", side_effect=clock.monotonic), \
                mock.patch.object(qa.time, "time", side_effect=clock.time), \
                mock.patch.object(qa.time, "sleep", side_effect=clock.sleep):
            return qa.wait_marker(client, SESSION, MARKER, timeout=45), clock

    def test_requires_at_least_fifteen_seconds_and_fresh_samples(self):
        proof, clock = self.run_wait()
        self.assertGreaterEqual(clock.now, 15)
        self.assertGreaterEqual(proof["idle_window_ms"], 15000)
        self.assertLessEqual(proof["max_observation_gap_ms"], 5000)
        self.assertGreaterEqual(proof["idle_observation_count"], 8)

    def test_busy_sample_resets_continuous_idle_window(self):
        proof, clock = self.run_wait(busy_at=4)
        self.assertGreaterEqual(clock.now, 21)
        self.assertEqual(proof["idle_observed_from_unix_ms"], 1_700_000_006_000)

    def test_a_gap_above_five_seconds_cannot_count_as_observed_idle(self):
        proof, clock = self.run_wait(gap_at=8)
        self.assertGreaterEqual(clock.now, 29)
        self.assertGreaterEqual(proof["idle_window_ms"], 15000)
        self.assertEqual(proof["idle_observed_from_unix_ms"], 1_700_000_014_000)

    def test_incomplete_native_status_never_claims_idle(self):
        with self.assertRaisesRegex(TimeoutError, "no resend"):
            self.run_wait(incomplete=True)


class ReaderAdmissionTests(unittest.TestCase):
    def test_unsupported_harness_and_missing_review_stop_before_effect(self):
        for kind in ("codex", "opencode", "chatgpt", "zai", "hermes", "zcode"):
            with self.subTest(kind=kind), mock.patch.object(qa, "effect") as effect:
                client = mock.Mock()
                for function in (qa.session_start, qa.run_process):
                    with self.assertRaisesRegex(RuntimeError, "unsupported_native_acceptance"):
                        function(client, Path("/unused"), {"kind": kind, "effects": {}})
                effect.assert_not_called(); client.call.assert_not_called()

    def test_main_refuses_before_private_runtime_start(self):
        for action in ("start-session", "run-process", "reconcile-session", "observe", "preflight", "archive"):
            with self.subTest(action=action), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); qa.create(root / "checkpoint.json", {"kind": "opencode", "effects": {}, "status": "prepared"})
                with mock.patch.object(qa.sys, "argv", ["qa", "--root", str(root), "--action", action]), \
                        mock.patch.object(qa, "MCP") as runtime, contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaisesRegex(RuntimeError, "unsupported_native_acceptance"):
                        qa.main()
                    runtime.assert_not_called()

    def test_prepare_unsupported_reader_never_runs_bootstrap(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); artifact = base / "artifact"; artifact.write_bytes(b"not executable")
            manifest = {key: str(artifact) for key in ("core", "compat", "node", "bootstrap", "process_worker", "process_config")}
            manifest.update(sha256={key: qa.sha(artifact) for key in manifest}, source_commit="a" * 40)
            qa.create(base / "manifest.json", manifest)
            qa.create(base / "profile.json", {"owner": {"kind": "opencode"}})
            args = argparse.Namespace(root=base / "run", manifest=base / "manifest.json", profile=base / "profile.json")
            with mock.patch.object(qa.subprocess, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "unsupported_native_acceptance"):
                    qa.prepare(args)
                run.assert_not_called()

    def test_review_pins_source_release_and_actual_server_route(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); release = root / "release"; (release / "runtime").mkdir(parents=True)
            files = []
            for relative in ("runtime/node", "runtime/server-core.js", "runtime/zcode.cjs", "manifest.json"):
                path = release / relative; qa.create(path, b"fixture only")
                files.append({"path": str(path), "sha256": qa.sha(path)})
            expected = {"pid": 123, "boot_id": "fixture-boot", "start_ticks": "10", "entry": str(release / "runtime/server-core.js")}
            actual = {**expected, "state": "S", "uid": os.getuid(), "exe": str(release / "runtime/node"),
                      "agent_command": str(release / "runtime/node"),
                      "agent_args": [str(release / "runtime/zcode.cjs"), "app-server", "--stdio"]}
            proof = {"version": 1, "kind": "herder-zcode-native-history-source-review", "source_commit": "a" * 40,
                     "conclusion": {"read_route_suitable_for_qa": True, "hidden_default_message_limit": False, "not_a_tail_length_inference": True},
                     "installed_release": {"root": str(release), "files": files}, "observed_processes": [expected]}
            path = root / "proof.json"; qa.create(path, proof)
            reference = {"path": str(path), "sha256": qa.sha(path), "contract": qa.NATIVE_HISTORY_CONTRACT}
            owner = {"kind": "zcode", "node": os.uname().nodename,
                     "ahap_env": {"AHAP_ZCODE_TRANSPORT": "official-server", "AHAP_ZCODE_CREATE_MODEL": "provider/model"}}
            with mock.patch.object(qa, "native_server_observation", return_value=actual):
                self.assertEqual(qa.validate_history_proof("zcode", "a" * 40, owner, reference), reference)
                with self.assertRaisesRegex(RuntimeError, "unsupported_native_history_review"):
                    qa.validate_history_proof("zcode", "b" * 40, owner, reference)
                for key, value in (("start_ticks", "11"), ("agent_command", "node"), ("agent_args", ["foreign", "app-server", "--stdio"])):
                    changed = dict(actual, **{key: value})
                    with mock.patch.object(qa, "native_server_observation", return_value=changed):
                        with self.assertRaisesRegex(RuntimeError, "exact agent route changed"):
                            qa.validate_history_proof("zcode", "a" * 40, owner, reference)
                (release / "runtime/zcode.cjs").write_bytes(b"rotated")
                with self.assertRaisesRegex(RuntimeError, "file pin changed"):
                    qa.validate_history_proof("zcode", "a" * 40, owner, reference)


class RetryAndNoReplayTests(unittest.TestCase):
    @staticmethod
    def client(responses):
        client = qa.MCP.__new__(qa.MCP); client.rpc = mock.Mock(side_effect=responses)
        return client

    def test_only_exact_export_and_typed_no_effect_gate_refusal_retry(self):
        refusal = {"isError": True, "structuredContent": {"code": "scope_unavailable", "effect": "none"}}
        success = {"structuredContent": {"ok": True}}
        client = self.client([refusal, success])
        with mock.patch.object(qa.time, "sleep"):
            self.assertEqual(client.call("export", {"action": "export", "session_ref": SESSION, "format": "native"}), {"ok": True})
        self.assertEqual(client.rpc.call_count, 2)
        self.assertEqual(client.rpc.call_args_list[0], client.rpc.call_args_list[1])

    def test_wait_status_retries_but_mutations_or_unknown_never_do(self):
        refusal = {"isError": True, "structuredContent": {"code": "scope_unavailable", "effect": "none"}}
        client = self.client([refusal, {"structuredContent": {"complete": True}}])
        with mock.patch.object(qa.time, "sleep"):
            client.call("automation", {"action": "wait_status", "harness": "zcode", "native_session_id": NATIVE})
        self.assertEqual(client.rpc.call_count, 2)
        variants = [("create", {"action": "create"}, refusal),
                    ("automation", {"action": "create"}, refusal),
                    ("resource", {"action": "claim"}, refusal),
                    ("export", {"action": "export", "session_ref": SESSION, "format": "common"}, refusal),
                    ("export", {"action": "export", "session_ref": SESSION, "format": "native", "extra": True}, refusal)]
        for detail in ({"code": "scope_unavailable", "effect": "unknown"}, {"code": "other", "effect": "none"}):
            variants.append(("export", {"action": "export", "session_ref": SESSION, "format": "native"}, {"isError": True, "structuredContent": detail}))
        variants.append(("export", {"action": "export", "session_ref": SESSION, "format": "native"}, {"isError": True, "content": refusal["structuredContent"]}))
        for name, args, error in variants:
            with self.subTest(name=name, args=args, error=error):
                client = self.client([error])
                with self.assertRaises(RuntimeError): client.call(name, args)
                self.assertEqual(client.rpc.call_count, 1)

    def test_read_retry_has_a_deadline_and_timeout_is_not_retried(self):
        refusal = {"isError": True, "structuredContent": {"code": "scope_unavailable", "effect": "none"}}
        args = {"action": "export", "session_ref": SESSION, "format": "native"}
        client = self.client([refusal, refusal])
        with mock.patch.object(qa.time, "monotonic", side_effect=[0, 149, 150]), mock.patch.object(qa.time, "sleep"):
            with self.assertRaises(RuntimeError): client.call("export", args)
        self.assertEqual(client.rpc.call_count, 2)
        client = self.client([TimeoutError("unknown")])
        with self.assertRaises(TimeoutError): client.call("export", args)
        self.assertEqual(client.rpc.call_count, 1)

    def test_unknown_effect_is_durable_before_call_and_cannot_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); state = {"effects": {}}
            def uncertain(*args):
                persisted = json.loads((root / "checkpoint.json").read_text())
                self.assertEqual(persisted["effects"]["create_session"]["status"], "UNKNOWN")
                raise TimeoutError("ACK lost")
            client = mock.Mock(); client.call.side_effect = uncertain
            with self.assertRaises(TimeoutError):
                qa.effect(client, root, state, "create_session", "create", {"request_key": "original"})
            with self.assertRaisesRegex(RuntimeError, "no replay"):
                qa.effect(client, root, state, "create_session", "create", {"request_key": "new"})
            self.assertEqual(client.call.call_count, 1)

    def test_repeated_process_attempt_cannot_replace_original_baseline(self):
        state = {"status": "session_ready", "effects": {"resource_register": {"status": "UNKNOWN"}},
                 "before_wait_native": {"ids": ["msg_original"]}}
        with mock.patch.object(qa, "require_history_reader"), mock.patch.object(qa, "native_baseline") as baseline:
            with self.assertRaisesRegex(RuntimeError, "preserve the original baseline"):
                qa.run_process(mock.Mock(), Path("/unused"), state)
            baseline.assert_not_called()
            self.assertEqual(state["before_wait_native"], {"ids": ["msg_original"]})


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name); database = root / "authority.sqlite"
        self.owner = {"principal": "local-owner", "node": "roomhacker-server-100", "instance": "zcode-local"}
        profile = {"owner": self.owner, "database": str(database), "generation": "generation"}
        path = root / "profile.json"; qa.create(path, profile)
        self.state = {"profile": str(path), "profile_sha256": qa.sha(path), "database": str(database), "generation": "generation",
                      "session_ref": SESSION, "native_session_id": NATIVE,
                      "effects": {"create_session": {"request_key": "canary-zcode-0d398e19-v2-create"}}}
        with sqlite3.connect(database) as db:
            db.execute("CREATE TABLE intents(task_id TEXT,principal TEXT,target TEXT,state TEXT,native_receipt TEXT,request_key TEXT)")

    def insert(self, **changes):
        receipt = {"version": 1, "request_key": "process-wake:rule", "target_ref": SESSION, "principal": self.owner["principal"],
                   "address": {"instance": {"node": self.owner["node"], "instance_id": self.owner["instance"]}, "native_session_id": NATIVE},
                   "native_id": 'ahap-receipt:v1:{"kind":"message","native_id":"msg_user"}'}
        receipt.update(changes)
        with sqlite3.connect(self.state["database"]) as db:
            db.execute("INSERT INTO intents VALUES(?,?,?,?,?,?)", ("task", self.owner["principal"], SESSION, "confirmed", json.dumps(receipt), "process-wake:rule"))

    def test_initial_prompt_key_matches_retained_native_rust_receipt(self):
        self.assertEqual(qa.initial_prompt_key(self.state), "create-prompt:782a4a3d9263b0e2690f1847a710fd7597a48c57a9e0f04e8cf5a24dc85b672d")

    def test_exact_confirmed_wake_receipt_returns_native_user_id(self):
        self.insert()
        value = qa.exact_message_receipt(self.state, "process-wake:rule")
        self.assertEqual(value["message_id"], "msg_user")

    def test_foreign_receipt_address_or_unknown_cannot_prove_a_reply(self):
        self.insert(target_ref="session:foreign")
        with self.assertRaisesRegex(RuntimeError, "binding_mismatch"):
            qa.exact_message_receipt(self.state, "process-wake:rule")
        with sqlite3.connect(self.state["database"]) as db:
            db.execute("UPDATE intents SET state='unknown'")
        with self.assertRaisesRegex(RuntimeError, "delivery receipt missing"):
            qa.exact_message_receipt(self.state, "process-wake:rule")

    def test_ambiguous_receipts_never_select_the_first(self):
        self.insert(); self.insert()
        with self.assertRaisesRegex(RuntimeError, "delivery receipt missing"):
            qa.exact_message_receipt(self.state, "process-wake:rule")


if __name__ == "__main__":
    unittest.main()
