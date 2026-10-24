#!/usr/bin/env python3
"""Seed the automation launch-policy document of a fleet node.

The node serves GET/PUT /api/automation/launch-policy from its autopilot state
directory (AGENT_HERDER_AUTOPILOT_STATE_DIR). Without a document the endpoint
answers 503 "Launch policy is not configured", and the dispatcher has no policy
to apply, so an automatic launch cannot be resolved at all.

The version of an applied policy is its etag: the sha256 of the exact bytes of
the document, exactly as launchPolicyEtag() computes it. The seed is therefore
deterministic - the same node inputs produce the same bytes and the same etag,
so the control plane can compare the etag it expects with the etag the node
reports. The document itself carries only the schema version (version: 1),
because the schema rejects every other field.

What the seed never does:
  * it never overwrites an existing document - an operator-edited policy is not
    deploy business;
  * it never writes a document that does not cover every policy harness of the
    node, because a partially covered policy would silently narrow what the
    node may launch;
  * it never carries the control plane's project routes - routes belong to a
    project and to the control node, not to a worker node.

minimax-code is not a harness of the launch policy (the policy knows codex,
opencode, zcode and the other adapter types), so a node that runs MiniMax Code
natively is covered through its other harnesses.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

# The harnesses the launch policy can allow, in a fixed order so that the seed
# bytes are identical on every node.
POLICY_HARNESSES = ("codex", "opencode", "zcode")
# The policy schema supports fallback models for these harnesses only.
FALLBACK_HARNESSES = ("opencode", "zcode")
DOCUMENT_NAME = "automation-launch-policy.json"
DEFAULT_MAP = Path(__file__).with_name("launch-policy.default.json")


def etag(raw: bytes) -> str:
    """The etag of a policy document, exactly as launchPolicyEtag() computes it."""
    return '"' + hashlib.sha256(raw).hexdigest()[:32] + '"'


def document_bytes(document: dict) -> bytes:
    """Serialize a policy document deterministically: same inputs, same bytes."""
    return (json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def build_document(node_harnesses, models, preferred=None, fallback_models=None):
    """Build the policy document of one node.

    Raises ValueError when the node cannot be covered completely: a partial
    policy would quietly narrow what the node is allowed to launch.
    """
    allowed = [harness for harness in POLICY_HARNESSES if harness in node_harnesses and harness in models]
    uncovered = [harness for harness in node_harnesses if harness in POLICY_HARNESSES and harness not in models]
    if uncovered:
        raise ValueError("no fleet model for the node harness(s): " + ", ".join(uncovered))
    if not allowed:
        raise ValueError("this node has no harness the launch policy can allow")
    chosen = preferred if preferred in allowed else allowed[0]
    document = {
        "version": 1,
        "allowedHarnesses": allowed,
        "preferredHarness": chosen,
        "models": {harness: models[harness] for harness in allowed},
    }
    if fallback_models:
        fallbacks = {}
        for harness in FALLBACK_HARNESSES:
            candidates = fallback_models.get(harness) or []
            if harness in allowed and candidates:
                fallbacks[harness] = list(candidates)
        if fallbacks:
            document["fallbackModels"] = fallbacks
    return document


def seed(state_dir, node_harnesses, models, preferred=None, fallback_models=None, force=False):
    """Write the policy document of a node when it is missing.

    Returns a receipt: seeded (bool), path, etag (the version of the applied
    policy) and sha256 of the exact bytes.
    """
    path = Path(state_dir) / "autopilot" / DOCUMENT_NAME
    if path.exists() and not force:
        raw = path.read_bytes()
        return {"seeded": False, "path": str(path), "etag": etag(raw), "sha256": hashlib.sha256(raw).hexdigest()}
    document = build_document(node_harnesses, models, preferred, fallback_models)
    raw = document_bytes(document)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    with open(temporary, "wb") as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    return {"seeded": True, "path": str(path), "etag": etag(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def load_models(source):
    """Read the fleet model map: a JSON file or an inline JSON object."""
    if source is None:
        source = DEFAULT_MAP
    text = Path(source).read_text() if os.path.exists(str(source)) else str(source)
    document = json.loads(text)
    models = document.get("models") if isinstance(document, dict) and "models" in document else document
    if not isinstance(models, dict) or not models:
        raise ValueError("the fleet model map is empty")
    return models, document


def default_models():
    """The fleet model map that ships with the deploy, and its document."""
    return load_models(None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", required=True, help="the node autopilot state directory")
    parser.add_argument("--node-config", help="node-config.json of the node")
    parser.add_argument("--models", help="path to a fleet model map, or an inline JSON object")
    parser.add_argument("--preferred", help="preferred harness of the node")
    parser.add_argument("--check", action="store_true", help="report the applied policy version without writing")
    parser.add_argument("--force", action="store_true", help="overwrite an existing document")
    arguments = parser.parse_args()

    models, document = load_models(arguments.models)
    harnesses = []
    if arguments.node_config:
        config = json.loads(Path(arguments.node_config).read_text())
        harnesses = config.get("harnesses") or []
    if not harnesses:
        raise SystemExit("the node harness set is unknown: pass --node-config")
    preferred = arguments.preferred or document.get("preferredHarness")
    fallback_models = document.get("fallbackModels") if isinstance(document, dict) else None

    path = Path(arguments.state_dir) / "autopilot" / DOCUMENT_NAME
    if arguments.check:
        if not path.exists():
            print(json.dumps({"present": False, "path": str(path)}))
            return 0
        raw = path.read_bytes()
        print(json.dumps({"present": True, "path": str(path), "etag": etag(raw),
                          "sha256": hashlib.sha256(raw).hexdigest()}))
        return 0

    receipt = seed(arguments.state_dir, harnesses, models, preferred, fallback_models, arguments.force)
    print(json.dumps(receipt))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print("launch-policy-seed: " + str(exc), file=sys.stderr)
        sys.exit(1)
