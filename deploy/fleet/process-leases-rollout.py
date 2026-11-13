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

TERMINAL = {"completed", "recovered_baseline", "recovered_candidate"}
CHANGED_COMPONENTS = ("core", "process_worker", "process_wait_reader", "resource_bridge")
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
                ("HERDER_V1_ENTRY", "HERDER_NATIVE_COMMAND", "HERDER_PROCESS_CONFIG", "HERDER_PROCESS_WORKER")}
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
    candidate.check_selector(selector, launcher, require_worker=False)
    selection, manifest = selected_manifest(selector)
    pair = {"compat": process_snapshot(compat_pid), "core": process_snapshot(core_pid)}
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
        if expected_cwd is not None and observed["cwd"] != expected_cwd:
            raise ValueError("runtime working directory changed")
        observed["argv_sha256"] = json_hash(observed.pop("argv"))
        observed["configuration_sha256"] = json_hash(observed.pop("selected_environment"))
    if pair["compat"]["cwd"] != pair["core"]["cwd"]:
        raise ValueError("compat and core working directories differ")
    return pair


def exact_identity(snapshot):
    return {key: snapshot[key] for key in ("pid", "boot_id", "start_ticks")}


def component_guard(git_dir, before, after):
    """Preserve composite components and apply main ancestry to each replacement."""
    if os.environ.get(main_guard.EMERGENCY_ENV):
        raise RuntimeError("this coordinator does not admit an emergency main override")
    migration = candidate.adapter_transition(before, after)
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
        for key in ("node_ref", "execution_root", "resources", "administrators"):
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
        if state.get("phase") not in TERMINAL or pointer.get("final_state_sha256") != candidate.digest(Path(pointer["job_dir"]) / "state.json"):
            raise ValueError("resolved occupancy has no exact terminal evidence")
    elif pointer.get("phase") != "active":
        raise ValueError("unknown rollout occupancy phase")
    return pointer


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
    if state["phase"] not in TERMINAL:
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
        if self.gate.fd is None and self.gate._bridge is None:
            raise RuntimeError("release execution guard is not continuously held")
        if operation == "install" and (
                candidate.digest(candidate.private_file(state["candidate"])) != state["selector_after_sha256"]
                or candidate.digest(candidate.private_file(Path(state["candidate"]).parent / "fixture/launch-v1-core.py"))
                    != state["launcher_after_sha256"]):
            raise RuntimeError("candidate changed after ancestry admission")


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
    if receipt.get("method") != "mcp_manage" or receipt.get("action") != "restart":
        raise ValueError("receipt is not the explicit typed child restart")
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
    for name in ("automation", "resource"):
        if not isinstance(indexed.get(name, {}).get("inputSchema"), dict):
            raise ValueError("consumer is missing the public " + name + " schema")
    if require_process:
        for value in ("process_completion", "reconcile_process", "cancel_execution"):
            if not schema_has_value(indexed["automation"]["inputSchema"], value):
                raise ValueError("running automation schema lacks " + value)
        if not schema_has_value(indexed["resource"]["inputSchema"], "bind"):
            raise ValueError("running resource schema lacks bind")
    return {"target": CONTROLLER, "ref": CHILD, "method": "mcp_tools",
            "provider_operation_id": receipt["provider_operation_id"],
            "observed_at_unix_ms": receipt["observed_at_unix_ms"], "schema_sha256": receipt["schema_sha256"]}


def record_receipt(args):
    state = read_state(args.job_dir)
    receipt = candidate.read_json(args.receipt)
    if state["phase"] in TERMINAL:
        raise ValueError("rollout is already resolved")
    if args.kind == "restart":
        validate_restart(state, receipt)
    else:
        validate_consumer(state, receipt, state.get("awaiting_restart_at_unix_ms", state["created_at_unix_ms"]),
                          require_process=args.kind != "baseline-consumer")
    name = {"restart": "restart-ack.json", "consumer": "consumer-receipt.json",
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
            "checkpoint_sha256": candidate.digest(Path(args.job_dir) / "state.json")}


def admit(args, gate):
    selector = candidate.private_file(args.selector)
    launcher = candidate.private_file(args.launcher)
    selection, baseline = selected_manifest(selector)
    new_selection, proposed = selected_manifest(args.candidate)
    checked = candidate.check_candidate(args.candidate, Path(args.candidate).parent / "fixture/launch-v1-core.py")
    before_pair = runtime_pair(selector, launcher, args.compat_pid, args.core_pid)
    gate.check()
    ancestry = component_guard(gate.proof["project"], baseline, proposed)
    gate.check()
    before_pair_again = runtime_pair(selector, launcher, args.compat_pid, args.core_pid)
    if before_pair_again != before_pair:
        raise ValueError("running baseline changed during admission")
    candidate.profile_transition(selection, new_selection, baseline, proposed)
    root = Path(args.job_dir)
    if not root.is_absolute() or root.parent.resolve(strict=True) != root.parent or root.exists():
        raise ValueError("new private job directory must have a canonical existing parent")
    with candidate.selector_lock(selector):
        existing = read_occupancy(selector)
        if existing and existing["phase"] != "resolved":
            raise RuntimeError("unresolved rollout occupancy requires reconciliation")
        if candidate.digest(selector) != args.expected_selector_sha256:
            raise ValueError("installed selector changed before admission")
        root.mkdir(mode=0o700)
        stamp = now_ms()
        state = {"schema": 1, "job_id": "rollout-" + uuid.uuid4().hex, "job_dir": str(root),
                 "phase": "admitted", "created_at_unix_ms": stamp, "updated_at_unix_ms": stamp,
                 "deadline_unix_ms": stamp + int(args.deadline_seconds * 1000),
                 "challenge": uuid.uuid4().hex, "coordinator": identity(os.getpid()),
                 "selector": str(selector), "launcher": str(launcher), "candidate": str(args.candidate),
                 "selector_before_sha256": candidate.digest(selector),
                 "launcher_before_sha256": candidate.digest(launcher),
                 "selector_after_sha256": candidate.digest(args.candidate),
                 "launcher_after_sha256": candidate.digest(Path(args.candidate).parent / "fixture/launch-v1-core.py"),
                 "baseline_manifest": selection["manifest"], "baseline_manifest_sha256": selection["manifest_sha256"],
                 "candidate_manifest": new_selection["manifest"], "candidate_manifest_sha256": checked["manifest_sha256"],
                 "baseline_runtime": before_pair, "component_ancestry": ancestry,
                 "adapter_migration_sha256": checked.get("adapter_migration_sha256"),
                 "proof_path": str(candidate.private_file(args.proof)),
                 "release_state": str(candidate.private_file(gate.state_path)),
                 "release_identity": {key: gate.proof[key] for key in ("project", "owner", "fence")},
                 "deployment_target": gate.target, "backup": str(args.backup)}
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
                gate.check()
                confirmed_pair = runtime_pair(Path(state["selector"]), Path(state["launcher"]),
                                              restart["compat_pid"], restart["core_pid"],
                                              expected_cwd=state["baseline_runtime"]["core"]["cwd"])
                if confirmed_pair != pair:
                    raise RuntimeError("runtime changed while verifying consumer readiness")
                save_state(state, phase="verified", final_runtime=pair, consumer_evidence=consumer,
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
    ledger = candidate.read_json(state["release_state"])
    evidence = {"observed_at_unix_ms": now_ms(), "outcome": args.outcome, "runtime": pair,
                "consumer": consumer, "consumer_receipt_sha256": candidate.digest(args.consumer_receipt)}
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
        save_state(state, phase="recovery_verified", recovery_evidence=evidence,
                   recovery_release_identity={key: proof[key] for key in ("project", "owner", "fence")})
    save_state(state, phase="recovered_candidate" if is_candidate else "recovered_baseline")
    resolve_occupancy(state)
    return status(args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    r = sub.add_parser("run")
    for name in ("candidate", "selector", "launcher", "backup", "job-dir", "proof"):
        r.add_argument("--" + name, type=Path, required=True)
    r.add_argument("--release-state", type=Path)
    r.add_argument("--target", type=Path, help="existing private deploymentTarget JSON")
    r.add_argument("--expected-selector-sha256", required=True)
    r.add_argument("--compat-pid", type=int, required=True)
    r.add_argument("--core-pid", type=int, required=True)
    r.add_argument("--deadline-seconds", type=int, default=600, choices=range(10, 1801), metavar="10..1800")
    s = sub.add_parser("status")
    s.add_argument("--job-dir", type=Path, required=True)
    a = sub.add_parser("record")
    a.add_argument("--job-dir", type=Path, required=True)
    a.add_argument("--kind", choices=("restart", "consumer", "baseline-consumer"), required=True)
    a.add_argument("--receipt", type=Path, required=True)
    c = sub.add_parser("recover")
    for name in ("job-dir", "proof", "consumer-receipt"):
        c.add_argument("--" + name, type=Path, required=True)
    c.add_argument("--outcome", choices=("baseline", "candidate"), required=True)
    c.add_argument("--compat-pid", type=int, required=True)
    c.add_argument("--core-pid", type=int, required=True)
    i = sub.add_parser("inspect")
    for name in ("selector", "launcher"):
        i.add_argument("--" + name, type=Path, required=True)
    i.add_argument("--compat-pid", type=int, required=True)
    i.add_argument("--core-pid", type=int, required=True)
    args = parser.parse_args()
    try:
        if args.command == "inspect":
            result = runtime_pair(args.selector, args.launcher, args.compat_pid, args.core_pid)
        else:
            result = {"run": run, "status": status, "record": record_receipt, "recover": recover}[args.command](args)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        # Do not echo proof contents, environment values or provider payloads.
        print(json.dumps({"status": "failed", "error_type": type(error).__name__, "error": str(error)}),
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
