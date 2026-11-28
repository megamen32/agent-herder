import importlib.util
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock


SCRIPT = Path(__file__).resolve().parents[1] / "deploy/fleet/agent-herder-native-owner-boot.py"
SPEC = importlib.util.spec_from_file_location("native_owner_boot", SCRIPT)
boot = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(boot)


def response(status, body=None, **headers):
    reply = Mock(status=status)
    reply.getheader.side_effect = headers.get
    reply.read.return_value = json.dumps(body).encode() if body else b""
    return reply


def handshake_responses():
    return [
        response(200, {"id": 1, "result": {"protocolVersion": "2025-03-26"}},
                 **{"Mcp-Session-Id": "fixture-session"}),
        response(204),
    ]


def catalog_reply(*names, complete=True, status="completed", is_error=False):
    return {"id": 2, "result": {"isError": is_error, "structuredContent": {
        "status": status, "result": {"schema_complete": complete, "tool_names": list(names)},
    }}}


class NativeOwnerBootTest(unittest.TestCase):
    def test_activate_uses_registered_control_lookup_through_root_mcp(self):
        # A quorum follower can own the process while its scoped child catalog is absent.
        connection = Mock()
        connection.getresponse.side_effect = handshake_responses() + [
            response(200, catalog_reply("discover", "session", "stop")),
        ]

        boot.activate(connection, "fixture-bearer")

        calls = connection.request.call_args_list
        self.assertEqual([call.args[:2] for call in calls], [("POST", "/mcp")] * 3)
        payloads = [json.loads(call.args[2]) for call in calls]
        self.assertEqual([payload["method"] for payload in payloads],
                         ["initialize", "notifications/initialized", "tools/call"])
        self.assertEqual(payloads[-1]["params"]["name"], "exec")
        lookup = payloads[-1]["params"]["arguments"]["code"]
        self.assertIn("'control:roomhacker-server-100'", lookup)
        self.assertIn("'mcp_tools'", lookup)
        self.assertIn("ref: 'AgentHerder'", lookup)
        self.assertEqual(calls[-1].args[3]["Mcp-Session-Id"], "fixture-session")

    def test_failed_or_incomplete_lookup_cannot_report_ready(self):
        for reply in [
            catalog_reply("discover", "session", "stop", status="failed"),
            catalog_reply("discover", "session", "stop", is_error=True),
            catalog_reply("discover", "session", "stop", complete=False),
            catalog_reply("discover", "session"),
        ]:
            with self.subTest(reply=reply):
                connection = Mock()
                connection.getresponse.side_effect = handshake_responses() + [response(200, reply)]
                with self.assertRaises(boot.ReadinessFailure):
                    boot.activate(connection, "fixture-bearer")
                self.assertEqual(connection.request.call_count, 3)

    def test_upstream_failure_text_is_not_in_the_lookup_diagnostic(self):
        connection = Mock()
        reply = {"id": 2, "result": {"isError": True, "structuredContent": {
            "status": "failed", "error": "private upstream contents",
        }}}
        connection.getresponse.side_effect = handshake_responses() + [response(200, reply)]
        with self.assertRaises(boot.ReadinessFailure) as caught:
            boot.activate(connection, "fixture-bearer")
        self.assertEqual(str(caught.exception), "registered MCP catalog lookup did not complete")

    def test_refused_handshake_does_not_dispatch_a_second_request(self):
        connection = Mock()
        connection.getresponse.return_value = response(403)
        with self.assertRaisesRegex(ValueError, "HTTP 403"):
            boot.activate(connection, "fixture-bearer")
        connection.request.assert_called_once()

    def test_rpc_error_text_is_never_in_the_diagnostic(self):
        connection = Mock()
        connection.getresponse.return_value = response(200, {"id": 1, "error": {
            "code": -32000, "message": "private upstream contents", "data": {"private": "ignored"},
        }})
        with self.assertRaises(boot.ReadinessFailure) as caught:
            boot.activate(connection, "fixture-bearer")
        self.assertEqual(str(caught.exception), "initialize returned no MCP result (RPC -32000)")

    def test_only_the_named_credential_is_read_from_a_protected_file(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.env"
            path.write_text(f"OTHER=unrelated\n{boot.BEARER_NAME}='fixture-bearer'\n")
            path.chmod(0o600)
            self.assertEqual(boot.read_bearer(path), "fixture-bearer")
            path.chmod(0o640)
            with self.assertRaisesRegex(ValueError, "unprotected"):
                boot.read_bearer(path)
