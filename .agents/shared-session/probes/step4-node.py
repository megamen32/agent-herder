#!/usr/bin/env python3
"""One action of the launch policy on one node. Read and write through the API of the node.

    python3 step4-node.py get     <base>
    python3 step4-node.py put     <base> <if-match> <base64-document>
    python3 step4-node.py confirm <base>
    python3 step4-node.py sha     <base> <path>

The answer is printed as one JSON line: the etag, the document or the
confirmation of the fleet, so the driver can compare the revisions of the
nodes without guessing.
"""
import base64
import hashlib
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


def request(base: str, method: str, path: str, body: bytes = None, headers: dict = None) -> dict:
    all_headers = {"Accept": "application/json"}
    if headers:
        all_headers.update(headers)
    if body is not None:
        all_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, data=body, method=method, headers=all_headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            return {
                "status": response.status,
                "etag": response.headers.get("etag"),
                "body": raw.decode("utf-8", "replace"),
            }
    except urllib.error.HTTPError as error:
        return {
            "status": error.code,
            "etag": error.headers.get("etag"),
            "body": error.read().decode("utf-8", "replace"),
        }
    except Exception as error:
        return {"status": 0, "etag": None, "body": "", "error": f"{type(error).__name__}: {error}"}


def main() -> int:
    action = sys.argv[1]
    base = sys.argv[2].rstrip("/")

    if action == "get":
        answer = request(base, "GET", "/api/automation/launch-policy")
        print(json.dumps({"action": action, "status": answer["status"], "etag": answer["etag"],
                          "body": answer["body"]}, ensure_ascii=False))
        return 0

    if action == "put":
        if_match = sys.argv[3]
        document = base64.b64decode(sys.argv[4])
        answer = request(base, "PUT", "/api/automation/launch-policy", document, {"If-Match": if_match})
        print(json.dumps({"action": action, "status": answer["status"], "etag": answer["etag"],
                          "body": answer["body"][:400]}, ensure_ascii=False))
        return 0

    if action == "confirm":
        answer = request(base, "GET", "/api/settings/fleet-confirmation")
        body = answer["body"]
        try:
            body = json.dumps(json.loads(body), ensure_ascii=False)
        except Exception:
            pass
        print(json.dumps({"action": action, "status": answer["status"], "body": body}, ensure_ascii=False))
        return 0

    if action == "sha":
        path = Path(sys.argv[3]).expanduser()
        digest = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
        print(json.dumps({"action": action, "path": str(path), "sha256": digest}, ensure_ascii=False))
        return 0

    print(json.dumps({"error": f"unknown action {action}"}))
    return 2


if __name__ == "__main__":
    sys.exit(main())
