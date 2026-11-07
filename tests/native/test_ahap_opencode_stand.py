import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

import ahap_opencode_stand as stand
from ahap_opencode_stand import (
    completed_message_pair,
    detect_opencode_api_family,
    message_texts,
    native_api_read,
    native_session_for,
    parse_fresh_seed,
    probe_native_tools,
    require_runner_route_compat,
    rpc_tool,
    validate_stand_isolation,
    write_opencode_fixture,
)


class FakeRpc:
    def __init__(self):
        self.calls = []

    def request(self, method, params):
        self.calls.append((method, params))
        return {"resultType": "task", "taskId": "task-fixture"}


class AhapOpenCodeStandTest(unittest.TestCase):
    def test_preflight_uses_inline_metadata_without_legacy_initialize(self):
        class Client:
            def __init__(self):
                self.calls = []

            def request(self, method, params):
                self.calls.append((method, params))
                return {"tools": [{"name": "create"}, {"name": "session"}]}

        client = Client()
        names = probe_native_tools(client)
        self.assertEqual(names, ["create", "session"])
        self.assertEqual([method for method, _ in client.calls], ["tools/list"])
        meta = client.calls[0][1]["_meta"]
        self.assertEqual(meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28")
        self.assertIn("io.modelcontextprotocol/tasks",
                      meta["io.modelcontextprotocol/clientCapabilities"]["extensions"])

    def test_mcp_create_uses_task_capability_and_exact_tool_arguments(self):
        client = FakeRpc()
        args = {"action": "create", "instance_ref": "opencode-fixture",
                "prompt": "AHAP marker", "request_key": "request-once"}
        result = rpc_tool(client, "create", args)
        self.assertEqual(result["taskId"], "task-fixture")
        method, params = client.calls[0]
        self.assertEqual(method, "tools/call")
        self.assertEqual(params["name"], "create")
        self.assertEqual(params["arguments"], args)
        self.assertIn("io.modelcontextprotocol/tasks",
                      params["_meta"]["io.modelcontextprotocol/clientCapabilities"]["extensions"])

    def test_task_polling_does_not_repeat_mutation(self):
        class Tasks:
            def __init__(self):
                self.calls = []

            def request(self, method, params):
                self.calls.append(method)
                return {"status": "completed", "result": {"structuredContent": {}}}

        client = Tasks()
        from ahap_opencode_stand import task_get
        task_get(client, "task-fixture")
        self.assertEqual(client.calls, ["tasks/get"])

    def test_runner_protocol_choice_is_required_and_must_match_server(self):
        with self.assertRaises(TypeError):
            require_runner_route_compat("v2")
        require_runner_route_compat("v2", "v2")
        with self.assertRaisesRegex(RuntimeError, "runner.*v22.*server.*v2|runner.*v2.*server.*v22"):
            require_runner_route_compat("v2", "v22")
        with self.assertRaisesRegex(RuntimeError, "unknown.*runner|runner.*unknown"):
            require_runner_route_compat("v2", "unknown")

    def test_read_only_protocol_detection_matches_receipt_route_families(self):
        config = [{"path": "model", "type": "string"}, {"path": "agent", "type": "object"}]
        with patch("ahap_opencode_stand.native_api_read_detail", return_value=(200, config, True)):
            self.assertEqual(detect_opencode_api_family("http://127.0.0.1:4100"), "v2")
            with self.assertRaisesRegex(RuntimeError, "runner selected v22.*server v2"):
                require_runner_route_compat("v2", "v22")
        with patch("ahap_opencode_stand.native_api_read_detail", return_value=(200, None, True)):
            self.assertEqual(detect_opencode_api_family("http://127.0.0.1:4100"), "v22")
        with patch("ahap_opencode_stand.native_api_read_detail", side_effect=[
                (404, None, False), (200, {"healthy": True}, True)]):
            self.assertEqual(detect_opencode_api_family("http://127.0.0.1:4100"), "v22")
        with patch("ahap_opencode_stand.native_api_read_detail", side_effect=[
                (404, None, False), (200, None, True)]):
            with self.assertRaisesRegex(RuntimeError, "404 without verified v22 health"):
                detect_opencode_api_family("http://127.0.0.1:4100")

    def test_read_only_protocol_probe_retries_startup_503(self):
        with patch("ahap_opencode_stand.native_api_read_detail", side_effect=[
                (503, None, False), (200, [{"path": "model", "type": "string"}], True)]), patch("ahap_opencode_stand.time.sleep"):
            self.assertEqual(detect_opencode_api_family("http://127.0.0.1:4100"), "v2")

    def test_malformed_200_config_is_unknown_not_v22(self):
        class Response:
            status = 200

            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self, _limit): return b"{malformed"

        with patch("ahap_opencode_stand.urllib.request.urlopen", return_value=Response()):
            with self.assertRaisesRegex(RuntimeError, "unrecognized|malformed|unknown"):
                detect_opencode_api_family("http://127.0.0.1:4100")

    def test_runner_choice_comes_from_exact_artifact_initialize_without_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = Path(tmp) / "runner.py"
            calls = Path(tmp) / "calls.json"
            runner.write_text(
                "import json, pathlib, sys\n"
                "request=json.loads(sys.stdin.readline())\n"
                f"pathlib.Path({str(calls)!r}).write_text(json.dumps(request))\n"
                "print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':"
                "{'capabilities':{'nativeProtocol':'v22'}}}), flush=True)\n"
            )
            choice = stand.probe_runner_protocol(sys.executable, str(runner), {})
            self.assertEqual(choice, "v22")
            self.assertEqual(json.loads(calls.read_text())["method"], "initialize")

    def test_native_read_accepts_empty_or_non_json_success_body(self):
        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self, _limit):
                return b""

        with patch("ahap_opencode_stand.urllib.request.urlopen", return_value=Response()):
            self.assertEqual(native_api_read("http://127.0.0.1:4100", "/api/health"), (200, None))

    def test_owner_profile_never_falls_back_to_unprotected_provider_route(self):
        config = [{"path": "model", "type": "string"}]
        with patch("ahap_opencode_stand.native_api_read_detail", return_value=(200, config, True)):
            require_runner_route_compat(detect_opencode_api_family("http://127.0.0.1:4100"), "v2")
        with patch("ahap_opencode_stand.native_api_read_detail", return_value=(200, None, True)):
            with self.assertRaises(RuntimeError):
                require_runner_route_compat(detect_opencode_api_family("http://127.0.0.1:4100"), "v2")

    def test_fixture_project_config_points_only_to_loopback_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            write_opencode_fixture(project, "http://127.0.0.1:4567/v1")
            config = json.loads((project / "opencode.json").read_text())
            provider = config["provider"]["fixture"]
            self.assertEqual(provider["options"]["baseURL"], "http://127.0.0.1:4567/v1")
            self.assertEqual(config["model"], "fixture/herder-test")
            self.assertEqual(list(config["provider"]), ["fixture"])

    def test_native_session_mapping_is_read_only_and_exact(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "fixture.db"
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE session_bindings(session_ref TEXT, native_session_id TEXT)")
                connection.execute("INSERT INTO session_bindings VALUES (?, ?)", ("session:one", "ses_exact"))
            self.assertEqual(native_session_for(database, "session:one"), "ses_exact")
            with self.assertRaisesRegex(RuntimeError, "exact native"):
                native_session_for(database, "session:missing")

    def test_fresh_seed_requires_owner_only_files_in_authority_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            authority = root / "authority"
            authority.mkdir(mode=0o700)
            values = {}
            for name in ("state.db", "gate", "seed.json"):
                path = authority / name
                path.write_text("fixture")
                path.chmod(0o600)
                values[name] = str(path)
            seed = {"database": values["state.db"], "gate": values["gate"],
                    "profile_seed": values["seed.json"], "generation": "fresh-fixture"}
            self.assertEqual(parse_fresh_seed(json.dumps(seed), root), seed)
            escaped = dict(seed, gate=str(root / "outside"))
            (root / "outside").write_text("fixture")
            (root / "outside").chmod(0o600)
            with self.assertRaisesRegex(ValueError, "escaped"):
                parse_fresh_seed(json.dumps(escaped), root)

    def test_native_completion_pair_requires_terminal_assistant_and_exact_receipt_user(self):
        rows = {"data": [
            {"id": "msg_user_exact", "role": "user", "parts": [{"text": "fixture marker"}]},
            {"id": "msg_assistant", "role": "assistant", "parentID": "msg_user_exact",
             "finish": "stop", "time": {"completed": 1234},
             "parts": [{"text": "HERDER_TEST_MODEL_OK"}]},
        ]}
        with patch("ahap_opencode_stand.complete_native_readback", return_value=True):
            pair = completed_message_pair(rows, "fixture marker")
        self.assertEqual(pair["user_message_id"], "msg_user_exact")
        self.assertEqual(pair["assistant_parent_id"], "msg_user_exact")
        self.assertEqual(pair["assistant_finish"], "stop")
        rows["data"][1]["time"]["completed"] = 0
        with patch("ahap_opencode_stand.complete_native_readback", return_value=True):
            self.assertIsNone(completed_message_pair(rows, "fixture marker"))

    def test_transcript_projection_extracts_only_user_and_assistant_text(self):
        rows = {"page": {"messages": [
            {"role": "user", "text": "marker"},
            {"role": "assistant", "text": "HERDER_TEST_MODEL_OK"},
            {"role": "tool", "text": "ignored"},
        ]}}
        self.assertEqual(message_texts(rows), [
            ("user", "marker"), ("assistant", "HERDER_TEST_MODEL_OK")
        ])

    def test_requires_loopback_and_protected_project_root(self):
        validate_stand_isolation([{"ifname": "lo"}], [], [], "/herder-owner-home/work",
                                 "http://127.0.0.1:4500", "http://127.0.0.1:4600/v1")
        with self.assertRaisesRegex(ValueError, "loopback-only"):
            validate_stand_isolation([{"ifname": "eth0"}], [], [], "/herder-owner-home/work",
                                     "http://127.0.0.1:4500", "http://127.0.0.1:4600/v1")
        with self.assertRaisesRegex(ValueError, "protected fixture home"):
            validate_stand_isolation([{"ifname": "lo"}], [], [], "/tmp/project",
                                     "http://127.0.0.1:4500", "http://127.0.0.1:4600/v1")


if __name__ == "__main__":
    unittest.main()
