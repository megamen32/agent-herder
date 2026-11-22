#!/usr/bin/env python3
"""Hold release ownership across a native selector switch and observed readiness.

Run as a bounded native task. Restart and tools/list are explicit typed ShellMCP
operations by the trusted operator. Receipts are separate from independently
verified process/configuration evidence. This program never restarts a child.
"""
import argparse
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import uuid

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).parent))
from release_gate import ReleaseGate
import main_guard

_loader = importlib.machinery.SourceFileLoader(
    "process_leases_candidate", str(Path(__file__).with_name("process-leases-candidate.py")))
_spec = importlib.util.spec_from_loader(_loader.name, _loader)
candidate = importlib.util.module_from_spec(_spec)
_loader.exec_module(candidate)

_scheduler_loader = importlib.machinery.SourceFileLoader(
    "process_leases_scheduler_readiness", str(Path(__file__).with_name("process-leases-scheduler-readiness.py")))
_scheduler_spec = importlib.util.spec_from_loader(_scheduler_loader.name, _scheduler_loader)
scheduler = importlib.util.module_from_spec(_scheduler_spec)
_scheduler_loader.exec_module(scheduler)

TERMINAL = {"completed", "recovered_baseline", "recovered_candidate"}
CHANGED_COMPONENTS = ("core", "process_worker", "process_wait_reader", "resource_bridge", "process_remote_bridge")
CONTROLLER = "shell:roomhacker-server-100"
CHILD = "AgentHerder"


def now_ms():
    return int(time.time() * 1000)


def json_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def identity(pid):
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
        raise ValueError("invalid process identity")
    proc = Path("/proc") / str(pid)
    values = (proc / "stat").read_text().rsplit(")", 1)[1].split()
    if values[0] in ("Z", "X", "x"):
        raise ProcessLookupError("process has exited")
    return {"pid": pid, "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "start_ticks": int(values[19])}


def identity_state(expected):
    try:
        return "live" if identity(expected["pid"]) == expected else "dead"
    except (FileNotFoundError, ProcessLookupError):
        return "dead"
    except (OSError, ValueError, KeyError, IndexError):
        return "unknown"


def process_snapshot(pid):
    before = identity(pid)
    proc = Path("/proc") / str(pid)
    if proc.stat().st_uid != os.getuid():
        raise ValueError("runtime process belongs to a different user")
    status = (proc / "status").read_text().splitlines()
    uid = next(line.split()[1:] for line in status if line.startswith("Uid:"))
    if any(int(value) != os.getuid() for value in uid):
        raise ValueError("runtime process credentials do not match")
    argv = [part.decode() for part in (proc / "cmdline").read_bytes().split(b"\0") if part]
    environment = dict(part.split(b"=", 1) for part in (proc / "environ").read_bytes().split(b"\0") if b"=" in part)
    # Only selected nonsecret configuration identities survive this read.
    selected = {key: environment.get(key.encode(), b"").decode() for key in
                ("HERDER_V1_ENTRY", "HERDER_NATIVE_COMMAND", "HERDER_PROCESS_CONFIG", "HERDER_PROCESS_WORKER",
                 "AGENT_HERDER_MIGRATION_EPOCH")}
    values = (proc / "stat").read_text().rsplit(")", 1)[1].split()
    result = {**before, "ppid": int(values[1]), "exe": os.readlink(proc / "exe"),
              "exe_sha256": candidate.digest(proc / "exe"), "argv": argv,
              "cwd": os.readlink(proc / "cwd"), "selected_environment": selected}
    if identity(pid) != before:
        raise ValueError("runtime process changed while being observed")
    return result


def selected_manifest(selector):
    selection = candidate.read_json(selector)
    path = candidate.private_file(selection["manifest"])
    if candidate.digest(path) != selection["manifest_sha256"]:
        raise ValueError("selected manifest digest mismatch")
    return selection, candidate.read_json(path)


def runtime_pair(selector, launcher, compat_pid, core_pid, expected_cwd=None):
    checked = candidate.check_selector(selector, launcher, require_worker=False)
    selection, manifest = selected_manifest(selector)
    if checked["manifest_sha256"] != selection["manifest_sha256"]:
        raise ValueError("native selection changed during runtime observation")
    pair = {"compat": process_snapshot(compat_pid), "core": process_snapshot(core_pid)}
    migration = checked["canonical_migration"]
    migration_epoch = migration["epoch"] if migration is not None else ""
    if pair["core"]["ppid"] != compat_pid or compat_pid == core_pid:
        raise ValueError("native core is not the exact selected compat child")
    tail = [part for path in selection["profiles"] for part in ("--trusted-owner-profile", path)]
    for key, observed in pair.items():
        if observed["exe"] != manifest[key] or observed["exe_sha256"] != manifest["sha256"][key]:
            raise ValueError("running " + key + " does not match its pinned artifact")
        if observed["argv"] != [manifest[key], *tail]:
            raise ValueError("running " + key + " does not use the exact trusted profiles")
        env = observed["selected_environment"]
        if env["HERDER_V1_ENTRY"] != str(selector) or env["HERDER_NATIVE_COMMAND"] != manifest["core"]:
            raise ValueError("runtime selects a different entry or native core")
        if env["HERDER_PROCESS_CONFIG"] != manifest.get("process_config", ""):
            raise ValueError("runtime selects a different process configuration")
        if env["HERDER_PROCESS_WORKER"] not in ("", manifest.get("process_worker", "")):
            raise ValueError("runtime worker override conflicts with the pinned configuration")
        if env["AGENT_HERDER_MIGRATION_EPOCH"] != migration_epoch:
            raise ValueError("native runtime migration epoch differs from its pinned configuration")
        if expected_cwd is not None and observed["cwd"] != expected_cwd:
            raise ValueError("runtime working directory changed")
        observed["argv_sha256"] = json_hash(observed.pop("argv"))
        observed["configuration_sha256"] = json_hash(observed.pop("selected_environment"))
    if pair["compat"]["cwd"] != pair["core"]["cwd"]:
        raise ValueError("compat and core working directories differ")
    return pair


def exact_identity(snapshot):
    return {key: snapshot[key] for key in ("pid", "boot_id", "start_ticks")}


def capture_drain(args):
    """Capture a live verified baseline before the operator disables the child."""
    selector = candidate.private_file(args.selector)
    launcher = candidate.private_file(args.launcher)
    output = Path(args.output)
    if not output.is_absolute() or output.parent.resolve(strict=True) != output.parent:
        raise ValueError("drain capture output must have a canonical private parent")
    with candidate.selector_lock(selector):
        before = runtime_pair(selector, launcher, args.compat_pid, args.core_pid)
        selection, _ = selected_manifest(selector)
        record = {"schema": 1, "kind": "native-drain-baseline", "capture_id": uuid.uuid4().hex,
                  "captured_at_unix_ms": now_ms(), "target": CONTROLLER, "ref": CHILD,
                  "selector": {"path": str(selector), "sha256": candidate.digest(selector)},
                  "launcher": {"path": str(launcher), "sha256": candidate.digest(launcher)},
                  "manifest": {"path": selection["manifest"], "sha256": selection["manifest_sha256"]},
                  "profiles": [{"path": path, "sha256": candidate.digest(candidate.private_file(path))}
                               for path in selection["profiles"]], "runtime": before}
        if runtime_pair(selector, launcher, args.compat_pid, args.core_pid) != before:
            raise ValueError("runtime changed during drain capture")
        for pin in [record["selector"], record["launcher"], record["manifest"], *record["profiles"]]:
            if candidate.digest(candidate.private_file(pin["path"])) != pin["sha256"]:
                raise ValueError("configuration changed during drain capture")
        candidate.create(output, candidate.encoded(record), 0o400)
    return {"baseline": str(output), "sha256": candidate.digest(output), "capture_id": record["capture_id"],
            "runtime": before, "effects": "none"}


def drain_evidence(baseline_pin, receipt_pin):
    raw = candidate.private_file(baseline_pin["path"]).read_bytes()
    receipt_raw = candidate.private_file(receipt_pin["path"]).read_bytes()
    if hashlib.sha256(raw).hexdigest() != baseline_pin["sha256"] or hashlib.sha256(receipt_raw).hexdigest() != receipt_pin["sha256"]:
        raise ValueError("native drain proof pin changed")
    baseline, receipt = json.loads(raw), json.loads(receipt_raw)
    stamp, observed = baseline.get("captured_at_unix_ms"), receipt.get("observed_at_unix_ms")
    if (baseline.get("schema") != 1 or baseline.get("kind") != "native-drain-baseline"
            or not re.fullmatch(r"[0-9a-f]{32}", baseline.get("capture_id", ""))
            or baseline.get("target") != CONTROLLER or baseline.get("ref") != CHILD
            or not isinstance(stamp, int) or isinstance(stamp, bool) or stamp <= 0
            or stamp > now_ms() + 5000):
        raise ValueError("native drain baseline is invalid")
    if (receipt.get("schema") != 1 or receipt.get("kind") != "native-drain"
            or receipt.get("baseline_sha256") != baseline_pin["sha256"]
            or receipt.get("method") != "mcp_manage" or receipt.get("action") != "disable"
            or receipt.get("disabled") is not True or receipt.get("target") != CONTROLLER or receipt.get("ref") != CHILD
            or not isinstance(observed, int) or isinstance(observed, bool) or observed < stamp or observed > now_ms() + 5000
            or not re.fullmatch(r"[A-Za-z0-9_:/.-]{8,240}", receipt.get("provider_operation_id", ""))):
        raise ValueError("native drain requires an exact typed disable receipt after capture")
    pair = baseline["runtime"]
    if set(pair) != {"compat", "core"} or pair["compat"]["pid"] == pair["core"]["pid"]:
        raise ValueError("native drain runtime pair is invalid")
    for role in ("compat", "core"):
        old = exact_identity(pair[role])
        if (not isinstance(old["pid"], int) or isinstance(old["pid"], bool) or old["pid"] <= 1
                or not isinstance(old["start_ticks"], int) or isinstance(old["start_ticks"], bool) or old["start_ticks"] <= 0
                or not isinstance(old["boot_id"], str) or not old["boot_id"]
                or identity_state(old) != "dead"):
            raise ValueError("old native runtime is still live or drain is unproved")
    return baseline, receipt, raw, receipt_raw


def drained_baseline(args):
    names = ("drained_baseline", "drained_baseline_sha256", "drain_receipt", "drain_receipt_sha256")
    values = [getattr(args, name, None) for name in names]
    if not any(value is not None for value in values):
        return None
    if any(value is None for value in values):
        raise ValueError("drained mode requires both exact proof paths and SHA256 pins")
    baseline_pin = {"path": str(values[0]), "sha256": values[1]}
    receipt_pin = {"path": str(values[2]), "sha256": values[3]}
    baseline, receipt, raw, receipt_raw = drain_evidence(baseline_pin, receipt_pin)
    selector, launcher = candidate.private_file(args.selector), candidate.private_file(args.launcher)
    selection, _ = selected_manifest(selector)
    candidate.check_selector(selector, launcher, require_worker=False)
    if (baseline["selector"] != {"path": str(selector), "sha256": args.expected_selector_sha256}
            or baseline["launcher"]["path"] != str(launcher)
            or baseline["manifest"] != {"path": selection["manifest"], "sha256": selection["manifest_sha256"]}
            or [pin["path"] for pin in baseline["profiles"]] != selection["profiles"]
            or baseline["runtime"]["compat"]["pid"] != args.compat_pid
            or baseline["runtime"]["core"]["pid"] != args.core_pid):
        raise ValueError("native drain baseline does not match this rollout")
    for pin in [baseline["selector"], baseline["launcher"], baseline["manifest"], *baseline["profiles"]]:
        if candidate.digest(candidate.private_file(pin["path"])) != pin["sha256"]:
            raise ValueError("native drain baseline configuration changed")
    return {"pair": baseline["runtime"], "baseline": baseline_pin, "receipt": receipt_pin,
            "baseline_bytes": raw, "receipt_bytes": receipt_raw, "provider_operation_id": receipt["provider_operation_id"]}


def verify_native_drain_state(state):
    proof = state.get("native_drain")
    if proof is None:
        return
    baseline, _, _, _ = drain_evidence(proof["baseline"], proof["receipt"])
    if baseline["runtime"] != state["baseline_runtime"]:
        raise ValueError("durable native drain does not match the admitted baseline")


def component_guard(git_dir, before, after):
    """Preserve composite components and apply main ancestry to each replacement."""
    if os.environ.get(main_guard.EMERGENCY_ENV):
        raise RuntimeError("this coordinator does not admit an emergency main override")
    migration = candidate.adapter_transition(before, after)
    if before.get("canonical_migration") is not None and after.get("canonical_migration") != before["canonical_migration"]:
        raise ValueError("existing canonical migration authority requires a separately reviewed transition")
    for key in ("compat", "node", "bootstrap", "remote_ahap_wrappers"):
        if before.get(key) != after.get(key):
            raise ValueError("unreviewed component replacement: " + key)
        if before.get("sha256", {}).get(key) != after.get("sha256", {}).get(key):
            raise ValueError("retained component hash changed: " + key)
    old_provenance = before.get("component_provenance", {})
    new_provenance = after.get("component_provenance", {})
    changed_provenance = {key + "_source_commit" for key in CHANGED_COMPONENTS}
    changed_provenance.update(("process_config_source_commit", "process_leases_base_manifest",
                               "process_leases_base_manifest_sha256"))
    if migration:
        changed_provenance.update(kind + "_source_commit" for kind in migration["adapters"])
    for key, value in old_provenance.items():
        if key not in changed_provenance and new_provenance.get(key) != value:
            raise ValueError("retained component provenance changed: " + key)
    if "process_config" in before:
        old_config = candidate.read_json(before["process_config"])
        new_config = candidate.read_json(after["process_config"])
        for key in ("node_ref", "execution_root", "resources", "administrators", "remote_executors"):
            if old_config.get(key) != new_config.get(key):
                raise ValueError("process authority migration requires separate review: " + key)
    source = after.get("process_leases_build", {}).get("source_commit")
    if not isinstance(source, str) or not main_guard.SHA_RE.fullmatch(source):
        raise ValueError("candidate has no immutable source provenance")
    base = ["git", "--git-dir", str(candidate.canonical(git_dir))]
    main_guard.fetch_main(base)
    main_guard.check_deployable(base, None, source, fetch=False)
    checked = []
    for key in CHANGED_COMPONENTS:
        if key not in after:
            if key in before:
                raise ValueError("candidate removed an installed component: " + key)
            continue
        if before.get(key) == after[key] and before.get("sha256", {}).get(key) == after["sha256"][key]:
            continue
        new_source = new_provenance.get(key + "_source_commit")
        if new_source != source:
            raise ValueError("replacement lacks exact source provenance: " + key)
        old_source = old_provenance.get(key + "_source_commit")
        if key in before and old_source is None:
            if old_provenance:
                raise ValueError("installed composite component provenance is unknown: " + key)
            old_source = before.get("source_commit")
        main_guard.check_deployable(base, old_source, new_source, fetch=False)
        checked.append({"component": key, "previous_source": old_source, "source": new_source})
    if migration:
        for kind, item in sorted(migration["adapters"].items()):
            main_guard.check_deployable(base, item["previous_source_commit"], item["source_commit"], fetch=False)
            checked.append({"component": "adapter:" + kind,
                            "previous_source": item["previous_source_commit"], "source": item["source_commit"]})
    return checked


def occupancy_path(selector):
    selector = Path(selector)
    return selector.parent / ("." + selector.name + ".process-leases-rollout.json")


def read_state(job_dir):
    root = candidate.private_directory(job_dir)
    state = candidate.read_json(root / "state.json")
    if state.get("schema") != 1 or state.get("job_dir") != str(root):
        raise ValueError("invalid durable rollout checkpoint")
    if not re.fullmatch(r"rollout-[a-f0-9]{32}", state.get("job_id", "")):
        raise ValueError("invalid durable rollout identity")
    return state


def read_occupancy(selector):
    path = occupancy_path(selector)
    if not path.exists():
        if path.is_symlink():
            raise ValueError("invalid occupancy link")
        return None
    pointer = candidate.read_json(path)
    if pointer.get("schema") != 1 or pointer.get("selector") != str(selector):
        raise ValueError("invalid durable rollout occupancy")
    state = read_state(pointer["job_dir"])
    if state["job_id"] != pointer["job_id"] or state["selector"] != str(selector):
        raise ValueError("rollout occupancy does not match its checkpoint")
    if pointer.get("phase") == "resolved":
        if (state.get("phase") not in TERMINAL and not canonical_reconciliation_valid(state)) or pointer.get("final_state_sha256") != candidate.digest(Path(pointer["job_dir"]) / "state.json"):
            raise ValueError("resolved occupancy has no exact terminal evidence")
    elif pointer.get("phase") != "active":
        raise ValueError("unknown rollout occupancy phase")
    return pointer


def canonical_reconciliation_valid(state):
    """A separate exact native receipt may settle occupancy, never rewrite UNKNOWN."""
    annotation = state.get("canonical_reconciliation")
    if state.get("phase") != "unknown" or not isinstance(annotation, dict):
        return False
    try:
        if (set(annotation) != {"version", "outcome", "receipt", "original_state"}
                or annotation["version"] != 1 or annotation["outcome"] not in ("candidate", "failed")):
            return False
        outcome = annotation["outcome"]

        def read_pin(pin, raw_bytes=False):
            if not isinstance(pin, dict) or set(pin) != {"path", "sha256"}:
                raise ValueError("invalid reconciliation pin")
            raw = candidate.private_file(pin["path"]).read_bytes()
            if hashlib.sha256(raw).hexdigest() != pin["sha256"]:
                raise ValueError("reconciliation pin changed")
            return raw if raw_bytes else json.loads(raw)

        original = read_pin(annotation["original_state"])
        if original != {key: value for key, value in state.items() if key != "canonical_reconciliation"}:
            return False
        receipt = read_pin(annotation["receipt"])
        if (receipt.get("version") != 1 or receipt.get("kind") != "herder-paired-rollout-reconciled-v1"
                or receipt.get("outcome") != outcome or receipt.get("complete") is not True
                or receipt.get("job_id") != state["job_id"] or receipt.get("original_state") != annotation["original_state"]):
            return False
        evidence = read_pin(receipt["evidence"])
        paired = read_pin(evidence["paired_proof"])
        native = read_pin(receipt["native_receipt"])
        guard = read_pin(evidence["guard_intent"])
        acknowledgement = receipt["native_acknowledgement"]
        if outcome == "failed" and not failed_reconciliation_evidence_valid(
                state, receipt, evidence, paired, native, acknowledgement, read_pin):
            return False
        return (evidence.get("kind") == "herder-project-release-reconciliation-v1"
            and evidence.get("outcome") == outcome and evidence.get("job_id") == state["job_id"]
            and evidence.get("job_dir") == state["job_dir"]
            and evidence.get("state") == {"path": str(Path(state["job_dir"]) / "state.json"), "sha256": annotation["original_state"]["sha256"]}
            and paired.get("kind") == ("herder-paired-rollout-reconciliation-v1" if outcome == "candidate"
                                      else "herder-paired-rollout-failed-reconciliation-v1")
            and paired.get("outcome") == outcome and paired.get("complete") is True
            and paired.get("job_id") == state["job_id"]
            and paired.get("original_state_snapshot") == annotation["original_state"]
            and paired.get("old_scheduler_identity") == state["scheduler_identity"]
            and native.get("kind") == ("herder-project-release-reconciliation-receipt-v1" if outcome == "candidate"
                                      else "herder-project-release-failed-reconciliation-receipt-v1")
            and native.get("outcome") == outcome and native.get("job_id") == state["job_id"]
            and native.get("evidence") == receipt["evidence"] and native.get("paired_proof") == evidence["paired_proof"]
            and native.get("guard") == guard and guard.get("fence") == state["release_identity"]["fence"]
            and native.get("original_binding_sha256") == evidence.get("binding_sha256")
            and acknowledgement.get("finished") is True and acknowledgement.get("reconciled") is True
            and acknowledgement.get("jobId") == state["job_id"]
            and acknowledgement.get("guardId") == guard.get("guard_id")
            and acknowledgement.get("evidenceSha256") == receipt["evidence"]["sha256"]
            and acknowledgement.get("receiptPath") == receipt["native_receipt"]["path"]
            and acknowledgement.get("receiptSha256") == receipt["native_receipt"]["sha256"]
            and acknowledgement.get("receiptRef") == guard["execution_ref"]
                + (":reconciled:" if outcome == "candidate" else ":failed-reconciled:") + receipt["native_receipt"]["sha256"])
    except (OSError, ValueError, KeyError, TypeError):
        return False


def failed_reconciliation_evidence_valid(state, receipt, evidence, paired, native, acknowledgement, read_pin):
    """A terminal failed acceptance settles occupancy without asserting health."""
    if (receipt.get("operational_readiness") is not False or paired.get("operational_readiness") is not False
            or acknowledgement.get("outcome") != "failed" or acknowledgement.get("operationalReadiness") is not False
            or "scheduler_consumer" in paired
            or receipt["native_receipt"]["path"] != evidence["guard_intent"]["path"].removesuffix(".intent.json") + ".failed-reconciliation.json"):
        return False
    failure = read_pin(paired["scheduler_failure"])
    observation = read_pin(failure["observation"])
    request = read_pin(failure["request_receipt"])
    effects = read_pin(paired["effect_completion"])
    body = read_pin(failure["body"], raw_bytes=True)
    before = paired["successor_scheduler_identity"]
    if (failure.get("version") != 1 or failure.get("kind") != "herder-canonical-runtime-failure-v1"
            or failure.get("outcome") != "failed" or failure.get("operational_readiness") is not False
            or failure.get("authenticated_request") is not True or failure.get("job_id") != state["job_id"]
            or failure.get("http_status") != 503 or failure.get("http_body_complete") is not True
            or failure.get("response") != {"error": "canonical_runtime_unavailable"}
            or hashlib.sha256(body).hexdigest() != failure.get("http_body_sha256")
            or json.loads(body) != failure["response"]
            or failure.get("before") != before or failure.get("after") != before
            or failure.get("reconciliation_plan") != paired["plan"]
            or failure.get("request", {}).get("endpoint") != scheduler.ENDPOINT
            or not re.fullmatch(r"[a-f0-9]{64}", failure.get("request", {}).get("challenge", ""))
            or request.get("plan") != paired["plan"] or request.get("request") != failure["request"]
            or request.get("before") != before or observation.get("request_receipt") != failure["request_receipt"]
            or observation.get("before") != before or observation.get("after") != before
            or observation.get("reconciliation_plan") != paired["plan"]
            or observation.get("http_status") != 503 or observation.get("http_body_complete") is not True
            or observation.get("body") != failure["body"] or observation.get("response") != failure["response"]
            or observation.get("error") != "observation_failed_ValueError"
            or effects.get("version") != 1 or effects.get("kind") != "herder-controlled-rollout-effects-terminal-v1"
            or effects.get("complete") is not True or effects.get("job_id") != state["job_id"]
            or effects.get("original_state_snapshot") != paired["original_state_snapshot"]):
        return False
    stamp, decided = failure.get("observed_at_unix_ms"), paired.get("validated_at_unix_ms")
    if (type(stamp) is not int or type(decided) is not int or not stamp <= decided <= stamp + 60000
            or evidence.get("validated_at_unix_ms") != decided
            or observation.get("observed_at_unix_ms") != stamp):
        return False
    # These private immutable pins retain the actual operation history, including
    # the local reaped install driver when provider retention has expired.
    for value in (failure["provider_result"], paired["native_provider_result"],
                  effects["native_restart"]["binding"], effects["native_restart"]["provider_result"],
                  effects["coordinator"]["provider_result"], effects["coordinator"]["driver"]):
        read_pin(value)
    for key, value in effects["install"].items():
        read_pin(value, raw_bytes=key == "driver_source")
    repair = effects.get("repair")
    if repair is not None:
        for value in repair.values():
            read_pin(value)
        terminal = read_pin(repair["receipt"])
        result = terminal.get("systemctl", {})
        if (terminal.get("job_id") != state["job_id"] or terminal.get("intent") != repair["intent"]
                or result.get("spawned") is not True or result.get("exit_code") != 0
                or result.get("signal") is not None or result.get("timed_out") is not False or result.get("error_code") is not None):
            return False
    consumer = read_pin(paired["native_consumer"])
    validate_consumer({**state, "challenge": failure["request"]["challenge"]}, consumer, stamp)
    return True


def save_state(state, **changes):
    path = Path(state["job_dir"]) / "state.json"
    previous = candidate.digest(path)
    current = read_state(state["job_dir"])
    if current != state:
        raise ValueError("durable rollout checkpoint changed concurrently")
    state.update(changes)
    state["updated_at_unix_ms"] = now_ms()
    candidate.replace(path, candidate.encoded(state), previous, 0o600)


def resolve_occupancy(state):
    if state["phase"] not in TERMINAL and not canonical_reconciliation_valid(state):
        raise ValueError("nonterminal rollout cannot release occupancy")
    selector = Path(state["selector"])
    with candidate.selector_lock(selector):
        pointer = read_occupancy(selector)
        if not pointer or pointer["phase"] != "active" or pointer["job_id"] != state["job_id"]:
            raise ValueError("rollout occupancy changed")
        pointer.update(phase="resolved", final_state_sha256=candidate.digest(Path(state["job_dir"]) / "state.json"),
                       resolved_at_unix_ms=now_ms())
        path = occupancy_path(selector)
        candidate.replace(path, candidate.encoded(pointer), candidate.digest(path), 0o600)


class MutationGuard:
    """In-process admission for the library-only candidate mutation functions."""
    def __init__(self, gate, state):
        self.gate, self.state = gate, state

    def assert_mutation_allowed(self, selector, operation):
        self.gate.check()
        if self.state.get("native_drain") is not None:
            if operation == "rollback":
                raise RuntimeError("drained migration cannot reactivate the legacy native runtime")
            verify_native_drain_state(self.state)
        expected_phase = {"install": "installing", "rollback": "rolling_back"}[operation]
        state = read_state(self.state["job_dir"])
        pointer = read_occupancy(selector)
        if state != self.state or state["phase"] != expected_phase:
            raise RuntimeError("rollout mutation is not the durable admitted phase")
        if exact_identity(state["coordinator"]) != identity(os.getpid()):
            raise RuntimeError("rollout mutation is not owned by this coordinator")
        if (not pointer or pointer["phase"] != "active" or pointer["job_id"] != state["job_id"]
                or state["selector"] != str(selector)):
            raise RuntimeError("rollout mutation has no durable occupancy")
        if self.gate.fd is None and self.gate._bridge is None and not getattr(self.gate, "_occupancy_disabled", False):
            raise RuntimeError("release execution guard is not continuously held")
        if operation == "install" and (
                candidate.digest(candidate.private_file(state["candidate"])) != state["selector_after_sha256"]
                or candidate.digest(candidate.private_file(Path(state["candidate"]).parent / "fixture/launch-v1-core.py"))
                    != state["launcher_after_sha256"]):
            raise RuntimeError("candidate changed after ancestry admission")
        # A native-only switch would leave an older TS scheduler free to wake a
        # sleeping agent. The exact installed TS service must already be sealed
        # in canonical mode before either selector mutation is admitted.
        scheduler.observe(state["scheduler_identity"])


def receipt_common(state, receipt, kind, minimum):
    if (receipt.get("schema") != 1 or receipt.get("kind") != kind
            or receipt.get("job_id") != state["job_id"] or receipt.get("challenge") != state["challenge"]):
        raise ValueError("operator receipt does not belong to this rollout")
    stamp = receipt.get("observed_at_unix_ms")
    if not isinstance(stamp, int) or isinstance(stamp, bool) or stamp < minimum or stamp > now_ms() + 5000:
        raise ValueError("operator receipt is stale or has an invalid timestamp")
    if not re.fullmatch(r"[A-Za-z0-9_:/.-]{8,240}", receipt.get("provider_operation_id", "")):
        raise ValueError("operator receipt requires an exact provider operation ID")
    if receipt.get("target") != CONTROLLER or receipt.get("ref") != CHILD:
        raise ValueError("operator receipt selects a different child or controller")


def validate_restart(state, receipt):
    receipt_common(state, receipt, "restart", state["awaiting_restart_at_unix_ms"])
    drained = state.get("native_drain")
    action = "enable" if drained is not None else "restart"
    if receipt.get("method") != "mcp_manage" or receipt.get("action") != action:
        raise ValueError("receipt is not the explicit typed child " + action)
    if drained is not None:
        verify_native_drain_state(state)
        if receipt.get("drain_receipt_sha256") != drained["receipt"]["sha256"]:
            raise ValueError("enable receipt does not bind the admitted native drain")
    for key in ("compat_pid", "core_pid"):
        value = receipt.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value <= 1:
            raise ValueError("restart receipt has no valid native PID")


def schema_has_value(schema, wanted):
    if isinstance(schema, dict):
        if schema.get("const") == wanted or wanted in schema.get("enum", []):
            return True
        return any(schema_has_value(value, wanted) for value in schema.values())
    if isinstance(schema, list):
        return any(schema_has_value(value, wanted) for value in schema)
    return False


def validate_consumer(state, receipt, minimum, require_process=True):
    receipt_common(state, receipt, "consumer", minimum)
    if receipt.get("method") != "mcp_tools":
        raise ValueError("consumer receipt is not a typed tools/list result")
    tools = receipt.get("tools")
    if not isinstance(tools, list) or not tools or receipt.get("schema_sha256") != json_hash(tools):
        raise ValueError("consumer schema receipt digest mismatch")
    names = [tool.get("name") for tool in tools if isinstance(tool, dict)]
    if len(names) != len(tools) or len(set(names)) != len(names):
        raise ValueError("consumer tool schemas are malformed or ambiguous")
    indexed = {tool["name"]: tool for tool in tools}
    for name in (("automation", "resource", "session", "deliver") if require_process else ("automation", "resource")):
        if not isinstance(indexed.get(name, {}).get("inputSchema"), dict):
            raise ValueError("consumer is missing the public " + name + " schema")
    if require_process:
        for value in ("process_completion", "reconcile_process", "cancel_execution", "timer", "session_completion", "wait_status"):
            if not schema_has_value(indexed["automation"]["inputSchema"], value):
                raise ValueError("running automation schema lacks " + value)
        if not schema_has_value(indexed["resource"]["inputSchema"], "bind"):
            raise ValueError("running resource schema lacks bind")
        if not schema_has_value(indexed["session"]["inputSchema"], "resolve"):
            raise ValueError("running session schema lacks resolve")
        if not schema_has_value(indexed["deliver"]["inputSchema"], "receipt"):
            raise ValueError("running deliver schema lacks receipt")
    return {"target": CONTROLLER, "ref": CHILD, "method": "mcp_tools",
            "provider_operation_id": receipt["provider_operation_id"],
            "observed_at_unix_ms": receipt["observed_at_unix_ms"], "schema_sha256": receipt["schema_sha256"]}


def validate_scheduler_consumer(state, receipt, minimum):
    return scheduler.validate_receipt(receipt, state["scheduler_identity"]["runtime"]["source_commit"],
        stage="consumer", expected=state["scheduler_identity"], challenge=state["challenge"],
        job_id=state["job_id"], minimum=minimum)


def record_receipt(args):
    state = read_state(args.job_dir)
    receipt = candidate.read_json(args.receipt)
    if state["phase"] in TERMINAL:
        raise ValueError("rollout is already resolved")
    if args.kind == "restart":
        validate_restart(state, receipt)
    elif args.kind == "scheduler":
        validate_scheduler_consumer(state, receipt,
            state.get("awaiting_restart_at_unix_ms", state["created_at_unix_ms"]))
    else:
        validate_consumer(state, receipt, state.get("awaiting_restart_at_unix_ms", state["created_at_unix_ms"]),
                          require_process=args.kind != "baseline-consumer")
    name = {"restart": "restart-ack.json", "consumer": "consumer-receipt.json",
            "scheduler": "scheduler-consumer.json",
            "baseline-consumer": "baseline-consumer-receipt.json"}[args.kind]
    path = Path(args.job_dir) / name
    data = candidate.encoded(receipt)
    if path.exists():
        if candidate.private_file(path).read_bytes() != data:
            raise ValueError("a different receipt already exists; reconcile the job")
    else:
        candidate.create(path, data)
    return {"status": "receipt_recorded", "job_id": state["job_id"], "kind": args.kind,
            "receipt_sha256": candidate.digest(path)}


def status(args):
    state = read_state(args.job_dir)
    pointer = read_occupancy(Path(state["selector"]))
    selector_hash = candidate.digest(candidate.private_file(state["selector"]))
    launcher_hash = candidate.digest(candidate.private_file(state["launcher"]))
    actual = (selector_hash, launcher_hash)
    baseline = (state["selector_before_sha256"], state["launcher_before_sha256"])
    selected = (state["selector_after_sha256"], state["launcher_after_sha256"])
    configuration = "baseline" if actual == baseline else "candidate" if actual == selected else "mixed_or_changed"
    return {"status": state["phase"], "job_id": state["job_id"], "job_dir": state["job_dir"],
            "coordinator": state["coordinator"], "coordinator_state": identity_state(state["coordinator"]),
            "deadline_unix_ms": state["deadline_unix_ms"], "challenge": state["challenge"],
            "configuration": configuration, "occupancy": pointer["phase"] if pointer else "missing",
            "requires_reconciliation": (not pointer or pointer["phase"] != "resolved") and
                (state["phase"] in TERMINAL or state["phase"] == "unknown" or identity_state(state["coordinator"]) != "live"),
            "restart_ack_recorded": (Path(args.job_dir) / "restart-ack.json").exists(),
            "consumer_receipt_recorded": (Path(args.job_dir) / "consumer-receipt.json").exists(),
            "scheduler_receipt_recorded": (Path(args.job_dir) / "scheduler-consumer.json").exists(),
            "checkpoint_sha256": candidate.digest(Path(args.job_dir) / "state.json"),
            **({"canonical_reconciliation": state["canonical_reconciliation"]}
               if canonical_reconciliation_valid(state) else {})}


def scheduler_source(git_dir, proposed, migration, receipt):
    source = proposed["process_leases_build"]["source_commit"]
    # An in-place native update keeps the already registered profiles. It
    # needs the same scheduler compatibility proof as a recovery handoff.
    if migration is not None and migration.get("kind") != "recovery":
        return source
    installed = receipt.get("response", {}).get("runtime", {}).get("source_commit")
    if installed == source or (installed is None and migration is None):
        # Without a pin to compare, require evidence for the candidate SHA.
        return source
    if not isinstance(installed, str) or not main_guard.SHA_RE.fullmatch(installed):
        raise ValueError("missing installed scheduler source")
    git = ["git", "--git-dir", str(git_dir)]
    # A Rust-only rollout can retain the separately pinned, running scheduler.
    # Require identical inputs outside native code, its release tools and tests.
    excluded = ["crates/herder", "tests", "docs", "bugs.md",
                "deploy/fleet/process-leases-candidate.py", "deploy/fleet/process-leases-rollout.py",
                "deploy/fleet/rollout-node.py", "deploy/fleet/process-leases-ts-runtime.py",
                "deploy/fleet/process-leases-adapters-test.py", "deploy/fleet/process-leases-rollout-test.py",
                # Operator tools added by #118 are outside the scheduler build.
                "deploy/fleet/rollout-recovery", "deploy/fleet/recovery_owner_update.py",
                "deploy/fleet/test_recovery_owner_update.py", "deploy/fleet/README.md"]
    paths = [":(top,exclude)" + path for path in excluded]
    if (subprocess.run(git + ["merge-base", "--is-ancestor", installed, source]).returncode
            or subprocess.run(git + ["diff", "--quiet", "--no-ext-diff", installed, source, "--", *paths]).returncode):
        raise ValueError("native recovery candidate changes installed scheduler inputs")
    return installed


def admit(args, gate):
    selector = candidate.private_file(args.selector)
    launcher = candidate.private_file(args.launcher)
    selection, baseline = selected_manifest(selector)
    new_selection, proposed = selected_manifest(args.candidate)
    checked = candidate.check_candidate(args.candidate, Path(args.candidate).parent / "fixture/launch-v1-core.py")
    drained = drained_baseline(args)
    before_pair = drained["pair"] if drained is not None else runtime_pair(selector, launcher, args.compat_pid, args.core_pid)
    gate.check()
    ancestry = component_guard(gate.proof["project"], baseline, proposed)
    gate.check()
    drained_again = drained_baseline(args) if drained is not None else None
    before_pair_again = drained_again["pair"] if drained_again is not None else runtime_pair(selector, launcher, args.compat_pid, args.core_pid)
    if drained_again != drained or before_pair_again != before_pair:
        raise ValueError("running baseline changed during admission")
    migration = candidate.profile_migration(selection, new_selection, baseline, proposed)
    # This proof is fresh but needs no native call: a newly installed canonical
    # TS service may safely fail closed while the old core lacks wait_status.
    proof_bytes, _ = scheduler.read_file(str(args.scheduler_proof))
    scheduler_receipt = json.loads(proof_bytes)
    scheduler_evidence = scheduler.validate_receipt(scheduler_receipt,
        scheduler_source(gate.proof["project"], proposed, migration, scheduler_receipt), stage="preflight")
    root = Path(args.job_dir)
    if not root.is_absolute() or root.parent.resolve(strict=True) != root.parent or root.exists():
        raise ValueError("new private job directory must have a canonical existing parent")
    with candidate.selector_lock(selector):
        existing = read_occupancy(selector)
        if existing and existing["phase"] != "resolved":
            raise RuntimeError("unresolved rollout occupancy requires reconciliation")
        if candidate.digest(selector) != args.expected_selector_sha256:
            raise ValueError("installed selector changed before admission")
        if drained is not None and drained_baseline(args) != drained:
            raise ValueError("native drain proof changed before admission")
        root.mkdir(mode=0o700)
        stamp = now_ms()
        state = {"schema": 1, "job_id": "rollout-" + uuid.uuid4().hex, "job_dir": str(root),
                 "phase": "admitted", "created_at_unix_ms": stamp, "updated_at_unix_ms": stamp,
                 "deadline_unix_ms": stamp + int(args.deadline_seconds * 1000),
                 "challenge": uuid.uuid4().hex + uuid.uuid4().hex, "coordinator": identity(os.getpid()),
                 "selector": str(selector), "launcher": str(launcher), "candidate": str(args.candidate),
                 "selector_before_sha256": candidate.digest(selector),
                 "launcher_before_sha256": candidate.digest(launcher),
                 "selector_after_sha256": candidate.digest(args.candidate),
                 "launcher_after_sha256": candidate.digest(Path(args.candidate).parent / "fixture/launch-v1-core.py"),
                 "baseline_manifest": selection["manifest"], "baseline_manifest_sha256": selection["manifest_sha256"],
                 "candidate_manifest": new_selection["manifest"], "candidate_manifest_sha256": checked["manifest_sha256"],
                 "baseline_runtime": before_pair, "component_ancestry": ancestry,
                 "profile_migration_sha256": checked.get("profile_migration_sha256"),
                 "scheduler_identity": scheduler_evidence["identity"],
                 "scheduler_preflight_evidence": scheduler_evidence,
                 "scheduler_preflight_sha256": hashlib.sha256(proof_bytes).hexdigest(),
                 "proof_path": str(candidate.private_file(args.proof)),
                 "release_state": str(candidate.private_file(gate.state_path)),
                 "release_identity": {key: gate.proof[key] for key in ("project", "owner", "fence")},
                 "deployment_target": gate.target, "backup": str(args.backup)}
        if drained is not None:
            baseline_copy, receipt_copy = root / "native-drain-baseline.json", root / "native-drain-receipt.json"
            candidate.create(baseline_copy, drained["baseline_bytes"], 0o400)
            candidate.create(receipt_copy, drained["receipt_bytes"], 0o400)
            state["native_drain"] = {"baseline": {"path": str(baseline_copy), "sha256": drained["baseline"]["sha256"]},
                                     "receipt": {"path": str(receipt_copy), "sha256": drained["receipt"]["sha256"]},
                                     "provider_operation_id": drained["provider_operation_id"]}
        candidate.create(root / "scheduler-preflight.json", proof_bytes, 0o400)
        candidate.create(root / "state.json", candidate.encoded(state))
        pointer = {"schema": 1, "job_id": state["job_id"], "job_dir": str(root),
                   "selector": str(selector), "phase": "active"}
        path = occupancy_path(selector)
        if existing:
            candidate.replace(path, candidate.encoded(pointer), candidate.digest(path), 0o600)
        else:
            candidate.create(path, candidate.encoded(pointer))
        return state


def observe_completion(state, gate):
    root = Path(state["job_dir"])
    while now_ms() < state["deadline_unix_ms"]:
        gate.check()
        restart_path, consumer_path = root / "restart-ack.json", root / "consumer-receipt.json"
        scheduler_path = root / "scheduler-consumer.json"
        if restart_path.exists():
            restart = candidate.read_json(restart_path)
            validate_restart(state, restart)
            if state["phase"] == "awaiting_restart":
                save_state(state, phase="awaiting_consumer", restart_operation_id=restart["provider_operation_id"])
            pair = runtime_pair(Path(state["selector"]), Path(state["launcher"]),
                                restart["compat_pid"], restart["core_pid"],
                                expected_cwd=state["baseline_runtime"]["core"]["cwd"])
            for key in ("compat", "core"):
                old = exact_identity(state["baseline_runtime"][key])
                if exact_identity(pair[key]) == old or identity_state(old) != "dead":
                    raise RuntimeError("old native runtime is still live or restart is unproved")
            if (candidate.digest(state["selector"]) != state["selector_after_sha256"]
                    or candidate.digest(state["launcher"]) != state["launcher_after_sha256"]):
                raise RuntimeError("installed configuration changed while waiting for readiness")
            if consumer_path.exists():
                receipt = candidate.read_json(consumer_path)
                consumer = validate_consumer(state, receipt, restart["observed_at_unix_ms"])
                if not scheduler_path.exists():
                    time.sleep(0.25)
                    continue
                scheduler_evidence = validate_scheduler_consumer(state, candidate.read_json(scheduler_path),
                                                                 restart["observed_at_unix_ms"])
                gate.check()
                confirmed_pair = runtime_pair(Path(state["selector"]), Path(state["launcher"]),
                                              restart["compat_pid"], restart["core_pid"],
                                              expected_cwd=state["baseline_runtime"]["core"]["cwd"])
                if confirmed_pair != pair:
                    raise RuntimeError("runtime changed while verifying consumer readiness")
                save_state(state, phase="verified", final_runtime=pair, consumer_evidence=consumer,
                           scheduler_consumer_evidence=scheduler_evidence,
                           scheduler_consumer_sha256=candidate.digest(scheduler_path),
                           restart_receipt_sha256=candidate.digest(restart_path),
                           consumer_receipt_sha256=candidate.digest(consumer_path))
                return
        time.sleep(0.25)
    raise TimeoutError("rollout observation deadline expired; restart must not be retried")


def run(args):
    selector = candidate.private_file(args.selector)
    candidate.private_file(args.proof)
    with candidate.selector_lock(selector):
        occupied = read_occupancy(selector)
        if occupied and occupied["phase"] != "resolved":
            raise RuntimeError("unresolved rollout occupancy requires reconciliation")
    target = candidate.read_json(args.target) if args.target else None
    state = None
    try:
        # __exit__ sends canonical finished only when the entire readiness path
        # completes normally. Any uncertain exit deliberately retains occupancy.
        with ReleaseGate(args.proof, args.release_state, target=target) as gate:
            state = admit(args, gate)
            save_state(state, phase="installing")
            result = candidate.install(args, guard=MutationGuard(gate, state))
            scheduler.observe(state["scheduler_identity"])
            save_state(state, phase="awaiting_restart", awaiting_restart_at_unix_ms=now_ms(),
                       install_receipt=result["rollback_receipt"])
            observe_completion(state, gate)
        save_state(state, phase="completed", finished_at_unix_ms=now_ms())
        resolve_occupancy(state)
        return status(args)
    except BaseException as error:
        if state is not None and state.get("phase") not in TERMINAL:
            try:
                save_state(state, phase="unknown", error_type=type(error).__name__,
                           reconciliation_required=True)
            except (OSError, ValueError, KeyError):
                pass
        raise


def recover(args):
    """Read actual state; legacy can settle, canonical UNKNOWN stays fenced."""
    state = read_state(args.job_dir)
    if state.get("native_drain") is not None and args.outcome == "baseline":
        raise ValueError("drained migration cannot reactivate the legacy native runtime")
    terminal = state["phase"] in TERMINAL
    pointer = read_occupancy(Path(state["selector"]))
    if terminal and pointer and pointer["phase"] == "resolved":
        return status(args)
    if identity_state(state["coordinator"]) != "dead":
        raise RuntimeError("recovery requires proof that the original coordinator is no longer live")
    selector = Path(state["selector"])
    with candidate.selector_lock(selector):
        pointer = read_occupancy(selector)
        if not pointer or pointer["phase"] != "active" or pointer["job_id"] != state["job_id"]:
            raise ValueError("recovery does not own the exact unresolved occupancy")
    is_candidate = args.outcome == "candidate"
    expected_s = state["selector_after_sha256"] if is_candidate else state["selector_before_sha256"]
    expected_l = state["launcher_after_sha256"] if is_candidate else state["launcher_before_sha256"]
    if candidate.digest(selector) != expected_s or candidate.digest(state["launcher"]) != expected_l:
        raise RuntimeError("recovery requires already settled exact configuration; no automatic rollback")
    pair = runtime_pair(selector, Path(state["launcher"]), args.compat_pid, args.core_pid,
                        expected_cwd=state["baseline_runtime"]["core"]["cwd"])
    receipt = candidate.read_json(args.consumer_receipt)
    consumer = validate_consumer(state, receipt, max(state["updated_at_unix_ms"], now_ms() - 60000),
                                 require_process=is_candidate)
    # Recovery cannot erase the paired-runtime requirement. A candidate needs
    # another actual gate query; a settled old core may lack that API, so its
    # canonical TS service is proved without a probe and remains fail closed.
    scheduler_receipt = candidate.read_json(args.scheduler_proof)
    scheduler_evidence = (validate_scheduler_consumer(state, scheduler_receipt,
        max(state["updated_at_unix_ms"], now_ms() - 60000)) if is_candidate else
        scheduler.validate_receipt(scheduler_receipt, state["scheduler_identity"]["runtime"]["source_commit"],
            stage="preflight", expected=state["scheduler_identity"], challenge=state["challenge"],
            minimum=max(state["updated_at_unix_ms"], now_ms() - 60000)))
    ledger = candidate.read_json(state["release_state"])
    evidence = {"observed_at_unix_ms": now_ms(), "outcome": args.outcome, "runtime": pair,
                "consumer": consumer, "consumer_receipt_sha256": candidate.digest(args.consumer_receipt),
                "scheduler": scheduler_evidence, "scheduler_proof_sha256": candidate.digest(args.scheduler_proof)}
    if terminal:
        expected_outcome = "baseline" if state["phase"] == "recovered_baseline" else "candidate"
        if args.outcome != expected_outcome:
            raise ValueError("terminal checkpoint records a different settled outcome")
        # completed is persisted only after the old guard acknowledges finished.
        # This repairs the final pointer-write window, never an UNKNOWN binding.
        save_state(state, terminal_pointer_recovery=evidence)
        resolve_occupancy(state)
        return status(args)
    if ledger.get("version") == 2 or ledger.get("canonical") is not None:
        # Bridge intentionally has no fresh-guard recovery bypass. Preserve this
        # evidence for exact reviewed canonical binding reconciliation.
        save_state(state, phase="unknown", recovery_evidence=evidence,
                   recovery_blocked="canonical_guard_binding_requires_reviewed_reconciliation")
        return {**status(args), "recovery_blocked": state["recovery_blocked"]}
    proof = candidate.read_json(args.proof)
    if proof.get("project") != state["release_identity"]["project"]:
        raise ValueError("recovery proof selects a different project")
    with ReleaseGate(args.proof, Path(state["release_state"]), target=state["deployment_target"]) as gate:
        gate.check()
        if runtime_pair(selector, Path(state["launcher"]), args.compat_pid, args.core_pid,
                        expected_cwd=state["baseline_runtime"]["core"]["cwd"]) != pair:
            raise RuntimeError("runtime changed during legacy reconciliation")
        if candidate.digest(selector) != expected_s or candidate.digest(state["launcher"]) != expected_l:
            raise RuntimeError("configuration changed during legacy reconciliation")
        scheduler.observe(state["scheduler_identity"])
        save_state(state, phase="recovery_verified", recovery_evidence=evidence,
                   recovery_release_identity={key: proof[key] for key in ("project", "owner", "fence")})
    save_state(state, phase="recovered_candidate" if is_candidate else "recovered_baseline")
    resolve_occupancy(state)
    return status(args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    r = sub.add_parser("run")
    for name in ("candidate", "selector", "launcher", "backup", "job-dir", "proof", "scheduler-proof"):
        r.add_argument("--" + name, type=Path, required=True)
    r.add_argument("--release-state", type=Path)
    r.add_argument("--target", type=Path, help="existing private deploymentTarget JSON")
    r.add_argument("--expected-selector-sha256", required=True)
    r.add_argument("--compat-pid", type=int, required=True)
    r.add_argument("--core-pid", type=int, required=True)
    r.add_argument("--drained-baseline", type=Path)
    r.add_argument("--drained-baseline-sha256")
    r.add_argument("--drain-receipt", type=Path)
    r.add_argument("--drain-receipt-sha256")
    r.add_argument("--deadline-seconds", type=int, default=600, choices=range(10, 1801), metavar="10..1800")
    s = sub.add_parser("status")
    s.add_argument("--job-dir", type=Path, required=True)
    a = sub.add_parser("record")
    a.add_argument("--job-dir", type=Path, required=True)
    a.add_argument("--kind", choices=("restart", "consumer", "baseline-consumer", "scheduler"), required=True)
    a.add_argument("--receipt", type=Path, required=True)
    c = sub.add_parser("recover")
    for name in ("job-dir", "proof", "consumer-receipt", "scheduler-proof"):
        c.add_argument("--" + name, type=Path, required=True)
    c.add_argument("--outcome", choices=("baseline", "candidate"), required=True)
    c.add_argument("--compat-pid", type=int, required=True)
    c.add_argument("--core-pid", type=int, required=True)
    i = sub.add_parser("inspect")
    for name in ("selector", "launcher"):
        i.add_argument("--" + name, type=Path, required=True)
    i.add_argument("--compat-pid", type=int, required=True)
    i.add_argument("--core-pid", type=int, required=True)
    d = sub.add_parser("capture-drain")
    for name in ("selector", "launcher", "output"):
        d.add_argument("--" + name, type=Path, required=True)
    d.add_argument("--compat-pid", type=int, required=True)
    d.add_argument("--core-pid", type=int, required=True)
    args = parser.parse_args()
    try:
        if args.command == "inspect":
            result = runtime_pair(args.selector, args.launcher, args.compat_pid, args.core_pid)
        else:
            result = {"run": run, "status": status, "record": record_receipt, "recover": recover, "capture-drain": capture_drain}[args.command](args)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        # Do not echo proof contents, environment values or provider payloads.
        print(json.dumps({"status": "failed", "error_type": type(error).__name__, "error": str(error)}),
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
