#!/usr/bin/env python3
"""Plan sidebar metadata changes without controlling agent sessions."""
import argparse
import hashlib
import json
import sys
import time

MAX_BYTES = 1024 * 1024
MAX_ITEMS = 5000
TTL = 300
HARNESSES = {"codex", "zcode"}
BUSY = {"active", "running", "inProgress", "waiting", "waitingForInput",
        "waitingForApproval", "waitingForUserInput"}
QUIET = {"idle", "stopped", "completed", "interrupted", "failed"}

def ref(value):
    if not isinstance(value, dict):
        raise ValueError("session reference must be an object")
    fields = {k: value.get(k) for k in ("harness", "host", "id")}
    if fields["harness"] not in HARNESSES:
        raise ValueError("unsupported harness")
    if any(not isinstance(fields[k], str) or not fields[k].strip() or
           len(fields[k]) > 512 for k in fields):
        raise ValueError("invalid session reference")
    return fields

def key(value):
    return json.dumps(ref(value), sort_keys=True, separators=(",", ":"))

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True,
                                    separators=(",", ":")).encode()).hexdigest()

def items(value):
    if not isinstance(value, list) or len(value) > MAX_ITEMS:
        raise ValueError("inventory must be an array within the item budget")
    return value

def evidence(value):
    value = value if isinstance(value, dict) else {}
    receipt = value.get("receipt")
    return {"verified": value.get("verified") is True,
            "kind": value.get("kind") if value.get("kind") in
                    {"consumer", "userAccepted"} else None,
            "receipt": receipt if isinstance(receipt, str) and
                    0 < len(receipt) <= 512 else None}

def scope(snapshot):
    result, seen = [], set()
    for value in items(snapshot.get("contracts")):
        if not isinstance(value, dict):
            raise ValueError("contract must be an object")
        cid = value.get("id")
        if not isinstance(cid, str) or not cid or len(cid) > 512 or cid in seen:
            raise ValueError("invalid or duplicate contract ID")
        seen.add(cid)
        result.append({
            "id": cid, "scopeVerified": value.get("scopeVerified") is True,
            "outcome": value.get("outcome") if value.get("outcome") in
                {"complete", "pending", "unknown"} else "unknown",
            "owner": ref(value.get("owner")),
            "aliases": [ref(x) for x in items(value.get("aliases", []))],
            "children": [ref(x) for x in items(value.get("children", []))],
            "completionEvidence": evidence(value.get("completionEvidence")),
            "handoffEvidence": evidence(value.get("handoffEvidence")),
        })
    return sorted(result, key=lambda c: c["id"])

def completion(contract):
    e = contract["completionEvidence"]
    return (contract["scopeVerified"] and contract["outcome"] == "complete" and
            e["verified"] and e["receipt"] is not None and
            e["kind"] in {"consumer", "userAccepted"})

def fresh(session, now):
    observed = session.get("observedAt")
    return (session.get("access") == "available" and
            type(session.get("pinned")) is bool and
            type(observed) in (int, float) and
            0 <= now - observed <= TTL)

def quiet(session, now):
    return (fresh(session, now) and session.get("nativeStatus") in QUIET and
            "activeTurnId" in session and session["activeTurnId"] is None and
            session.get("queued") is False)

def plan(snapshot, now):
    if not isinstance(snapshot, dict) or snapshot.get("schemaVersion") != 1:
        raise ValueError("unsupported snapshot schema")
    contracts = scope(snapshot)
    sessions = {}
    for value in items(snapshot.get("sessions")):
        k = key(value)
        if k in sessions:
            raise ValueError("duplicate session reference")
        sessions[k] = value
    complete_inventory = (snapshot.get("inventoryComplete") is True and
                          snapshot.get("contractsComplete") is True)
    scope_payload = {"inventoryComplete": snapshot.get("inventoryComplete") is True,
                     "contractsComplete": snapshot.get("contractsComplete") is True,
                     "contracts": contracts}
    output = {"schemaVersion": 1, "createdAt": now,
              "scopeDigest": digest(scope_payload), "scope": scope_payload,
              "actions": [], "holds": []}
    membership = {}
    canonical_pending = set()
    for c in contracts:
        for r in [c["owner"], *c["aliases"], *c["children"]]:
            membership.setdefault(key(r), []).append(c)
        if not completion(c):
            canonical_pending.add(key(c["owner"]))
    proposals = {}
    def hold(r, reason):
        output["holds"].append({**ref(r), "reason": reason})
    def propose(r, pinned, reason, depends=None):
        k = key(r)
        action = {**ref(r), "pinned": pinned, "expectedPinned": not pinned,
                  "reason": reason}
        if depends is not None:
            action["dependsOn"] = ref(depends)
        proposals[k] = action

    if not complete_inventory:
        for c in contracts:
            hold(c["owner"], "incomplete-inventory-or-task-scope")
        return output

    for c in contracts:
        owner = sessions.get(key(c["owner"]))
        if not c["scopeVerified"]:
            hold(c["owner"], "unverified-task-scope")
            continue
        if not completion(c):
            if owner is None or not fresh(owner, now):
                hold(c["owner"], "owner-access-unavailable-or-stale")
                continue
            if not owner["pinned"]:
                propose(c["owner"], True, "current-unfinished-owner")
            handoff = c["handoffEvidence"]
            if c["outcome"] != "pending" or not handoff["verified"] or not handoff["receipt"]:
                for alias in c["aliases"]:
                    hold(alias, "replacement-handoff-unverified")
                continue
            for alias in c["aliases"]:
                ak = key(alias)
                if ak == key(c["owner"]):
                    continue
                s = sessions.get(ak)
                related = membership[ak]
                if ak in canonical_pending or any(not x["scopeVerified"] or
                        x["outcome"] == "unknown" or
                        (x["id"] != c["id"] and not completion(x)) for x in related):
                    hold(alias, "owns-other-unfinished-or-unknown-task")
                elif s is None or not quiet(s, now):
                    hold(alias, "alias-native-unavailable-active-queued-or-stale")
                elif s["pinned"]:
                    propose(alias, False, "verified-replacement-alias",
                            c["owner"])
        else:
            for r in [c["owner"], *c["aliases"], *c["children"]]:
                k = key(r)
                s = sessions.get(k)
                if not all(completion(x) for x in membership[k]):
                    hold(r, "also-belongs-to-unfinished-task")
                elif s is None or not quiet(s, now):
                    hold(r, "native-unavailable-active-queued-or-stale")
                elif s["pinned"]:
                    propose(r, False, "verified-consumer-completion")
    # Pinning preserves visibility and always precedes removal of aliases.
    output["actions"] = sorted(proposals.values(),
                               key=lambda a: (not a["pinned"], key(a)))
    return output

def verify(previous, snapshot, now):
    current = plan(snapshot, now)
    if previous.get("schemaVersion") != 1 or previous.get("scopeDigest") != current["scopeDigest"]:
        raise ValueError("task scope changed; regenerate the plan")
    allowed = {(key(a), a["pinned"]): a for a in current["actions"]}
    sessions = {key(x): x for x in snapshot["sessions"]}
    result = {**current, "actions": [], "alreadySatisfied": 0}
    for action in items(previous.get("actions")):
        k = key(action)
        desired = action.get("pinned")
        if type(desired) is not bool:
            raise ValueError("invalid planned pin")
        s = sessions.get(k)
        if s is not None and fresh(s, now) and s["pinned"] == desired:
            result["alreadySatisfied"] += 1
            continue
        a = allowed.get((k, desired))
        if a is None:
            result["holds"].append({**ref(action), "reason": "fresh-preconditions-changed"})
            continue
        dependency = a.get("dependsOn")
        owner = sessions.get(key(dependency)) if dependency else None
        if dependency and (owner is None or not fresh(owner, now) or not owner["pinned"]):
            result["holds"].append({**ref(action), "reason": "replacement-pin-not-read-back"})
            continue
        result["actions"].append(a)
    return result

def read(path):
    stream = sys.stdin.buffer if path == "-" else open(path, "rb")
    try:
        raw = stream.read(MAX_BYTES + 1)
    finally:
        if path != "-":
            stream.close()
    if len(raw) > MAX_BYTES:
        raise ValueError("input exceeds 1 MiB")
    return json.loads(raw)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("plan", "verify"))
    parser.add_argument("input")
    parser.add_argument("fresh", nargs="?")
    args = parser.parse_args()
    try:
        now = time.time()
        result = (plan(read(args.input), now) if args.mode == "plan" else
                  verify(read(args.input), read(args.fresh), now))
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    except (ValueError, TypeError, KeyError, OSError) as error:
        print(f"chat-triage: {error}", file=sys.stderr)
        return 2
    return 0

if __name__ == "__main__":
    sys.exit(main())
