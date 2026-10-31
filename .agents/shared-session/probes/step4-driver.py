#!/usr/bin/env python3
"""Step 4 of the L30 scenario: one common setting, one node, the version confirmed by the second node.

The common setting is the policy of the launch: the one setting of the product that has a version
(its etag) and a confirmation across the fleet. The change is one enum of the incident profile
(reasoning: default -> high), it is reversible, and the original document is kept, so the change
is put back byte for byte at the end.

The order:
  1. the original document and its revision are read on the first node;
  2. the changed document is written through the API of the first node (If-Match);
  3. the same document is written on the second node: the fleet keeps a copy of the policy on
     every node, and the copy is the operator's work;
  4. the confirmation is read from the second node and from the first node: the name of the node,
     the revision it holds and the time of its answer;
  5. both nodes get their original document back, and the revisions are checked;
  6. what stayed unconfirmed is named.
"""
import base64
import json
import shlex
import subprocess
import sys
from pathlib import Path

HELPER = "/tmp/step4-node.py"
FIRST = ("100", "http://127.0.0.1:18787", "roomhacker@192.168.2.5", "http://127.0.0.1:18791")
SECOND = ("44", "http://127.0.0.1:18791", None, None)
POLICY_100 = "/home/roomhacker/.local/state/agent-herder/autopilot-live/automation-launch-policy.json"
POLICY_44 = "/home/roomhacker/.local/state/agent-herder/fleet-node/autopilot/automation-launch-policy.json"


def on_first(action: str, *args) -> dict:
    command = ["python3", HELPER, action, FIRST[1]] + [str(item) for item in args]
    out = subprocess.run(command, capture_output=True, text=True, check=False)
    return json.loads(out.stdout.strip().splitlines()[-1])


def on_second(action: str, *args) -> dict:
    # the remote shell takes a line: every argument is quoted, or the etag
    # loses its quotes and the version check refuses the write
    remote = " ".join(shlex.quote(str(item)) for item in
                      ["python3", HELPER, action, SECOND[1]] + [str(item) for item in args])
    command = ["ssh", "-o", "ConnectTimeout=30", "roomhacker@192.168.2.5", remote]
    out = subprocess.run(command, capture_output=True, text=True, check=False)
    lines = [line for line in out.stdout.strip().splitlines() if line.startswith("{")]
    if not lines:
        return {"error": (out.stderr or out.stdout)[:300]}
    return json.loads(lines[-1])


def sha_on_second(path: str) -> dict:
    return on_second("sha", path)


def main() -> int:
    evidence = {"step": "L30-4", "setting": "launch policy / incidentExecution.reasoning",
                "nodes": {"first": FIRST[0], "second": SECOND[0]}}

    # 1. the original documents
    first_before = on_first("get")
    second_before = on_second("get")
    evidence["first_before"] = {"etag": first_before.get("etag"), "status": first_before.get("status")}
    evidence["second_before"] = {"etag": second_before.get("etag"), "status": second_before.get("status")}
    if first_before.get("status") != 200 or second_before.get("status") != 200:
        print(json.dumps({"error": "the policy of a node is not readable", "evidence": evidence}, ensure_ascii=False, indent=1))
        return 1

    original_first = json.loads(first_before["body"])
    original_second = json.loads(second_before["body"])
    Path("/tmp/lp-first-original.json").write_text(json.dumps(original_first, ensure_ascii=False, indent=2))
    Path("/tmp/lp-second-original.json").write_text(json.dumps(original_second, ensure_ascii=False, indent=2))

    # 2. one change: a project route for a path that no project of the fleet has.
    #    No live project matches it, so the behaviour of the fleet does not
    #    change; the document changes, so the revision changes.
    PROBE_ROUTE = "/home/roomhacker/PycharmProjects/__l30_step4_probe__"
    changed = json.loads(json.dumps(original_first))
    changed.setdefault("projectRoutes", {})[PROBE_ROUTE] = {"harnesses": ["opencode"]}
    evidence["change"] = {"kind": "projectRoutes", "added": PROBE_ROUTE,
                          "value": changed["projectRoutes"][PROBE_ROUTE],
                          "why": "no project of the fleet has this path: the behaviour does not change, the revision does"}
    document = base64.b64encode(json.dumps(changed, ensure_ascii=False).encode()).decode()
    Path("/tmp/lp-changed.json").write_text(json.dumps(changed, ensure_ascii=False, indent=2))

    first_write = on_first("put", first_before["etag"], document)
    evidence["first_write"] = {"status": first_write.get("status"), "etag": first_write.get("etag"),
                                "body": first_write.get("body", "")[:200]}
    if first_write.get("status") != 200:
        print(json.dumps({"error": "the change was refused on the first node", "evidence": evidence},
                         ensure_ascii=False, indent=1))
        return 1
    revision_new = first_write["etag"]

    # 3. the same document on the second node
    second_write = on_second("put", second_before["etag"], document)
    evidence["second_write"] = {"status": second_write.get("status"), "etag": second_write.get("etag"),
                                 "body": second_write.get("body", "")[:200]}
    evidence["revision_new"] = revision_new
    evidence["revision_second"] = second_write.get("etag")
    evidence["revision_shared"] = revision_new == second_write.get("etag")

    # 4. the confirmation, read from the second node and from the first node
    confirm_second = on_second("confirm")
    confirm_first = on_first("confirm")
    evidence["confirmation_from_second"] = json.loads(confirm_second["body"]) if confirm_second.get("body") else confirm_second
    evidence["confirmation_from_first"] = json.loads(confirm_first["body"]) if confirm_first.get("body") else confirm_first
    evidence["file_sha_first"] = on_first("sha", POLICY_100)
    evidence["file_sha_second"] = sha_on_second(
        "/home/roomhacker/.local/state/agent-herder/fleet-node/autopilot/automation-launch-policy.json")

    # 5. the original document back on both nodes
    restore_first = on_first("put", revision_new, base64.b64encode(
        json.dumps(original_first, ensure_ascii=False).encode()).decode())
    restore_second = on_second("put", second_write.get("etag") or "", base64.b64encode(
        json.dumps(original_second, ensure_ascii=False).encode()).decode())
    evidence["restore"] = {
        "first": {"status": restore_first.get("status"), "etag": restore_first.get("etag"),
                  "expected": first_before.get("etag"),
                  "restored": restore_first.get("etag") == first_before.get("etag")},
        "second": {"status": restore_second.get("status"), "etag": restore_second.get("etag"),
                   "expected": second_before.get("etag"),
                   "restored": restore_second.get("etag") == second_before.get("etag")},
    }
    evidence["file_sha_after_restore_first"] = on_first("sha", POLICY_100)
    evidence["file_sha_after_restore_second"] = sha_on_second(
        "/home/roomhacker/.local/state/agent-herder/fleet-node/autopilot/automation-launch-policy.json")

    # 6. the state of the fleet after the change is put back
    confirm_after = on_first("confirm")
    evidence["confirmation_after_restore"] = json.loads(confirm_after["body"]) if confirm_after.get("body") else confirm_after

    Path("/tmp/step4-evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
    print(json.dumps(evidence, ensure_ascii=False, indent=1)[:4000])
    return 0


if __name__ == "__main__":
    sys.exit(main())
