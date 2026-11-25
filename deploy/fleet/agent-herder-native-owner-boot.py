#!/usr/bin/python3
"""Activate the configured Rust MCP child over the local GPTAdmin route."""

import http.client
import json
import os
from pathlib import Path
import shlex
import stat
import sys


ENV_FILE = Path("/etc/gptadmin/nodes/primary.env")
BEARER_NAME = "GPTADMIN_AVAILABILITY_MONITOR_MCP_BEARER"
ENDPOINT = "/server/shell-roomhacker-server-100-agentherder/mcp"
MAX_RESPONSE_BYTES = 1024 * 1024


def read_bearer(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)) as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise ValueError("unprotected GPTAdmin configuration")
        entries = [line.removeprefix(BEARER_NAME + "=") for line in source
                   if line.startswith(BEARER_NAME + "=")]
    if len(entries) != 1:
        raise ValueError("missing configured availability credential")
    words = shlex.split(entries[0], comments=True)
    if len(words) != 1 or not words[0] or any(ch.isspace() for ch in words[0]):
        raise ValueError("invalid configured availability credential")
    return words[0]


class ReadinessFailure(ValueError):
    """Only local method names, numeric statuses and fixed reason codes may be logged."""


def activate(connection, bearer):
    headers = {"Authorization": "Bearer " + bearer, "Content-Type": "application/json",
               "Accept": "application/json, text/event-stream"}

    def rpc(method, params, request_id=None):
        payload = {"jsonrpc": "2.0", "method": method, "params": params}
        if request_id is not None:
            payload["id"] = request_id
        connection.request("POST", ENDPOINT, json.dumps(payload), headers)
        response = connection.getresponse()
        if session_id := response.getheader("Mcp-Session-Id"):
            headers["Mcp-Session-Id"] = session_id
        body = response.read(MAX_RESPONSE_BYTES + 1)
        if response.status not in (200, 202, 204) or len(body) > MAX_RESPONSE_BYTES:
            raise ReadinessFailure(f"{method} refused or exceeded the read limit (HTTP {response.status})")
        if request_id is None:
            return None
        if "text/event-stream" in response.getheader("Content-Type", ""):
            body = b"\n".join(line[5:].strip() for line in body.splitlines() if line.startswith(b"data:"))
        try:
            reply = json.loads(body)
        except ValueError:
            raise ReadinessFailure(f"{method} returned invalid JSON") from None
        if not isinstance(reply, dict) or reply.get("id") != request_id:
            raise ReadinessFailure(f"{method} returned no matching MCP reply")
        if not isinstance(reply.get("result"), dict):
            error = reply.get("error")
            code = error.get("code") if isinstance(error, dict) else None
            suffix = f" (RPC {code})" if type(code) is int and -32768 <= code <= 32767 else ""
            raise ReadinessFailure(f"{method} returned no MCP result{suffix}")
        return reply["result"]

    initialized = rpc("initialize", {
        "protocolVersion": "2025-03-26", "capabilities": {},
        "clientInfo": {"name": "agent-herder-boot-readiness", "version": "1"},
    }, 1)
    if not initialized.get("protocolVersion"):
        raise ReadinessFailure("missing negotiated MCP protocol")
    headers["MCP-Protocol-Version"] = initialized["protocolVersion"]
    rpc("notifications/initialized", {})
    catalog = rpc("tools/list", {}, 2)
    names = {tool["name"] for tool in catalog["tools"]}
    if not {"discover", "session", "stop"} <= names:
        raise ReadinessFailure("tools/list is missing required Rust tools")


def main():
    connection = http.client.HTTPConnection("127.0.0.1", 9001, timeout=7)
    try:
        activate(connection, read_bearer(ENV_FILE))
    except ReadinessFailure as reason:
        print(f"Registered Agent Herder MCP is not ready: {reason}", file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, TypeError, AttributeError, http.client.HTTPException):
        print("Registered Agent Herder MCP is not ready", file=sys.stderr)
        return 1
    finally:
        connection.close()
    print("Registered Agent Herder MCP is ready")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
