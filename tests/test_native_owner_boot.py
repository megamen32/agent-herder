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


class NativeOwnerBootTest(unittest.TestCase):
    def test_activate_uses_only_the_registered_mcp_readiness_methods(self):
        connection = Mock()
        handshake = {"id": 1, "result": {"protocolVersion": "2025-03-26"}}
        catalog = {"id": 2, "result": {"tools": [{"name": name} for name in ("discover", "session", "stop")]}}
        connection.getresponse.side_effect = [
            response(200, handshake, **{"Mcp-Session-Id": "fixture-session"}),
            response(204),
            response(200, catalog),
        ]

        boot.activate(connection, "fixture-bearer")

        calls = connection.request.call_args_list
        self.assertEqual([call.args[:2] for call in calls], [("POST", boot.ENDPOINT)] * 3)
        self.assertEqual([json.loads(call.args[2])["method"] for call in calls],
                         ["initialize", "notifications/initialized", "tools/list"])
        self.assertEqual(calls[-1].args[3]["Mcp-Session-Id"], "fixture-session")

    def test_refused_handshake_does_not_dispatch_a_second_request(self):
        connection = Mock()
        connection.getresponse.return_value = response(403)
        with self.assertRaisesRegex(ValueError, "HTTP 403"):
            boot.activate(connection, "fixture-bearer")
        connection.request.assert_called_once()

    def test_only_the_named_credential_is_read_from_a_protected_file(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.env"
            path.write_text(f"OTHER=unrelated\n{boot.BEARER_NAME}='fixture-bearer'\n")
            path.chmod(0o600)
            self.assertEqual(boot.read_bearer(path), "fixture-bearer")
            path.chmod(0o640)
            with self.assertRaisesRegex(ValueError, "unprotected"):
                boot.read_bearer(path)
