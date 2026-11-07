import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from types import SimpleNamespace
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
    public_export_readiness,
    artifact_identity,
    public_common_export_status,
    search_marker_coverage,
    require_runner_route_compat,
    rpc_tool,
    task_delivery_receipt,
    validate_stand_isolation,
    validate_v1_public_contract,
    write_opencode_fixture,
)


class FakeRpc:
    def __init__(self):
        self.calls = []

    def request(self, method, params):
        self.calls.append((method, params))
        return {"resultType": "task", "taskId": "task-fixture"}


class AhapOpenCodeStandTest(unittest.TestCase):
    def test_artifact_identity_is_bound_to_manifest_and_runtime_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / "fixture"
            fixture.mkdir()
            paths = {}
            for name in ("core", "adapter", "opencode", "node", "bootstrap"):
                path = fixture / name
                path.write_bytes((name + "-fixture").encode())
                paths[name] = path
            manifest = {"core": str(paths["core"].resolve()),
                        "adapter": str(paths["adapter"].resolve()),
                        "opencode": str(paths["opencode"].resolve()),
                        "bootstrap": str(paths["bootstrap"].resolve()),
                        "node": str(paths["node"].resolve()),
                        "source_commit": "candidate-commit",
                        "sha256": {name: stand.sha256_file(paths[name])
                                   for name in ("core", "adapter", "opencode", "bootstrap", "node")}}
            (root / "manifest.json").write_text(json.dumps(manifest))
            args = SimpleNamespace(core=str(paths["core"]), runner=str(paths["adapter"]),
                                   opencode=str(paths["opencode"]), node=str(paths["node"]),
                                   bootstrap=str(paths["bootstrap"]))
            with patch("ahap_opencode_stand.subprocess.run",
                       return_value=SimpleNamespace(returncode=0, stdout="fixture-v1\n", stderr="")), \
                    patch.dict("os.environ", {"HERDER_ARTIFACT_STAGE": "candidate"}):
                identity = artifact_identity(args)
            self.assertEqual(identity["source_commit"], "candidate-commit")
            self.assertEqual(identity["stage"], "candidate")
            self.assertEqual(identity["manifest_sha256"], stand.hashlib.sha256(
                (root / "manifest.json").read_bytes()).hexdigest())
            paths["core"].write_bytes(b"different")
            with patch("ahap_opencode_stand.subprocess.run",
                       return_value=SimpleNamespace(returncode=0, stdout="fixture-v1\n", stderr="")):
                with self.assertRaisesRegex(ValueError, "core path/hash"):
                    artifact_identity(args)

    def test_v1_manifest_can_pin_external_opencode_separately(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / "fixture"
            fixture.mkdir()
            paths = {}
            for name in ("core", "adapter", "opencode", "node", "bootstrap"):
                path = fixture / name
                path.write_bytes((name + "-fixture").encode())
                paths[name] = path
            hashes = {name: stand.sha256_file(paths[name])
                      for name in ("core", "adapter", "node", "bootstrap")}
            manifest = {"core": str(paths["core"].resolve()),
                        "adapter": str(paths["adapter"].resolve()),
                        "bootstrap": str(paths["bootstrap"].resolve()),
                        "node": str(paths["node"].resolve()), "source_commit": "candidate-commit",
                        "sha256": hashes}
            (root / "manifest.json").write_text(json.dumps(manifest))
            args = SimpleNamespace(core=str(paths["core"]), runner=str(paths["adapter"]),
                                   opencode=str(paths["opencode"]), node=str(paths["node"]),
                                   bootstrap=str(paths["bootstrap"]))
            original_hash = stand.sha256_file
            def pinned_hash(path):
                return (stand.PINNED_NATIVE_OPENCODE_SHA256 if Path(path) == paths["opencode"]
                        else original_hash(path))
            with patch("ahap_opencode_stand.sha256_file", side_effect=pinned_hash), \
                    patch("ahap_opencode_stand.subprocess.run",
                       return_value=SimpleNamespace(returncode=0, stdout="fixture-v1\n", stderr="")):
                identity = artifact_identity(args)
            self.assertEqual(identity["identity_status"], "complete")
            self.assertEqual(identity["opencode_sha256"], stand.PINNED_NATIVE_OPENCODE_SHA256)

    def test_public_native_export_requires_lossless_bytes_and_complete_source(self):
        raw = b'{"messages":[{"role":"user","text":"marker"}]}'
        result = {"structuredContent": {"bytes_base64": stand.base64.b64encode(raw).decode(),
                    "complete": True, "source": {"harness": "opencode", "session_id": "native-1"}}}
        readiness = public_export_readiness(result)
        self.assertEqual(readiness["status"], "confirmed")
        self.assertEqual(readiness["payload_length_bytes"], len(raw))
        self.assertEqual(readiness["_payload_bytes"], raw)
        self.assertEqual(public_export_readiness({"structuredContent": {
            "bytes_base64": "%%%", "complete": True, "source": "opencode"}})["status"],
            "unverified")
        self.assertEqual(public_export_readiness({"structuredContent": {
            "bytes_base64": stand.base64.b64encode(raw).decode(),
            "complete": False, "source": "opencode"}})["status"], "unverified")

    def test_public_common_export_requires_explicit_no_effect_unsupported(self):
        result = {
            "isError": True,
            "structuredContent": {
                "code": "unsupported",
                "effect": "none",
                "message": "operation is not connected",
            },
        }
        readiness = public_common_export_status(result)
        self.assertEqual(readiness["status"], "unsupported")
        self.assertTrue(readiness["expected"])
        self.assertEqual(readiness["receipt"]["effect"], "none")

    def test_public_export_readiness_keeps_unknown_and_error_distinct(self):
        self.assertEqual(public_export_readiness({})["status"], "unknown")
        self.assertEqual(public_export_readiness({"isError": True})["status"], "error")

    def test_v1_public_contract_requires_projects_native_export_and_search(self):
        def tool(name, actions, properties=None):
            schema_properties = {"action": {"enum": actions}}
            schema_properties.update(properties or {})
            return {"name": name, "inputSchema": {"properties": schema_properties}}
        catalog = [tool("discover", ["nodes", "projects"]),
                   tool("deliver", ["session"]), tool("search", ["search"]),
                   tool("export", ["export"], {"format": {"enum": ["native", "common"]}})]
        validate_v1_public_contract(catalog)
        with self.assertRaisesRegex(RuntimeError, "V1 public MCP contract missing"):
            validate_v1_public_contract(catalog[:1])

    def test_v1_public_contract_accepts_nested_or_non_enumerated_tool_schemas_for_wire_probe(self):
        catalog = [{"name": name, "inputSchema": {"oneOf": [{"type": "object"}]}}
                   for name in ("discover", "deliver", "search", "export")]
        audit = validate_v1_public_contract(catalog)
        self.assertEqual(audit["discover"]["action"], "not-enumerated")
        nested = [{"name": "discover", "inputSchema": {"oneOf": [
            {"properties": {"action": {"const": "projects"}}}]}}]
        self.assertEqual(stand._schema_field_literals(nested[0]["inputSchema"], "action"),
                         {"projects"})

    def test_search_requires_marker_and_complete_coverage(self):
        self.assertEqual(search_marker_coverage({"structuredContent": {
            "hits": [{"excerpt": "marker-123"}], "coverage": "complete"}},
            "marker-123")["status"], "confirmed")
        self.assertEqual(search_marker_coverage({"structuredContent": {
            "hits": [{"excerpt": "marker-123"}], "coverage": "partial"}},
            "marker-123")["status"], "unverified")
        self.assertEqual(search_marker_coverage({"structuredContent": {
            "query": "marker-123", "hits": [], "coverage": "complete"}},
            "marker-123")["status"], "unverified")

    def test_task_delivery_receipt_extracts_only_unique_confirmed_receipt(self):
        task = {"result": {"structuredContent": {"deliver": {
            "native_receipt_id": "msg-exact", "outcome": "confirmed"}}}}
        self.assertEqual(task_delivery_receipt(task)["native_receipt_id"], "msg-exact")
        task["result"]["structuredContent"]["other"] = {
            "native_receipt_id": "msg-other", "outcome": "confirmed"}
        self.assertIsNone(task_delivery_receipt(task))

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

    def test_native_completion_reader_ignores_trailing_idle_and_matches_exact_receipt(self):
        rows = {"data": [
            {"id": "msg_user_exact", "role": "user", "parts": [{"text": "fixture marker"}]},
            {"id": "msg_assistant", "role": "assistant", "parentID": "msg_user_exact",
             "finish": "stop", "time": {"completed": 1234},
             "parts": [{"text": "HERDER_TEST_MODEL_OK"}]},
            {"id": "msg_idle", "role": "idle", "time": {"completed": None}},
        ]}
        pair = completed_message_pair(rows, "fixture marker", "msg_user_exact")
        self.assertEqual(pair["status"], "confirmed")
        self.assertEqual(pair["user_message_id"], "msg_user_exact")
        self.assertEqual(pair["assistant_parent_id"], "msg_user_exact")
        self.assertEqual(pair["assistant_message_id"], "msg_assistant")
        self.assertEqual(pair["assistant_finish"], "stop")
        rows["data"][1]["time"]["completed"] = 0
        self.assertIsNone(completed_message_pair(rows, "fixture marker", "msg_user_exact"))

    def test_native_completion_reader_rejects_a_different_user_receipt_id(self):
        rows = {"data": [
            {"id": "msg_user_exact", "role": "user", "parts": [{"text": "fixture marker"}]},
            {"id": "msg_assistant", "role": "assistant", "parentID": "msg_user_exact",
             "finish": "stop", "time": {"completed": 1234},
             "parts": [{"text": "HERDER_TEST_MODEL_OK"}]},
            {"id": "msg_idle", "role": "idle"},
        ]}
        pair = completed_message_pair(rows, "fixture marker", "different_receipt")
        self.assertEqual(pair["status"], "receipt_mismatch")

    def test_native_completion_reader_matches_versioned_message_receipt(self):
        rows = {"data": [
            {"id": "msg_user_exact", "role": "user", "parts": [{"text": "fixture marker"}]},
            {"id": "msg_assistant", "role": "assistant", "parentID": "msg_user_exact",
             "finish": "stop", "time": {"completed": 1234},
             "parts": [{"text": "HERDER_TEST_MODEL_OK"}]},
            {"id": "msg_idle", "role": "idle"},
        ]}
        receipt = "ahap-receipt:v1:" + json.dumps(
            {"kind": "message", "native_id": "msg_user_exact"}, separators=(",", ":"))
        pair = completed_message_pair(rows, "fixture marker", receipt)
        self.assertEqual(pair["status"], "confirmed")
        self.assertEqual(pair["user_message_id"], "msg_user_exact")

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
