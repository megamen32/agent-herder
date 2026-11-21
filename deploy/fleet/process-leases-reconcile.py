#!/usr/bin/env python3
"""Reconcile one completed canonical rollout using the observed TS scheduler.

Reconciliation retains the original UNKNOWN checkpoint and resolves only its
exact native binding after fresh operational consumer evidence. The separate
TS repair commands authorize one fixed native-guarded restart and leave that
binding unresolved. Neither path installs, acquires a claim or changes a selector.
"""
import argparse
import copy
import ctypes
import errno
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import time
import types
import uuid

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
_spec = importlib.util.spec_from_file_location("reconcile_rollout", HERE / "process-leases-rollout.py")
rollout = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rollout)
candidate, readiness = rollout.candidate, rollout.scheduler
HASH = re.compile(r"[0-9a-f]{64}")
KIND = "herder-canonical-rollout-reconciliation-plan-v1"
REPAIR_KIND = "herder-canonical-ts-repair-plan-v1"
REPAIR_EVIDENCE_KIND = "herder-project-release-ts-repair-v1"
FAILED_PROOF_KIND = "herder-canonical-runtime-failure-v1"
FAILED_PAIRED_KIND = "herder-paired-rollout-failed-reconciliation-v1"
EFFECTS_KIND = "herder-controlled-rollout-effects-terminal-v1"
FAILED_PLAN_KIND = "herder-canonical-failed-reconciliation-plan-v1"
SOURCE_FILES = ("process-leases-reconcile.py", "process-leases-rollout.py",
                "process-leases-scheduler-readiness.py", "process-leases-candidate.py",
                "launch-v1-core.py", "release_gate.py", "main_guard.py")


def pin(path, policy="private"):
    data, _ = readiness.read_file(str(path), policy=policy, maximum=256 * 1024 * 1024 if policy == "unit" else 8 * 1024 * 1024)
    return {"path": str(path), "sha256": hashlib.sha256(data).hexdigest()}


def read_pin(value, policy="private", json_value=True):
    readiness.fields(value, ("path", "sha256"))
    if not isinstance(value["sha256"], str) or not HASH.fullmatch(value["sha256"]):
        raise ValueError("invalid evidence digest")
    data, _ = readiness.read_file(value["path"], policy=policy, maximum=256 * 1024 * 1024 if policy == "unit" else 8 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != value["sha256"]:
        raise ValueError("evidence digest changed")
    return json.loads(data) if json_value else data


def publish(path, value, raw=False):
    """Atomic immutable publication, including crashes before acknowledgement."""
    path = Path(path)
    candidate.private_directory(path.parent)
    data = value if raw else candidate.encoded(value)
    if path.exists():
        if read_pin(pin(path), json_value=False) != data:
            raise ValueError("immutable evidence already has different bytes")
        return pin(path)
    fd, name = tempfile.mkstemp(prefix=".reconciliation-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), 0o400)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.renameat2(-100, os.fsencode(name), -100, os.fsencode(path), 1) != 0:
            code = ctypes.get_errno()
            if code != errno.EEXIST:
                raise OSError(code, "immutable reconciliation publication failed")
            if read_pin(pin(path), json_value=False) != data:
                raise ValueError("immutable evidence publication conflicted")
        candidate.sync_dir(path.parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    return pin(path)


def identity(value):
    result = {key: value[key] for key in ("pid", "boot_id", "start_ticks")}
    ticks = result["start_ticks"]
    if isinstance(ticks, str) and ticks.isascii() and ticks.isdigit():
        result["start_ticks"] = int(ticks)
    if (not isinstance(result["pid"], int) or isinstance(result["pid"], bool) or result["pid"] <= 1
            or not isinstance(result["start_ticks"], int) or isinstance(result["start_ticks"], bool)
            or result["start_ticks"] <= 0 or not readiness.BOOT.fullmatch(result["boot_id"])):
        raise ValueError("invalid exact process identity")
    return result


def source_pins():
    return [pin(HERE / name, policy="unit") for name in SOURCE_FILES]


def load_http_helper(value):
    data = read_pin(value, json_value=False)
    module = types.ModuleType("reviewed_scheduler_http_helper")
    module.__file__ = value["path"]
    exec(compile(data, value["path"], "exec"), module.__dict__)
    return module


def same_original_state(state, original):
    return {key: value for key, value in state.items() if key != "canonical_reconciliation"} == original


def check_original(state, *, keep_scheduler=False):
    if state.get("phase") != "unknown" or "canonical_reconciliation" in state:
        raise ValueError("reconciliation requires the original unresolved UNKNOWN state")
    if rollout.identity_state(identity(state["coordinator"])) != "dead":
        raise ValueError("original coordinator is not proven dead")
    scheduler_state = rollout.identity_state(identity(state["scheduler_identity"]["process"]))
    if scheduler_state != ("live" if keep_scheduler else "dead"):
        raise ValueError("original TS process is not live" if keep_scheduler else "original TS process is not proven dead")
    pointer = rollout.read_occupancy(Path(state["selector"]))
    if not pointer or pointer.get("phase") != "active" or pointer.get("job_id") != state["job_id"]:
        raise ValueError("original rollout does not own active occupancy")
    if (candidate.digest(state["selector"]) != state["selector_after_sha256"]
            or candidate.digest(state["launcher"]) != state["launcher_after_sha256"]):
        raise ValueError("only the exact already-installed candidate can be reconciled")
    return pointer


def service_delta(old, new, approved):
    """Allow only explicit exact external-adapter configuration provenance."""
    if (old["unit"] != new["unit"] or old["canonical_environment_sha256"] != new["canonical_environment_sha256"]):
        raise ValueError("canonical systemd identity changed")
    old_files = {p["path"]: p["sha256"] for p in old["files"]}
    new_files = {p["path"]: p["sha256"] for p in new["files"]}
    if len(old_files) != len(old["files"]) or len(new_files) != len(new["files"]) or old_files.keys() != new_files.keys():
        raise ValueError("service file inventory changed")
    observed = [{"path": p, "before_sha256": old_files[p], "after_sha256": new_files[p]}
                for p in sorted(old_files) if old_files[p] != new_files[p]]
    if observed != sorted(approved, key=lambda x: x["path"]):
        raise ValueError("service file delta is not the exact reviewed change")
    for change in observed:
        p = Path(change["path"])
        expected_parent = Path.home() / ".config/systemd/user/agent-herder.service.d"
        if p.parent != expected_parent or p.name != "60-external-adapters.conf":
            raise ValueError("only the reviewed external-adapters drop-in may differ")
        raw = read_pin({"path": str(p), "sha256": change["after_sha256"]}, policy="unit", json_value=False)
        section, count = None, 0
        for line in raw.decode().splitlines():
            line = line.strip()
            if not line or line.startswith(("#", ";")):
                continue
            if line == "[Service]":
                section = "Service"
                continue
            if section != "Service" or not line.startswith("Environment=") or line.endswith("\\"):
                raise ValueError("changed drop-in contains an unreviewed directive")
            values = shlex.split(line[len("Environment="):])
            if len(values) != 1 or not values[0].startswith("AGENT_HERDER_EXTERNAL_ADAPTERS="):
                raise ValueError("changed drop-in modifies an unreviewed environment key")
            count += 1
        if count != 1:
            raise ValueError("changed drop-in has ambiguous external-adapters configuration")
    return {"files": observed, "before_exec_start_sha256": old["exec_start_sha256"],
            "after_exec_start_sha256": new["exec_start_sha256"]}


def successor(state, pid, approved):
    old = state["scheduler_identity"]
    expected = {key: copy.deepcopy(old[key]) for key in ("process", "runtime", "canonical")}
    expected["process"].update(readiness.birth(pid))
    keep_scheduler = identity(expected["process"]) == identity(old["process"])
    check_original(state, keep_scheduler=keep_scheduler)
    if keep_scheduler:
        current = readiness.observe(old)
        if current != old or approved:
            raise ValueError("original scheduler or approved service inventory changed")
        return current, service_delta(old["service"], current["service"], approved)
    current = readiness.observe(expected)
    if current["tree"] != old["tree"]:
        raise ValueError("immutable TS artifact tree changed")
    return current, service_delta(old["service"], current["service"], approved)


def original_install(plan_pin, receipt_pin, state):
    plan, receipt = read_pin(plan_pin), read_pin(receipt_pin)
    old = state["scheduler_identity"]
    if (plan.get("version") != 1 or plan.get("kind") != "herder-canonical-ts-install"
            or receipt.get("kind") != "canonical-ts-installed" or receipt.get("state") != "started_pending_paired_readiness"
            or receipt.get("plan_sha256") != plan_pin["sha256"] or receipt.get("source_commit") != old["runtime"]["source_commit"]
            or plan.get("source_commit") != old["runtime"]["source_commit"]
            or plan.get("runtime") != old["runtime"] or plan.get("canonical") != old["canonical"]
            or receipt.get("pid") != old["process"]["pid"]
            or str(receipt.get("start_ticks")) != str(old["process"]["start_ticks"])
            or receipt.get("entry") != old["process"]["entry"] or receipt.get("node_binary") != old["process"]["node_binary"]):
        raise ValueError("original installation receipt does not bind the original scheduler")


def original_scheduler_preflight(state):
    saved = pin(Path(state["job_dir"]) / "scheduler-preflight.json")
    recorded = state["scheduler_preflight_evidence"]
    if (saved["sha256"] != state["scheduler_preflight_sha256"]
            or recorded["identity"] != state["scheduler_identity"]
            or recorded["readiness_scope"] != "preflight"):
        raise ValueError("preflight does not bind the original scheduler")
    return saved


def keeps_original_scheduler(plan):
    old = plan.get("old_scheduler_identity")
    return old is not None and plan["successor_scheduler_identity"] == old


def native_restart_binding(binding_pin, state, pair):
    binding = read_pin(binding_pin)
    restart_pin = pin(Path(state["job_dir"]) / "restart-ack.json")
    restart = read_pin(restart_pin)
    rollout.validate_restart(state, restart)
    if (binding.get("version") != 1 or binding.get("kind") != "herder-native-receipt-source-binding"
            or binding.get("provider_operation_id") != restart["provider_operation_id"]
            or binding.get("state", {}).get("path") != str(Path(state["job_dir"]) / "state.json")
            or binding.get("receipt", {}).get("sha256") != restart_pin["sha256"]
            or read_pin(binding["receipt"]) != restart
            or any(binding.get(key) != 0 for key in ("native_calls", "service_calls", "selector_changes"))):
        raise ValueError("native restart audit does not bind the original acknowledgement")
    # These are immutable source receipts of the original completed operation;
    # the historical audit's state SHA is not asserted against today's UNKNOWN.
    read_pin(binding["provider_result"])
    read_pin(binding["child_status"])
    recorded = binding.get("runtime_pair")
    if (not isinstance(recorded, dict) or set(recorded) != {"compat", "core"}
            or recorded != pair
            or recorded["compat"].get("pid") != restart["compat_pid"]
            or recorded["core"].get("pid") != restart["core_pid"]):
        raise ValueError("native runtime is not the exact original restart pair")
    return binding


def started_before_controller_observation(process, observed_at):
    """A reused PID born after a controller receipt cannot borrow that receipt."""
    current = readiness.now_ms()
    if not isinstance(observed_at, int) or isinstance(observed_at, bool) or observed_at <= 0 or observed_at > current + 5000:
        raise ValueError("native controller observation timestamp is invalid")
    if process["boot_id"] != Path("/proc/sys/kernel/random/boot_id").read_text().strip():
        raise ValueError("native successor belongs to another boot")
    boot = [line.split()[1] for line in Path("/proc/stat").read_text().splitlines() if line.startswith("btime ")]
    if len(boot) != 1 or not boot[0].isdigit():
        raise ValueError("native successor boot time is unavailable")
    # btime has second precision. Require the upper bound before the receipt,
    # rather than accepting a possibly later process through rounding tolerance.
    upper = int(boot[0]) * 1000 + int(process["start_ticks"]) * 1000 // os.sysconf("SC_CLK_TCK") + 1000
    if upper > observed_at:
        raise ValueError("native successor was not alive at the controller observation")


def validate_native_successor(state, original, current, status, previous_status, observed_at):
    if set(original) != {"compat", "core"} or set(current) != {"compat", "core"}:
        raise ValueError("native successor pair is incomplete")
    for role in ("compat", "core"):
        old, new = original[role], current[role]
        if rollout.identity_state(identity(old)) != "dead" or identity(old) == identity(new):
            raise ValueError("original native pair is not proven dead")
        allowed = {"pid", "boot_id", "start_ticks", "ppid"}
        if {k:v for k,v in old.items() if k not in allowed} != {k:v for k,v in new.items() if k not in allowed}:
            raise ValueError("native successor changed immutable artifact, argv or configuration")
        started_before_controller_observation(new, observed_at)
    agent, running = status.get("agent", {}), status.get("status", {})
    if (agent != previous_status.get("agent") or agent.get("enabled") is not True
            or agent.get("ref") != rollout.CHILD or agent.get("command") != state["launcher"]
            or agent.get("transport") != "stdio" or agent.get("user") != "roomhacker"
            or agent.get("cwd") != state["baseline_runtime"]["core"]["cwd"]
            or agent.get("env", {}).get("HERDER_V1_ENTRY") != state["selector"]
            or running.get("ref") != rollout.CHILD or running.get("running") is not True
            or running.get("pid") != current["compat"]["pid"]):
        raise ValueError("native successor is not the exact enrolled controller child")


def native_provenance(state, pair, restart_pin, status_pin=None, parser_pin=None):
    historical = read_pin(restart_pin)
    original = historical.get("runtime_pair")
    if not isinstance(original, dict):
        raise ValueError("original native runtime pair is missing")
    native_restart_binding(restart_pin, state, original)
    if pair == original:
        if status_pin is not None or parser_pin is not None:
            raise ValueError("a native successor observation requires a different exact pair")
        return original, None
    if status_pin is None or parser_pin is None:
        raise ValueError("changed native pair requires a positive typed successor observation")
    parser = load_http_helper(parser_pin)
    operation, status, raw_pin, observed_at = parser.provider(Path(status_pin["path"]), status_pin["sha256"])
    if raw_pin != status_pin:
        raise ValueError("native controller receipt pin changed")
    previous_status = read_pin(historical["child_status"])
    validate_native_successor(state, original, pair, status, previous_status, observed_at)
    return original, {"version": 1, "kind": "herder-observed-native-successor", "runtime_pair": pair,
        "controller_receipt": status_pin, "provider_operation_id": operation,
        "controller": rollout.CONTROLLER, "ref": rollout.CHILD, "method": "mcp_manage", "action": "status",
        "observed_at_unix_ms": observed_at, "controller_configuration_sha256": rollout.json_hash(status["agent"]),
        "original_restart_binding": restart_pin, "restart_performed_by_reconciliation": False}


def owner_proof(proof, state):
    if ({key: proof.get(key) for key in ("project", "owner", "fence")} != state["release_identity"]
            or ("deploymentTarget" in proof and proof["deploymentTarget"] != state["deployment_target"])
            or not isinstance(proof.get("token"), str) or not proof["token"]):
        raise ValueError("proof does not own the original project, target and fence")
    # Existing release controllers persist only project/owner/token/fence. The
    # target comes from the pinned original admission, never from a new input.
    return {**{key: proof[key] for key in ("project", "owner", "token", "fence")},
            "deploymentTarget": state["deployment_target"]}


def bridge_evidence(state, proof_pin):
    proof = owner_proof(read_pin(proof_pin), state)
    ledger_pin = pin(state["release_state"])
    ledger = read_pin(ledger_pin)
    if ledger.get("version") != 2 or ledger.get("canonical", {}).get("version") != 1:
        raise ValueError("only the sealed canonical release ledger is supported")
    sealed = ledger["canonical"]
    config_pin = pin(sealed["config"])
    config = read_pin(config_pin)
    process_pin = pin(config["process_config"])
    process = read_pin(process_pin)
    mappings = [x for x in config["mappings"] if x["project"] == proof["project"] and x.get("deployment_target") == state["deployment_target"]]
    if len(mappings) != 1 or config["ledger"] != state["release_state"] or config["seal_id"] != sealed["seal_id"]:
        raise ValueError("canonical mapping is not exact")
    root = Path(process["resources"]["root"]) / "resources" / mappings[0]["resource_ref"]
    binding_pin = pin(root / "execution-binding.json")
    binding = read_pin(binding_pin)
    execution = binding.get("execution_ref", "")
    if not re.fullmatch(r"release-guard-[0-9a-f]{32}", execution) or binding.get("resolved_receipt") is not None:
        raise ValueError("original guard binding is not unresolved")
    guard_pin = pin(root / "compat-guards" / (execution.removeprefix("release-") + ".intent.json"))
    guard = read_pin(guard_pin)
    if (guard.get("execution_ref") != execution or guard.get("fence") != proof["fence"]
            or guard.get("resource_ref") != mappings[0]["resource_ref"]
            or guard.get("claim_id") != binding.get("claim_id") or guard.get("finished_at_seconds") is not None):
        raise ValueError("guard intent does not match the owned original binding")
    return {"config": config_pin, "ledger": ledger_pin, "process_config": process_pin,
            "sealed_bridge": pin(sealed["bridge"], policy="unit"), "binding": binding_pin,
            "guard_intent": guard_pin}


def verify_sources(plan):
    for value in plan["validator_sources"]:
        read_pin(value, policy="unit", json_value=False)
    read_pin(plan["http_helper"], json_value=False)
    read_pin(plan["native_operator"], policy="unit", json_value=False)
    if plan.get("native_successor_parser") is not None:
        read_pin(plan["native_successor_parser"], json_value=False)


def load_plan(args):
    plan = read_pin({"path": str(args.plan), "sha256": args.plan_sha256})
    if plan.get("version") != 1 or plan.get("kind") != KIND or plan.get("outcome") != "candidate":
        raise ValueError("invalid candidate reconciliation plan")
    verify_sources(plan)
    return plan


def verify_current(plan, binding=True):
    original = read_pin(plan["original_state_snapshot"])
    state = rollout.read_state(original["job_dir"])
    if state != original:
        raise ValueError("original rollout checkpoint changed after preparation")
    if state["scheduler_identity"] != plan["old_scheduler_identity"]:
        raise ValueError("plan does not bind the original scheduler")
    keep_scheduler = keeps_original_scheduler(plan)
    check_original(state, keep_scheduler=keep_scheduler)
    read_pin(plan["state"])
    read_pin(plan["occupancy"])
    if keep_scheduler:
        if original_scheduler_preflight(state) != plan["original_scheduler_preflight"]:
            raise ValueError("original scheduler preflight changed after preparation")
    else:
        original_install(plan["install_plan"], plan["install_receipt"], state)
    actual = readiness.observe(plan["successor_scheduler_identity"])
    service_delta(state["scheduler_identity"]["service"], actual["service"], plan["approved_service_changes"])
    pair = rollout.runtime_pair(Path(state["selector"]), Path(state["launcher"]),
                                plan["native_runtime"]["compat"]["pid"], plan["native_runtime"]["core"]["pid"],
                                expected_cwd=state["baseline_runtime"]["core"]["cwd"])
    if pair != plan["native_runtime"]:
        raise ValueError("native candidate pair changed during reconciliation")
    original_pair, successor = native_provenance(state, pair, plan["native_restart_binding"],
        plan.get("native_successor_status"), plan.get("native_successor_parser"))
    if original_pair != plan["original_native_runtime"] or successor != plan["observed_native_successor"]:
        raise ValueError("native runtime provenance changed after preparation")
    for key, value in plan["bridge"].items():
        if key == "binding" and not binding:
            continue
        read_pin(value, policy="unit" if key == "sealed_bridge" else "private", json_value=False)
    return state


def prepare(args):
    state_pin = {"path": str(args.job_dir / "state.json"), "sha256": args.state_sha256}
    state = read_pin(state_pin)
    approved = [{"path": p, "before_sha256": before, "after_sha256": after} for p, before, after in args.service_change]
    current, delta = successor(state, args.ts_pid, approved)
    if current == state["scheduler_identity"]:
        scheduler_provenance = {"original_scheduler_preflight": original_scheduler_preflight(state)}
    else:
        if args.install_plan is None or args.install_receipt is None:
            raise ValueError("a scheduler successor requires the original install plan and receipt")
        install_plan, install_receipt = pin(args.install_plan), pin(args.install_receipt)
        original_install(install_plan, install_receipt, state)
        scheduler_provenance = {"install_plan": install_plan, "install_receipt": install_receipt}
    proof_pin = pin(args.proof)
    bridge = bridge_evidence(state, proof_pin)
    pair = rollout.runtime_pair(Path(state["selector"]), Path(state["launcher"]), args.compat_pid, args.core_pid,
                                expected_cwd=state["baseline_runtime"]["core"]["cwd"])
    restart_binding = {"path": str(args.native_restart_binding), "sha256": args.native_restart_binding_sha256}
    status_values = (args.native_successor_status, args.native_successor_status_sha256,
                     args.native_successor_parser, args.native_successor_parser_sha256)
    if any(value is not None for value in status_values) and any(value is None for value in status_values):
        raise ValueError("native successor requires exact status and parser paths and SHA256 pins")
    status_pin = None if args.native_successor_status is None else {
        "path": str(args.native_successor_status), "sha256": args.native_successor_status_sha256}
    parser_pin = None if args.native_successor_parser is None else {
        "path": str(args.native_successor_parser), "sha256": args.native_successor_parser_sha256}
    original_pair, native_successor = native_provenance(state, pair, restart_binding, status_pin, parser_pin)
    helper = {"path": str(args.http_helper), "sha256": args.http_helper_sha256}
    operator = {"path": str(args.native_operator), "sha256": args.native_operator_sha256}
    read_pin(helper, json_value=False)
    read_pin(operator, policy="unit", json_value=False)
    out = Path(args.output_directory)
    candidate.private_directory(out.parent)
    out.mkdir(mode=0o700)
    snapshot = publish(out / "original-state.json", read_pin(state_pin, json_value=False), raw=True)
    archives = []
    for index, change in enumerate(delta["files"]):
        data, info = readiness.read_file(change["path"], policy="unit")
        if hashlib.sha256(data).hexdigest() != change["after_sha256"]:
            raise ValueError("reviewed service file changed during archival")
        archives.append({**change, "archive": publish(out / ("service-delta-" + str(index) + ".original"), data, raw=True),
                         "device": info.st_dev, "inode": info.st_ino, "mtime_ns": info.st_mtime_ns,
                         "ctime_ns": info.st_ctime_ns, "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid})
    plan = {"version": 1, "kind": KIND, "outcome": "candidate", "job_id": state["job_id"], "job_dir": state["job_dir"],
            "state": state_pin, "original_state_snapshot": snapshot,
            "occupancy": pin(rollout.occupancy_path(Path(state["selector"]))), "proof": proof_pin,
            "bridge": bridge, **scheduler_provenance,
            "old_scheduler_identity": state["scheduler_identity"], "successor_scheduler_identity": current,
            "approved_service_changes": approved, "service_delta": delta, "service_delta_archives": archives, "native_runtime": pair,
            "native_restart_binding": restart_binding,
            "original_native_runtime": original_pair, "observed_native_successor": native_successor,
            "native_successor_status": status_pin, "native_successor_parser": parser_pin,
            "challenge": uuid.uuid4().hex + uuid.uuid4().hex, "http_helper": helper, "native_operator": operator,
            "validator_sources": source_pins(), "created_at_unix_ms": readiness.now_ms()}
    verify_current(plan)
    return {"plan": publish(out / "plan.json", plan), "effects": "private_evidence_only"}


def observe(args):
    plan = load_plan(args)
    state = verify_current(plan)
    helper = load_http_helper(plan["http_helper"])
    probe = {"harness": args.probe_harness, "native_session_id": args.probe_native_session_id}
    if args.probe_node_ref is not None:
        probe["node_ref"] = args.probe_node_ref
    request = helper.build_request(readiness, "consumer", plan["challenge"],
                                  {"job_id": state["job_id"], "challenge": plan["challenge"]}, probe)
    before = readiness.observe(plan["successor_scheduler_identity"])
    output = Path(args.output_directory)
    candidate.private_directory(output.parent)
    output.mkdir(mode=0o700)
    request_pin = publish(output / "request.json", {"version": 1, "kind": "herder-reconciliation-http-request",
        "plan": {"path": str(args.plan), "sha256": args.plan_sha256}, "request": request,
        "before": before, "created_at_unix_ms": readiness.now_ms(), "provider_operation_id": None})
    status, body, response, error, after, token, secret_pin = None, b"", None, None, None, None, None
    complete, connection = False, None
    started = readiness.now_ms()
    try:
        proc = Path("/proc") / str(before["process"]["pid"])
        token, secret_pin = helper.resolve_token_from_bytes((proc / "environ").read_bytes(), readiness)
        if identity(readiness.birth(before["process"]["pid"])) != identity(before["process"]):
            raise ValueError("successor changed before HTTP")
        connection = http.client.HTTPConnection("127.0.0.1", readiness.PORT, timeout=180)
        connection.request("GET", helper.query_path(request), headers={"Authorization": "Bearer " + token,
                           "Accept": "application/json", "Cache-Control": "no-cache", "Connection": "close"})
        reply = connection.getresponse()
        status = reply.status
        body = reply.read(helper.MAX_BODY + 1)
        if len(body) > helper.MAX_BODY:
            raise ValueError("HTTP response exceeds bound")
        complete = True
        response = json.loads(body)
        if token.encode() in body or helper.has_secret(response, token):
            raise ValueError("HTTP response contains secret")
        if (status != 200 or not isinstance(response, dict) or response.get("challenge") != plan["challenge"]
                or any(response.get(key) != before[key] for key in ("process", "runtime", "canonical"))):
            raise ValueError("HTTP successor response does not match the exact request")
    except Exception as exc:
        error = "observation_failed_" + type(exc).__name__
    finally:
        if connection is not None:
            connection.close()
    stamp = readiness.now_ms()
    try:
        helper.verify_token_source(readiness, secret_pin)
        if token is not None:
            current_token, current_pin = helper.resolve_token_from_bytes(
                (Path("/proc") / str(before["process"]["pid"]) / "environ").read_bytes(), readiness)
            if current_token != token or current_pin != secret_pin:
                raise ValueError("configured HTTP credential changed")
        verify_current(plan)
        after = readiness.observe(before)
    except Exception as exc:
        error = error or "post_observation_failed_" + type(exc).__name__
    safe = complete and isinstance(response, dict) and (token is None or (token.encode() not in body and not helper.has_secret(response, token)))
    body_pin = publish(output / "response.body", body, raw=True) if safe else None
    observation = {"version": 1, "kind": "herder-canonical-http-observation", "stage": "consumer",
        "request": request, "request_receipt": request_pin, "started_at_unix_ms": started,
        "observed_at_unix_ms": stamp, "http_status": status, "http_body_complete": complete,
        "http_body_sha256": hashlib.sha256(body).hexdigest() if complete else None, "body": body_pin,
        "response": response if safe else None, "before": before, "after": after, "error": error,
        "rollout": {"job_id": state["job_id"], "challenge": plan["challenge"]},
        "reconciliation_plan": {"path": str(args.plan), "sha256": args.plan_sha256}, "provider_operation_id": None}
    value = {"observation": publish(output / "observation.json", observation), "http_status": status,
             "observation_complete": error is None, "provider_operation_id": None}
    return value, 0 if error is None else 1


def finalize(args):
    plan = load_plan(args)
    verify_current(plan)
    observation_pin = {"path": str(args.observation), "sha256": args.observation_sha256}
    observation = read_pin(observation_pin)
    if (observation.get("reconciliation_plan") != {"path": str(args.plan), "sha256": args.plan_sha256}
            or observation.get("before") != plan["successor_scheduler_identity"]
            or observation.get("request", {}).get("challenge") != plan["challenge"]):
        raise ValueError("HTTP observation belongs to a different reconciliation")
    body = read_pin(observation["body"], json_value=False)
    if hashlib.sha256(body).hexdigest() != observation["http_body_sha256"] or json.loads(body) != observation["response"]:
        raise ValueError("raw HTTP observation changed")
    helper = load_http_helper(plan["http_helper"])
    proof = helper.proof_from_observation(readiness, observation, args.provider_operation_id)
    readiness.validate_receipt(proof, plan["successor_scheduler_identity"]["runtime"]["source_commit"], stage="consumer",
        expected=plan["successor_scheduler_identity"], challenge=plan["challenge"], job_id=plan["job_id"],
        minimum=plan["created_at_unix_ms"])
    proof_pin = publish(args.output, proof)
    audit = publish(Path(str(args.output) + ".observation-binding.json"), {"version": 1,
        "kind": "herder-reconciliation-http-observation-binding", "plan": {"path": str(args.plan), "sha256": args.plan_sha256},
        "observation": observation_pin, "provider_operation_id": args.provider_operation_id, "proof": proof_pin,
        "http_body_sha256": observation["http_body_sha256"], "validated_at_unix_ms": readiness.now_ms()})
    return {"proof": proof_pin, "observation": observation_pin, "observation_binding": audit,
            "provider_operation_id": args.provider_operation_id}


def evidence_files(plan, args):
    state = verify_current(plan)
    native_pin, scheduler_pin = pin(args.consumer_receipt), pin(args.scheduler_proof)
    native, scheduler = read_pin(native_pin), read_pin(scheduler_pin)
    logical = {**state, "challenge": plan["challenge"]}
    minimum = max(plan["created_at_unix_ms"], readiness.now_ms() - 60000)
    native_result = rollout.validate_consumer(logical, native, minimum)
    restart = candidate.read_json(Path(state["job_dir"]) / "restart-ack.json")
    if native["observed_at_unix_ms"] < restart["observed_at_unix_ms"]:
        raise ValueError("consumer predates the original native restart")
    scheduler_result = readiness.validate_receipt(scheduler, plan["successor_scheduler_identity"]["runtime"]["source_commit"],
        stage="consumer", expected=plan["successor_scheduler_identity"], challenge=plan["challenge"],
        job_id=plan["job_id"], minimum=minimum)
    stamp = readiness.now_ms()
    scheduler_provenance = (
        {"original_scheduler_preflight": plan["original_scheduler_preflight"]} if keeps_original_scheduler(plan)
        else {"original_install_receipt": plan["install_receipt"]}
    )
    paired = {"version": 1, "kind": "herder-paired-rollout-reconciliation-v1", "outcome": "candidate", "complete": True,
        "job_id": state["job_id"], "original_state_sha256": plan["state"]["sha256"],
        "original_state_snapshot": plan["original_state_snapshot"], **scheduler_provenance,
        "old_scheduler_identity": plan["old_scheduler_identity"], "successor_scheduler_identity": plan["successor_scheduler_identity"],
        "native_runtime": plan["native_runtime"], "native_restart_binding": plan["native_restart_binding"],
        "original_native_runtime": plan["original_native_runtime"], "observed_native_successor": plan["observed_native_successor"],
        "native_consumer": native_pin, "scheduler_consumer": scheduler_pin,
        "native_validation": native_result, "scheduler_validation": scheduler_result, "service_delta": plan["service_delta"],
        "selector_sha256": state["selector_after_sha256"], "launcher_sha256": state["launcher_after_sha256"],
        "validated_at_unix_ms": stamp, "validator_sources": plan["validator_sources"],
        "plan": {"path": str(args.plan), "sha256": args.plan_sha256}}
    root = Path(args.plan).parent
    paired_pin = publish(root / "paired-proof.json", paired)
    bridge = plan["bridge"]
    evidence = {"version": 1, "kind": "herder-project-release-reconciliation-v1", "outcome": "candidate",
        "job_id": state["job_id"], "job_dir": state["job_dir"], "state": plan["state"], "occupancy": plan["occupancy"],
        "guard_intent": bridge["guard_intent"], "binding_sha256": bridge["binding"]["sha256"],
        "sealed_bridge": bridge["sealed_bridge"], "config_sha256": bridge["config"]["sha256"],
        "ledger_sha256": bridge["ledger"]["sha256"], "process_config_sha256": bridge["process_config"]["sha256"],
        "coordinator": state["coordinator"], "validated_at_unix_ms": stamp, "paired_proof": paired_pin}
    return publish(root / "evidence.json", evidence)


def invoke_native(plan, evidence_pin):
    proof = owner_proof(read_pin(plan["proof"]), read_pin(plan["original_state_snapshot"]))
    request = {"version": 1, "action": "reconcile_finished", "proof": proof, "evidence": evidence_pin}
    read_pin(plan["native_operator"], policy="unit", json_value=False)
    result = subprocess.run([plan["native_operator"]["path"], "--config", plan["bridge"]["config"]["path"]],
                            input=json.dumps(request), capture_output=True, text=True, timeout=30)
    if result.returncode or len(result.stdout) > 65536:
        raise RuntimeError("native reconciliation refused or its acknowledgement is unavailable; inspect original receipt")
    envelope = json.loads(result.stdout)
    if envelope.get("ok") is not True or not isinstance(envelope.get("result"), dict):
        raise ValueError("native reconciliation returned no successful typed acknowledgement")
    response = envelope["result"]
    if (response.get("finished") is not True or response.get("reconciled") is not True
            or response.get("evidenceSha256") != evidence_pin["sha256"] or response.get("jobId") != plan["job_id"]):
        raise ValueError("native reconciliation acknowledgement is not exact")
    read_pin({"path": response["receiptPath"], "sha256": response["receiptSha256"]})
    return response


def apply(args):
    plan = load_plan(args)
    root = Path(args.plan).parent
    original = read_pin(plan["original_state_snapshot"])
    with candidate.selector_lock(Path(original["selector"])):
        current = rollout.read_state(plan["job_dir"])
        if not same_original_state(current, original):
            raise ValueError("original checkpoint fields changed")
        if current.get("canonical_reconciliation"):
            if not rollout.canonical_reconciliation_valid(current):
                raise ValueError("existing reconciliation annotation is invalid")
        else:
            pending = root / "evidence.json"
            if pending.exists():
                evidence_pin = pin(pending)
                evidence = read_pin(evidence_pin)
                paired = read_pin(evidence["paired_proof"])
                if (paired.get("plan") != {"path": str(args.plan), "sha256": args.plan_sha256}
                        or evidence.get("state") != plan["state"]):
                    raise ValueError("pending reconciliation belongs to another plan")
                native_path = Path(plan["bridge"]["guard_intent"]["path"].removesuffix(".intent.json") + ".reconciliation.json")
                if not native_path.exists():
                    # No durable native receipt: all original checks and 60s
                    # consumer freshness still apply. Never create a new digest.
                    verify_current(plan)
                    logical = {**original, "challenge": plan["challenge"]}
                    rollout.validate_consumer(logical, read_pin(paired["native_consumer"]), readiness.now_ms() - 60000)
                    readiness.validate_receipt(read_pin(paired["scheduler_consumer"]),
                        plan["successor_scheduler_identity"]["runtime"]["source_commit"], stage="consumer",
                        expected=plan["successor_scheduler_identity"], challenge=plan["challenge"], job_id=plan["job_id"],
                        minimum=readiness.now_ms() - 60000)
                # Native independently verifies exact existing receipt on retry;
                # no different evidence or owner can use this crash repair path.
            else:
                evidence_pin = evidence_files(plan, args)
            response = invoke_native(plan, evidence_pin)
            result = {"version": 1, "kind": "herder-paired-rollout-reconciled-v1", "outcome": "candidate", "complete": True,
                "job_id": plan["job_id"], "original_state": plan["original_state_snapshot"], "evidence": evidence_pin,
                "native_receipt": {"path": response["receiptPath"], "sha256": response["receiptSha256"]},
                "native_acknowledgement": response, "validated_at_unix_ms": read_pin(evidence_pin)["validated_at_unix_ms"]}
            result_pin = publish(root / "reconciliation-receipt.json", result)
            annotation = {"version": 1, "outcome": "candidate", "receipt": result_pin,
                          "original_state": plan["original_state_snapshot"]}
            latest = rollout.read_state(plan["job_dir"])
            if latest != original:
                raise ValueError("checkpoint changed after native acknowledgement")
            current = {**original, "canonical_reconciliation": annotation}
            # Do not restamp or rewrite any original outcome or state field.
            candidate.replace(Path(plan["job_dir"]) / "state.json", candidate.encoded(current), plan["state"]["sha256"], 0o600)
    pointer = rollout.read_occupancy(Path(current["selector"]))
    if pointer["phase"] == "active":
        rollout.resolve_occupancy(current)
    return rollout.status(argparse.Namespace(job_dir=Path(plan["job_dir"])))


def completed_provider(plan, value):
    """Use the already reviewed parser, including actual target/task identities."""
    parser_pin = plan.get("native_successor_parser")
    if parser_pin is None:
        raise ValueError("failed settlement requires the pinned original provider parser")
    read_pin(value, json_value=False)
    result = load_http_helper(parser_pin).provider(Path(value["path"]), value["sha256"])
    if result[2] != value:
        raise ValueError("provider result pin changed")
    return result


def provider_stdout(payload, returncode):
    if (type(payload.get("returncode")) is not int or payload["returncode"] != returncode
            or not isinstance(payload.get("stdout"), str) or len(payload["stdout"]) > 8 * 1024 * 1024
            or not isinstance(payload.get("stderr"), str)):
        raise ValueError("definitive completed original shell operation required")
    value = json.loads(payload["stdout"])
    # The reviewed orchestration wrapper retains the reaped subprocess result
    # as exactly this object. Its exit status must agree with the outer task.
    if isinstance(value, dict) and set(value) == {"returncode", "stdout", "stderr"}:
        if (type(value["returncode"]) is not int or value["returncode"] != returncode
                or not isinstance(value["stdout"], str) or not isinstance(value["stderr"], str)):
            raise ValueError("original subprocess wrapper has a contradictory terminal result")
        value = json.loads(value["stdout"])
    if not isinstance(value, dict):
        raise ValueError("original operation has no typed terminal result")
    return value


def failure_from_observation(plan, plan_pin, observation_pin, provider_pin):
    """A complete authenticated 503 is a failed acceptance, never healthy readiness."""
    observation = read_pin(observation_pin)
    expected = plan["successor_scheduler_identity"]
    request = observation.get("request")
    readiness.fields(request, ("endpoint", "challenge", "probe"))
    readiness.fields(request["probe"], ("harness", "native_session_id"), ("node_ref",))
    if (request["endpoint"] != readiness.ENDPOINT or request["challenge"] != plan["challenge"]
            or not all(readiness.exact(value) for value in request["probe"].values())):
        raise ValueError("failed acceptance request is not the exact operational probe")
    if (observation.get("version") != 1 or observation.get("kind") != "herder-canonical-http-observation"
            or observation.get("stage") != "consumer" or observation.get("http_status") != 503
            or observation.get("http_body_complete") is not True
            or observation.get("response") != {"error": "canonical_runtime_unavailable"}
            or observation.get("error") != "observation_failed_ValueError"
            or observation.get("reconciliation_plan") != plan_pin
            or observation.get("before") != expected or observation.get("after") != expected
            or observation.get("rollout") != {"job_id": plan["job_id"], "challenge": plan["challenge"]}
            or observation.get("provider_operation_id") is not None):
        raise ValueError("only the complete exact authenticated 503 may settle failed acceptance")
    raw = read_pin(observation["body"], json_value=False)
    if (hashlib.sha256(raw).hexdigest() != observation["http_body_sha256"]
            or json.loads(raw) != observation["response"]):
        raise ValueError("failed HTTP response bytes changed")
    request_receipt = read_pin(observation["request_receipt"])
    if (request_receipt.get("version") != 1
            or request_receipt.get("kind") != "herder-reconciliation-http-request"
            or request_receipt.get("plan") != plan_pin or request_receipt.get("request") != request
            or request_receipt.get("before") != expected or request_receipt.get("provider_operation_id") is not None):
        raise ValueError("failed HTTP request was not the pinned authenticated observer request")
    operation, payload, _, completed = completed_provider(plan, provider_pin)
    output = provider_stdout(payload, 1)
    if (output.get("observation") != observation_pin or output.get("http_status") != 503
            or output.get("observation_complete") is not False
            or output.get("provider_operation_id") is not None):
        raise ValueError("actual provider result does not bind this failed observation")
    start, stamp = observation.get("started_at_unix_ms"), observation.get("observed_at_unix_ms")
    created = request_receipt.get("created_at_unix_ms")
    current = readiness.now_ms()
    if (any(type(value) is not int for value in (start, stamp, created, completed))
            or not plan["created_at_unix_ms"] <= created <= start <= stamp <= completed
            or stamp < current - 60000 or completed > current + 5000 or completed - stamp > 60000):
        raise ValueError("failed acceptance is stale or has contradictory operation timestamps")
    return {"version": 1, "kind": FAILED_PROOF_KIND, "outcome": "failed", "operational_readiness": False,
        "job_id": plan["job_id"], "request": request, "provider_operation_id": operation, "provider_result": provider_pin,
        "http_status": 503, "http_body_complete": True, "body": observation["body"],
        "http_body_sha256": observation["http_body_sha256"], "response": observation["response"],
        "before": expected, "after": expected, "started_at_unix_ms": start, "observed_at_unix_ms": stamp,
        "provider_completed_at_unix_ms": completed, "observation": observation_pin,
        "request_receipt": observation["request_receipt"], "reconciliation_plan": plan_pin,
        "authenticated_request": True}


def finalize_failed(args):
    plan = load_plan(args)
    verify_current(plan)
    plan_pin = {"path": str(args.plan), "sha256": args.plan_sha256}
    proof = failure_from_observation(plan, plan_pin,
        {"path": str(args.observation), "sha256": args.observation_sha256},
        {"path": str(args.provider_result), "sha256": args.provider_result_sha256})
    value = publish(args.output, proof)
    return {"failure_proof": value, "outcome": "failed", "operational_readiness": False,
            "provider_operation_id": proof["provider_operation_id"]}


def validate_failure(plan, plan_pin, failure_pin):
    failure = read_pin(failure_pin)
    expected = failure_from_observation(plan, plan_pin, failure["observation"], failure["provider_result"])
    if failure != expected:
        raise ValueError("failed acceptance proof differs from its actual provider observation")
    return failure


def terminal_repair(plan, item):
    """An ambiguous repair intent cannot be converted into a failed settlement."""
    stem = plan["bridge"]["guard_intent"]["path"].removesuffix(".intent.json")
    intent_path, receipt_path = Path(stem + ".ts-repair.intent.json"), Path(stem + ".ts-repair.receipt.json")
    if not intent_path.exists() and not receipt_path.exists():
        if item is not None:
            raise ValueError("repair evidence was supplied without an actual guard-specific repair")
        return None
    if item is None or not intent_path.exists() or not receipt_path.exists():
        raise ValueError("original TS repair intent has no definitive terminal receipt")
    readiness.fields(item, ("intent", "receipt", "observation"))
    if item["intent"]["path"] != str(intent_path) or item["receipt"]["path"] != str(receipt_path):
        raise ValueError("repair receipt belongs to another guard")
    intent, receipt, observed = (read_pin(item[key]) for key in ("intent", "receipt", "observation"))
    result = receipt.get("systemctl", {})
    if (intent.get("version") != 1 or intent.get("kind") != "herder-project-release-ts-repair-intent-v1"
            or intent.get("job_id") != plan["job_id"] or intent.get("guard") != read_pin(plan["bridge"]["guard_intent"])
            or receipt.get("version") != 1 or receipt.get("kind") != "herder-project-release-ts-repair-receipt-v1"
            or receipt.get("job_id") != plan["job_id"] or receipt.get("intent") != item["intent"]
            or any(receipt.get(key) != intent.get(key) for key in ("repair_id", "request_key", "evidence", "operator", "old_process"))
            or result.get("spawned") is not True or type(result.get("exit_code")) is not int or result["exit_code"] != 0
            or result.get("signal") is not None or result.get("timed_out") is not False or result.get("error_code") is not None
            or type(receipt.get("started_at_unix_ms")) is not int or type(receipt.get("finished_at_unix_ms")) is not int
            or receipt["finished_at_unix_ms"] < receipt["started_at_unix_ms"]):
        raise ValueError("original TS repair result is not definitively complete")
    acknowledgement = observed.get("native_acknowledgement", {})
    if (observed.get("kind") != "herder-canonical-ts-repair-observation-v1"
            or observed.get("job_id") != plan["job_id"] or observed.get("native_receipt") != item["receipt"]
            or observed.get("original_state", {}).get("sha256") != plan["original_state_snapshot"]["sha256"]
            or observed.get("original_outcome") != "unknown" or observed.get("binding_resolved") is not False
            or observed.get("observation_error") is not None
            or observed.get("observed_successor") != plan["successor_scheduler_identity"]
            or observed.get("native_runtime") != plan["native_runtime"]
            or acknowledgement.get("status") != "recorded" or acknowledgement.get("bindingResolved") is not False
            or acknowledgement.get("receiptPath") != item["receipt"]["path"]
            or acknowledgement.get("receiptSha256") != item["receipt"]["sha256"]):
        raise ValueError("repair acknowledgement does not bind the exact current successor")
    if read_pin(observed["original_state"]) != read_pin(plan["original_state_snapshot"]):
        raise ValueError("repair changed the original rollout outcome")
    if rollout.identity_state(identity(intent["old_process"])) != "dead":
        raise ValueError("the original repair process has not definitively ended")
    read_pin(intent["evidence"])
    read_pin(intent["repair_plan"])
    read_pin(intent["operator"], policy="unit", json_value=False)
    return item


def validate_effect_completion(plan, inputs):
    """Validate actual terminal effects without inventing a missing Hub receipt."""
    readiness.fields(inputs, ("install", "native_restart", "coordinator", "repair"))
    state = read_pin(plan["original_state_snapshot"])
    install = readiness.fields(inputs["install"], ("receipt", "plan", "recipe", "driver", "driver_source", "intent", "start_intent"))
    if install["receipt"] != plan["install_receipt"] or install["plan"] != plan["install_plan"]:
        raise ValueError("terminal installation evidence selects another admission")
    original_install(install["plan"], install["receipt"], state)
    recipe, driver, intent, start = (read_pin(install[key]) for key in ("recipe", "driver", "intent", "start_intent"))
    # The reviewed immutable driver source is provenance, not a fabricated
    # provider receipt or a substitute for its actual reaped result.
    read_pin(install["driver_source"], json_value=False)
    output = provider_stdout(driver, 0)
    old = state["scheduler_identity"]
    if (recipe.get("kind") != "prepared_ts_install_recipe" or recipe.get("version") != 1
            or recipe.get("plan") != install["plan"]["path"] or recipe.get("plan_sha256") != install["plan"]["sha256"]
            or recipe.get("source_commit") != old["runtime"]["source_commit"]
            or install["receipt"]["path"] != str(Path(recipe["journal"]) / "result.json")
            or install["intent"]["path"] != str(Path(recipe["journal"]) / "intent.json")
            or install["start_intent"]["path"] != str(Path(recipe["journal"]) / "start-intent.json")
            or intent.get("kind") != "canonical-ts-install-intent" or intent.get("plan") != install["plan"]["path"]
            or intent.get("plan_sha256") != install["plan"]["sha256"] or intent.get("target") != state["deployment_target"]
            or start.get("unit") != readiness.UNIT
            or any(value.get("source_commit") != old["runtime"]["source_commit"] for value in (intent, start, output))
            or output.get("status") != "installed_listener_ready" or output.get("pid") != old["process"]["pid"]
            or str(output.get("start_ticks")) != str(old["process"]["start_ticks"])):
        raise ValueError("installation completion does not bind the exact original installed TS")
    read_pin(output["listener_receipt"])
    installed = read_pin(install["receipt"])
    times = [intent.get("created_at_unix_ms"), start.get("at_unix_ms"),
             installed.get("at_unix_ms"), driver.get("at_unix_ms"), state["created_at_unix_ms"]]
    if any(type(value) is not int for value in times) or times != sorted(times):
        raise ValueError("installation effect completion timestamps are contradictory")
    restart = readiness.fields(inputs["native_restart"], ("binding", "provider_result"))
    if restart["binding"] != plan["native_restart_binding"]:
        raise ValueError("native effect completion has another original restart binding")
    binding = native_restart_binding(restart["binding"], state, plan["original_native_runtime"])
    if restart["provider_result"] != binding["provider_result"]:
        raise ValueError("native restart provider differs from its original audit")
    operation, payload, _, stamp = completed_provider(plan, restart["provider_result"])
    ack = read_pin(binding["receipt"])
    if (operation != ack["provider_operation_id"] or stamp != ack["observed_at_unix_ms"]
            or payload.get("ref") != rollout.CHILD or payload.get("action") != ack["action"]):
        raise ValueError("original native restart has no exact terminal controller acknowledgement")
    coordinator = readiness.fields(inputs["coordinator"], ("provider_result", "driver", "provider_operation_id"))
    operation, payload, _, completed = completed_provider(plan, coordinator["provider_result"])
    driver = read_pin(coordinator["driver"])
    if (operation != coordinator["provider_operation_id"] or provider_stdout(payload, 1) != driver
            or driver.get("returncode") != 1 or driver.get("phase") != "unknown"
            or driver.get("state") != plan["state"]["path"] or driver.get("state_sha256") != plan["state"]["sha256"]
            or type(driver.get("at_unix_ms")) is not int or driver["at_unix_ms"] > completed
            or driver["at_unix_ms"] < state["created_at_unix_ms"]):
        raise ValueError("original coordinator has no exact terminal UNKNOWN receipt")
    read_pin({"path": driver["log"], "sha256": driver["log_sha256"]}, json_value=False)
    if rollout.identity_state(identity(state["coordinator"])) != "dead":
        raise ValueError("original coordinator is not dead")
    repair = terminal_repair(plan, inputs["repair"])
    return {"version": 1, "kind": EFFECTS_KIND, "job_id": plan["job_id"], "complete": True,
            "original_state_snapshot": plan["original_state_snapshot"], **inputs, "repair": repair}


def failed_native_consumer(plan, provider_pin):
    operation, payload, _, stamp = completed_provider(plan, provider_pin)
    if payload.get("ref", rollout.CHILD) != rollout.CHILD or not isinstance(payload.get("tools"), list):
        raise ValueError("failed settlement requires an actual typed native tools/list")
    for process in plan["native_runtime"].values():
        started_before_controller_observation(process, stamp)
    receipt = {"schema": 1, "kind": "consumer", "job_id": plan["job_id"], "challenge": plan["challenge"],
        "observed_at_unix_ms": stamp, "provider_operation_id": operation, "target": rollout.CONTROLLER,
        "ref": rollout.CHILD, "method": "mcp_tools", "tools": payload["tools"],
        "schema_sha256": rollout.json_hash(payload["tools"])}
    state = {**read_pin(plan["original_state_snapshot"]), "challenge": plan["challenge"]}
    rollout.validate_consumer(state, receipt, max(plan["created_at_unix_ms"], readiness.now_ms() - 60000))
    return receipt


def prepare_failed(args):
    plan = load_plan(args)
    if keeps_original_scheduler(plan):
        raise ValueError("failed reconciliation requires an observed successor scheduler")
    verify_current(plan)
    operator = {"path": str(args.failed_native_operator), "sha256": args.failed_native_operator_sha256}
    read_pin(operator, policy="unit", json_value=False)
    inputs = {"path": str(args.effect_input), "sha256": args.effect_input_sha256}
    effects = validate_effect_completion(plan, read_pin(inputs))
    root = Path(args.output_directory)
    candidate.private_directory(root.parent)
    root.mkdir(mode=0o700)
    effects_pin = publish(root / "effect-completion.json", effects)
    prepared = {"version": 1, "kind": FAILED_PLAN_KIND, "outcome": "failed",
        "job_id": plan["job_id"], "original_plan": {"path": str(args.plan), "sha256": args.plan_sha256},
        "native_operator": operator, "effect_input": inputs, "effect_completion": effects_pin,
        "validator_sources": source_pins(), "created_at_unix_ms": readiness.now_ms()}
    verify_current(plan)
    return {"plan": publish(root / "plan.json", prepared), "effects": "private_evidence_only"}


def load_failed_plan(args):
    prepared = read_pin({"path": str(args.plan), "sha256": args.plan_sha256})
    if (prepared.get("version") != 1 or prepared.get("kind") != FAILED_PLAN_KIND
            or prepared.get("outcome") != "failed"):
        raise ValueError("explicit failed reconciliation plan required")
    for value in prepared["validator_sources"]:
        read_pin(value, policy="unit", json_value=False)
    read_pin(prepared["native_operator"], policy="unit", json_value=False)
    base_pin = prepared["original_plan"]
    plan = load_plan(argparse.Namespace(plan=Path(base_pin["path"]), plan_sha256=base_pin["sha256"]))
    if keeps_original_scheduler(plan):
        raise ValueError("failed reconciliation requires an observed successor scheduler")
    if prepared.get("job_id") != plan["job_id"]:
        raise ValueError("failed plan names another original rollout")
    read_pin(prepared["effect_completion"])
    return prepared, plan


def failed_evidence_files(plan, args, prepared):
    state = verify_current(plan)
    root = Path(args.plan).parent
    candidate.private_directory(root)
    plan_pin = prepared["original_plan"]
    failure_pin = {"path": str(args.failure_proof), "sha256": args.failure_proof_sha256}
    failure = validate_failure(plan, plan_pin, failure_pin)
    input_pin = prepared["effect_input"]
    effects = validate_effect_completion(plan, read_pin(input_pin))
    if effects != read_pin(prepared["effect_completion"]):
        raise ValueError("terminal effect evidence changed after failed preparation")
    native_provider = {"path": str(args.native_provider_result), "sha256": args.native_provider_result_sha256}
    native = failed_native_consumer(plan, native_provider)
    if native["observed_at_unix_ms"] < failure["observed_at_unix_ms"]:
        raise ValueError("native consumer predates the failed HTTP observation")
    effects_pin = prepared["effect_completion"]
    native_pin = publish(root / "native-consumer.json", native)
    stamp = readiness.now_ms()
    paired = {"version": 1, "kind": FAILED_PAIRED_KIND, "outcome": "failed", "complete": True,
        "operational_readiness": False, "job_id": plan["job_id"], "original_state_sha256": plan["state"]["sha256"],
        "original_state_snapshot": plan["original_state_snapshot"], "old_scheduler_identity": plan["old_scheduler_identity"],
        "successor_scheduler_identity": plan["successor_scheduler_identity"], "native_runtime": plan["native_runtime"],
        "original_native_runtime": plan["original_native_runtime"], "observed_native_successor": plan["observed_native_successor"],
        "native_restart_binding": plan["native_restart_binding"], "native_consumer": native_pin,
        "native_provider_result": native_provider, "scheduler_failure": failure_pin, "effect_completion": effects_pin,
        "effect_input": input_pin, "selector_sha256": state["selector_after_sha256"],
        "launcher_sha256": state["launcher_after_sha256"], "validated_at_unix_ms": stamp,
        "validator_sources": prepared["validator_sources"], "native_operator": prepared["native_operator"],
        "failed_plan": {"path": str(args.plan), "sha256": args.plan_sha256},
        "service_delta": plan["service_delta"], "plan": plan_pin}
    paired_pin = publish(root / "failed-paired-proof.json", paired)
    bridge = plan["bridge"]
    evidence = {"version": 1, "kind": "herder-project-release-reconciliation-v1", "outcome": "failed",
        "job_id": state["job_id"], "job_dir": state["job_dir"], "state": plan["state"], "occupancy": plan["occupancy"],
        "guard_intent": bridge["guard_intent"], "binding_sha256": bridge["binding"]["sha256"],
        "sealed_bridge": bridge["sealed_bridge"], "config_sha256": bridge["config"]["sha256"],
        "ledger_sha256": bridge["ledger"]["sha256"], "process_config_sha256": bridge["process_config"]["sha256"],
        "coordinator": state["coordinator"], "validated_at_unix_ms": stamp, "paired_proof": paired_pin}
    return publish(root / "failed-evidence.json", evidence)


def invoke_failed_native(plan, evidence_pin, operator):
    proof = owner_proof(read_pin(plan["proof"]), read_pin(plan["original_state_snapshot"]))
    request = {"version": 1, "action": "reconcile_failed", "proof": proof, "evidence": evidence_pin}
    read_pin(operator, policy="unit", json_value=False)
    started = readiness.now_ms()
    result, failure, stdout, stderr = None, None, b"", b""
    try:
        result = subprocess.run([operator["path"], "--config", plan["bridge"]["config"]["path"]],
            input=json.dumps(request), capture_output=True, text=True, timeout=30)
        stdout, stderr = result.stdout, result.stderr
    except subprocess.TimeoutExpired as error:
        failure, stdout, stderr = error, error.stdout, error.stderr
    except OSError as error:
        failure = error
    def captured(value):
        raw = value if isinstance(value, bytes) else (value or "").encode()
        safe = raw.decode("utf8", errors="replace").replace(proof["token"], "[redacted]").encode()
        return {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
                "text": safe[:65536].decode("utf8", errors="ignore"), "truncated": len(safe) > 65536}
    publish(Path(evidence_pin["path"]).parent / ("native-failed-invocation-" + uuid.uuid4().hex + ".json"),
        {"version": 1, "kind": "herder-native-failed-reconciliation-invocation-v1", "evidence": evidence_pin,
         "operator": operator, "started_at_unix_ms": started, "finished_at_unix_ms": readiness.now_ms(),
         "returncode": None if result is None else result.returncode,
         "timed_out": isinstance(failure, subprocess.TimeoutExpired), "error_type": None if failure is None else type(failure).__name__,
         "stdout": captured(stdout), "stderr": captured(stderr)})
    if failure is not None or result.returncode or len(result.stdout) > 65536:
        raise RuntimeError("failed reconciliation acknowledgement unavailable; inspect original durable receipt")
    envelope = json.loads(result.stdout)
    response = envelope.get("result", {})
    path = plan["bridge"]["guard_intent"]["path"].removesuffix(".intent.json") + ".failed-reconciliation.json"
    if (envelope.get("ok") is not True or response.get("finished") is not True or response.get("reconciled") is not True
            or response.get("outcome") != "failed" or response.get("operationalReadiness") is not False
            or response.get("jobId") != plan["job_id"] or response.get("evidenceSha256") != evidence_pin["sha256"]
            or response.get("receiptPath") != path):
        raise ValueError("failed reconciliation has no exact typed negative acknowledgement")
    read_pin({"path": path, "sha256": response["receiptSha256"]})
    return response


def apply_failed(args):
    prepared, plan = load_failed_plan(args)
    operator = prepared["native_operator"]
    read_pin(operator, policy="unit", json_value=False)
    original = read_pin(plan["original_state_snapshot"])
    root = candidate.private_directory(Path(args.plan).parent)
    with candidate.selector_lock(Path(original["selector"])):
        current = rollout.read_state(plan["job_dir"])
        if not same_original_state(current, original):
            raise ValueError("original checkpoint fields changed")
        if current.get("canonical_reconciliation"):
            if (current["canonical_reconciliation"].get("outcome") != "failed"
                    or not rollout.canonical_reconciliation_valid(current)):
                raise ValueError("another or invalid reconciliation already exists")
        else:
            pending = root / "failed-evidence.json"
            if pending.exists():
                evidence_pin = pin(pending)
                evidence = read_pin(evidence_pin)
                paired = read_pin(evidence["paired_proof"])
                if (evidence.get("outcome") != "failed" or evidence.get("state") != plan["state"]
                        or paired.get("kind") != FAILED_PAIRED_KIND or paired.get("native_operator") != operator
                        or paired.get("plan") != prepared["original_plan"]
                        or paired.get("failed_plan") != {"path": str(args.plan), "sha256": args.plan_sha256}):
                    raise ValueError("pending failed settlement belongs to another original decision")
                native_path = Path(plan["bridge"]["guard_intent"]["path"].removesuffix(".intent.json") + ".failed-reconciliation.json")
                if not native_path.exists():
                    verify_current(plan)
                    validate_failure(plan, paired["plan"], paired["scheduler_failure"])
                    if validate_effect_completion(plan, read_pin(paired["effect_input"])) != read_pin(paired["effect_completion"]):
                        raise ValueError("terminal effects changed before failed settlement")
                    if failed_native_consumer(plan, paired["native_provider_result"]) != read_pin(paired["native_consumer"]):
                        raise ValueError("native consumer changed before failed settlement")
            else:
                evidence_pin = failed_evidence_files(plan, args, prepared)
            response = invoke_failed_native(plan, evidence_pin, operator)
            result = {"version": 1, "kind": "herder-paired-rollout-reconciled-v1", "outcome": "failed", "complete": True,
                "operational_readiness": False, "job_id": plan["job_id"], "original_state": plan["original_state_snapshot"],
                "evidence": evidence_pin, "native_receipt": {"path": response["receiptPath"], "sha256": response["receiptSha256"]},
                "native_acknowledgement": response, "validated_at_unix_ms": read_pin(evidence_pin)["validated_at_unix_ms"]}
            result_pin = publish(root / "failed-reconciliation-receipt.json", result)
            annotation = {"version": 1, "outcome": "failed", "receipt": result_pin, "original_state": plan["original_state_snapshot"]}
            if rollout.read_state(plan["job_dir"]) != original:
                raise ValueError("checkpoint changed after failed native acknowledgement")
            current = {**original, "canonical_reconciliation": annotation}
            if not rollout.canonical_reconciliation_valid(current):
                raise ValueError("failed receipt chain is invalid; preserve original UNKNOWN")
            candidate.replace(Path(plan["job_dir"]) / "state.json", candidate.encoded(current), plan["state"]["sha256"], 0o600)
    pointer = rollout.read_occupancy(Path(current["selector"]))
    if pointer["phase"] == "active":
        rollout.resolve_occupancy(current)
    return {**rollout.status(argparse.Namespace(job_dir=Path(plan["job_dir"]))), "operational_readiness": False}


def repair_request_key(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_:/.-]{8,200}", value):
        raise ValueError("TS repair requires one explicit stable request key")
    return value


def prepare_ts_repair(args):
    """Prepare a reviewable repair without requiring the failing HTTP consumer."""
    base = load_plan(args)
    if keeps_original_scheduler(base):
        raise ValueError("TS repair requires an observed successor scheduler")
    state = verify_current(base)
    request_key = repair_request_key(args.request_key)
    operator = {"path": str(args.repair_native_operator), "sha256": args.repair_native_operator_sha256}
    read_pin(operator, policy="unit", json_value=False)
    systemctl = pin("/usr/bin/systemctl", policy="unit")
    original_pin = {"path": str(args.plan), "sha256": args.plan_sha256}
    plan = {"version": 1, "kind": REPAIR_KIND, "operation": "restart_ts", "request_key": request_key,
            "job_id": state["job_id"], "job_dir": state["job_dir"], "original_plan": original_pin,
            "old_scheduler_identity": base["successor_scheduler_identity"],
            "native_runtime": base["native_runtime"], "systemctl": systemctl,
            "selector_sha256": state["selector_after_sha256"], "launcher_sha256": state["launcher_after_sha256"],
            "native_operator": operator, "validator_sources": source_pins(),
            "created_at_unix_ms": readiness.now_ms()}
    out = Path(args.output_directory)
    candidate.private_directory(out.parent)
    out.mkdir(mode=0o700)
    # No call to the HTTP endpoint or to a native effect is part of preparation.
    verify_current(base)
    return {"plan": publish(out / "plan.json", plan), "effects": "private_evidence_only"}


def load_ts_repair_plan(args):
    plan = read_pin({"path": str(args.plan), "sha256": args.plan_sha256})
    readiness.fields(plan, ("version", "kind", "operation", "request_key", "job_id", "job_dir", "original_plan",
        "old_scheduler_identity", "native_runtime", "systemctl", "selector_sha256", "launcher_sha256",
        "native_operator", "validator_sources", "created_at_unix_ms"))
    if plan["version"] != 1 or plan["kind"] != REPAIR_KIND or plan["operation"] != "restart_ts":
        raise ValueError("invalid TS repair plan")
    repair_request_key(plan["request_key"])
    if plan["systemctl"]["path"] != "/usr/bin/systemctl":
        raise ValueError("TS repair has no arbitrary command capability")
    if plan["validator_sources"] != source_pins():
        raise ValueError("TS repair validator source set changed")
    for value in [*plan["validator_sources"], plan["native_operator"], plan["systemctl"]]:
        read_pin(value, policy="unit", json_value=False)
    base = read_pin(plan["original_plan"])
    if base.get("version") != 1 or base.get("kind") != KIND or base.get("outcome") != "candidate":
        raise ValueError("TS repair requires the exact original reconciliation plan")
    if keeps_original_scheduler(base):
        raise ValueError("TS repair requires an observed successor scheduler")
    verify_sources(base)
    state = read_pin(base["original_state_snapshot"])
    if (plan["job_id"] != state["job_id"] or plan["job_dir"] != state["job_dir"]
            or plan["old_scheduler_identity"] != base["successor_scheduler_identity"]
            or plan["native_runtime"] != base["native_runtime"]
            or plan["selector_sha256"] != state["selector_after_sha256"]
            or plan["launcher_sha256"] != state["launcher_after_sha256"]):
        raise ValueError("TS repair changed the original job or observed runtime")
    return plan, base


def verify_ts_repair_unchanged(base):
    """Repeat durable and native fences without requiring the old TS to be live."""
    original = read_pin(base["original_state_snapshot"])
    if rollout.read_state(base["job_dir"]) != original:
        raise ValueError("original UNKNOWN checkpoint changed during TS repair")
    check_original(original)
    read_pin(base["state"])
    read_pin(base["occupancy"])
    original_install(base["install_plan"], base["install_receipt"], original)
    for key, value in base["bridge"].items():
        read_pin(value, policy="unit" if key == "sealed_bridge" else "private", json_value=False)
    pair = rollout.runtime_pair(Path(original["selector"]), Path(original["launcher"]),
        base["native_runtime"]["compat"]["pid"], base["native_runtime"]["core"]["pid"],
        expected_cwd=original["baseline_runtime"]["core"]["cwd"])
    if pair != base["native_runtime"]:
        raise ValueError("native runtime changed during TS-only repair")
    original_pair, observed = native_provenance(original, pair, base["native_restart_binding"],
        base.get("native_successor_status"), base.get("native_successor_parser"))
    if original_pair != base["original_native_runtime"] or observed != base["observed_native_successor"]:
        raise ValueError("native provenance changed during TS-only repair")
    for file_pin in base["successor_scheduler_identity"]["service"]["files"]:
        read_pin(file_pin, policy="unit", json_value=False)
    return original


def ts_repair_evidence(plan, base, args):
    root = Path(args.plan).parent
    output = root / "evidence.json"
    intent_path = Path(base["bridge"]["guard_intent"]["path"].removesuffix(".intent.json") + ".ts-repair.intent.json")
    plan_pin = {"path": str(args.plan), "sha256": args.plan_sha256}
    if output.exists():
        evidence_pin = pin(output)
        evidence = read_pin(evidence_pin)
        if (evidence.get("kind") != REPAIR_EVIDENCE_KIND or evidence.get("repair_plan") != plan_pin
                or evidence.get("request_key") != plan["request_key"] or evidence.get("state") != base["state"]):
            raise ValueError("existing TS repair evidence belongs to another request")
        verify_ts_repair_unchanged(base)
        if not intent_path.exists():
            # An unadmitted stale plan cannot be restamped into a fresh action.
            verify_current(base)
        return evidence_pin
    if intent_path.exists():
        raise ValueError("original TS repair intent requires its original evidence; never restart")
    state = verify_current(base)
    bridge = base["bridge"]
    evidence = {"version": 1, "kind": REPAIR_EVIDENCE_KIND, "request_key": plan["request_key"],
        "job_id": state["job_id"], "job_dir": state["job_dir"], "state": base["state"], "occupancy": base["occupancy"],
        "guard_intent": bridge["guard_intent"], "binding_sha256": bridge["binding"]["sha256"],
        "sealed_bridge": bridge["sealed_bridge"], "config_sha256": bridge["config"]["sha256"],
        "ledger_sha256": bridge["ledger"]["sha256"], "process_config_sha256": bridge["process_config"]["sha256"],
        "coordinator": state["coordinator"], "validated_at_unix_ms": readiness.now_ms(), "repair_plan": plan_pin}
    return publish(output, evidence)


def invoke_ts_repair(plan, base, evidence_pin):
    proof = owner_proof(read_pin(base["proof"]), read_pin(base["original_state_snapshot"]))
    request = {"version": 1, "action": "repair_ts", "proof": proof, "evidence": evidence_pin}
    read_pin(plan["native_operator"], policy="unit", json_value=False)
    # The native process owns the target lock for the complete fixed systemctl
    # operation. Python never executes a restart between check-only messages.
    started = readiness.now_ms()
    result, failure = None, None
    try:
        result = subprocess.run([plan["native_operator"]["path"], "--config", base["bridge"]["config"]["path"]],
            input=json.dumps(request), capture_output=True, text=True, timeout=180)
        stdout, stderr = result.stdout, result.stderr
    except subprocess.TimeoutExpired as error:
        failure, stdout, stderr = error, error.stdout, error.stderr
    except OSError as error:
        failure, stdout, stderr = error, b"", b""

    def captured(value):
        raw = value if isinstance(value, bytes) else (value or "").encode()
        # The capability is supplied only on stdin. Redact an accidental echo
        # before retaining bounded text; the digest still binds actual output.
        safe = raw.decode("utf-8", errors="replace").replace(proof["token"], "[redacted]").encode()
        limit = 64 * 1024
        return {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
            "text": safe[:limit].decode("utf-8", errors="ignore"), "truncated": len(safe) > limit}

    invocation = {"version": 1, "kind": "herder-native-ts-repair-invocation-v1",
        "job_id": plan["job_id"], "request_key": plan["request_key"], "evidence": evidence_pin,
        "operator": plan["native_operator"], "started_at_unix_ms": started, "finished_at_unix_ms": readiness.now_ms(),
        "returncode": None if result is None else result.returncode,
        "timed_out": isinstance(failure, subprocess.TimeoutExpired),
        "error_type": None if failure is None else type(failure).__name__,
        "stdout": captured(stdout), "stderr": captured(stderr)}
    publish(Path(evidence_pin["path"]).parent / ("native-invocation-" + uuid.uuid4().hex + ".json"), invocation)
    if failure is not None:
        raise RuntimeError("TS repair acknowledgement unavailable; inspect the archived original invocation and intent without replay") from None
    if result.returncode or len(result.stdout) > 65536:
        raise RuntimeError("TS repair acknowledgement unavailable; inspect the same intent without restart replay")
    envelope = json.loads(result.stdout)
    if envelope.get("ok") is not True or not isinstance(envelope.get("result"), dict):
        raise ValueError("native TS repair returned no typed acknowledgement")
    response = envelope["result"]
    intent_path = base["bridge"]["guard_intent"]["path"].removesuffix(".intent.json") + ".ts-repair.intent.json"
    if (response.get("requestKey") != plan["request_key"] or response.get("jobId") != plan["job_id"]
            or response.get("evidenceSha256") != evidence_pin["sha256"] or response.get("intentPath") != intent_path
            or not readiness.exact(response.get("repairId"), 200)
            or response.get("status") not in ("unknown", "recorded")
            or type(response.get("restartAttempted")) is not bool
            or response.get("bindingResolved") is not False or response.get("requiresReconciliation") is not True):
        raise ValueError("native TS repair acknowledgement does not bind the original unresolved job")
    intent_pin = {"path": response["intentPath"], "sha256": response["intentSha256"]}
    intent = read_pin(intent_pin)
    if (intent.get("version") != 1 or intent.get("kind") != "herder-project-release-ts-repair-intent-v1"
            or intent.get("evidence") != evidence_pin or intent.get("request_key") != plan["request_key"]
            or intent.get("job_id") != plan["job_id"] or intent.get("repair_id") != response["repairId"]
            or intent.get("repair_plan") != read_pin(evidence_pin)["repair_plan"]
            or intent.get("operator") != plan["native_operator"]
            or intent.get("old_process") != identity(plan["old_scheduler_identity"]["process"])):
        raise ValueError("TS repair intent does not bind the exact original request")
    receipt_path = intent_path.removesuffix(".intent.json") + ".receipt.json"
    if response["status"] == "recorded":
        if response.get("receiptPath") != receipt_path:
            raise ValueError("TS repair receipt is outside the original guard")
        receipt = read_pin({"path": receipt_path, "sha256": response["receiptSha256"]})
        result = receipt.get("systemctl", {})
        if (receipt.get("version") != 1 or receipt.get("kind") != "herder-project-release-ts-repair-receipt-v1"
                or receipt.get("job_id") != plan["job_id"] or receipt.get("request_key") != plan["request_key"]
                or receipt.get("repair_id") != response["repairId"]
                or receipt.get("evidence") != evidence_pin or receipt.get("intent") != intent_pin
                or receipt.get("operator") != plan["native_operator"]
                or receipt.get("old_process") != identity(plan["old_scheduler_identity"]["process"])
                or type(result.get("spawned")) is not bool or type(result.get("timed_out")) is not bool
                or (result.get("exit_code") is not None and type(result.get("exit_code")) is not int)
                or (result.get("signal") is not None and type(result.get("signal")) is not int)
                or not all(isinstance(result.get(key), str) and HASH.fullmatch(result[key])
                           for key in ("stdout_sha256", "stderr_sha256"))
                or type(receipt.get("started_at_unix_ms")) is not int
                or type(receipt.get("finished_at_unix_ms")) is not int
                or receipt["finished_at_unix_ms"] < receipt["started_at_unix_ms"]):
            raise ValueError("TS repair receipt is not the actual result of the pinned operation")
    elif "receiptPath" in response or "receiptSha256" in response:
        raise ValueError("unknown TS repair cannot claim a terminal receipt")
    return response


def observe_ts_repair_successor(plan):
    """A local observation is not a successful operational HTTP proof."""
    old = plan["old_scheduler_identity"]
    if rollout.identity_state(identity(old["process"])) != "dead":
        raise ValueError("TS repair has no proven replacement of its original process")
    environment = {**os.environ, "XDG_RUNTIME_DIR": "/run/user/" + str(os.getuid()),
        "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/" + str(os.getuid()) + "/bus",
        "SYSTEMD_PAGER": "cat", "SYSTEMD_COLORS": "0"}
    result = subprocess.run(["/usr/bin/systemctl", "--user", "show", readiness.UNIT, "--property=MainPID", "--value"],
        env=environment, capture_output=True, text=True, timeout=5)
    if result.returncode or not re.fullmatch(r"[1-9][0-9]*\n?", result.stdout):
        raise ValueError("TS repair successor MainPID is unavailable")
    expected = {key: copy.deepcopy(old[key]) for key in ("process", "runtime", "canonical")}
    expected["process"].update(readiness.birth(int(result.stdout)))
    observed = readiness.observe(expected)
    if (identity(observed["process"]) == identity(old["process"]) or observed["tree"] != old["tree"]
            or observed["service"]["files"] != old["service"]["files"]
            or observed["service"]["canonical_environment_sha256"] != old["service"]["canonical_environment_sha256"]):
        raise ValueError("TS repair changed the immutable service or runtime")
    return observed


def repair_ts(args):
    plan, base = load_ts_repair_plan(args)
    original = read_pin(base["original_state_snapshot"])
    with candidate.selector_lock(Path(original["selector"])):
        evidence_pin = ts_repair_evidence(plan, base, args)
        response = invoke_ts_repair(plan, base, evidence_pin)
        # The receipt records the actual command result, including failures.
        # Neither a returned acknowledgement nor a new PID resolves occupancy.
        verify_ts_repair_unchanged(base)
        observed, observation_error = None, None
        deadline = time.monotonic() + 60
        while True:
            try:
                observed = observe_ts_repair_successor(plan)
                observation_error = None
                break
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                observation_error = {"type": type(error).__name__, "message_sha256": hashlib.sha256(str(error).encode()).hexdigest()}
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.5)
        verify_ts_repair_unchanged(base)
        receipt = None if response["status"] == "unknown" else {"path": response["receiptPath"], "sha256": response["receiptSha256"]}
        observation = {"version": 1, "kind": "herder-canonical-ts-repair-observation-v1", "request_key": plan["request_key"],
            "job_id": plan["job_id"], "plan": {"path": str(args.plan), "sha256": args.plan_sha256}, "evidence": evidence_pin,
            "native_acknowledgement": response, "native_receipt": receipt,
            "old_scheduler_identity": plan["old_scheduler_identity"], "observed_successor": observed,
            "observation_error": observation_error, "native_runtime": plan["native_runtime"],
            "original_state": base["original_state_snapshot"], "original_outcome": "unknown",
            "binding_resolved": False, "requires_reconciliation": True, "operational_readiness": False,
            "observed_at_unix_ms": readiness.now_ms()}
        # Each invocation preserves its own factual observation; a repeated
        # invocation can only inspect the native one-shot request above.
        output = Path(args.plan).parent / ("observation-" + uuid.uuid4().hex + ".json")
        return {"observation": publish(output, observation), "status": response["status"],
                "successor_observed": observed is not None, "requires_reconciliation": True}, (0 if observed else 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser("prepare")
    for key in ("job-dir", "proof", "http-helper", "native-operator", "native-restart-binding", "output-directory"):
        p.add_argument("--" + key, type=Path, required=True)
    for key in ("install-plan", "install-receipt"):
        p.add_argument("--" + key, type=Path)
    for key in ("state-sha256", "http-helper-sha256", "native-operator-sha256", "native-restart-binding-sha256"):
        p.add_argument("--" + key, required=True)
    for key in ("ts-pid", "compat-pid", "core-pid"):
        p.add_argument("--" + key, type=int, required=True)
    p.add_argument("--service-change", nargs=3, action="append", default=[], metavar=("PATH", "OLD_SHA256", "NEW_SHA256"))
    for key in ("native-successor-status", "native-successor-parser"):
        p.add_argument("--" + key, type=Path)
        p.add_argument("--" + key + "-sha256")
    o = commands.add_parser("observe")
    o.add_argument("--output-directory", type=Path, required=True)
    o.add_argument("--probe-harness", required=True)
    o.add_argument("--probe-native-session-id", required=True)
    o.add_argument("--probe-node-ref")
    f = commands.add_parser("finalize")
    for key in ("observation", "output"):
        f.add_argument("--" + key, type=Path, required=True)
    for key in ("observation-sha256", "provider-operation-id"):
        f.add_argument("--" + key, required=True)
    a = commands.add_parser("apply")
    for key in ("consumer-receipt", "scheduler-proof"):
        a.add_argument("--" + key, type=Path, required=True)
    for sub in (o, f, a):
        sub.add_argument("--plan", type=Path, required=True)
        sub.add_argument("--plan-sha256", required=True)
    prep = commands.add_parser("prepare-ts-repair")
    prep.add_argument("--repair-native-operator", type=Path, required=True)
    prep.add_argument("--repair-native-operator-sha256", required=True)
    prep.add_argument("--request-key", required=True)
    prep.add_argument("--output-directory", type=Path, required=True)
    repair = commands.add_parser("repair-ts")
    for sub in (prep, repair):
        sub.add_argument("--plan", type=Path, required=True)
        sub.add_argument("--plan-sha256", required=True)
    failed_prepare = commands.add_parser("prepare-failed")
    for key in ("failed-native-operator", "effect-input", "output-directory"):
        failed_prepare.add_argument("--" + key, type=Path, required=True)
    for key in ("failed-native-operator-sha256", "effect-input-sha256"):
        failed_prepare.add_argument("--" + key, required=True)
    failed_finalize = commands.add_parser("finalize-failed")
    for key in ("observation", "provider-result", "output"):
        failed_finalize.add_argument("--" + key, type=Path, required=True)
    for key in ("observation-sha256", "provider-result-sha256"):
        failed_finalize.add_argument("--" + key, required=True)
    failed_apply = commands.add_parser("apply-failed")
    for key in ("failure-proof", "native-provider-result"):
        failed_apply.add_argument("--" + key, type=Path, required=True)
        failed_apply.add_argument("--" + key + "-sha256", required=True)
    for sub in (failed_prepare, failed_finalize, failed_apply):
        sub.add_argument("--plan", type=Path, required=True)
        sub.add_argument("--plan-sha256", required=True)
    args = parser.parse_args()
    value = globals()[args.command.replace("-", "_")](args)
    result, code = value if isinstance(value, tuple) else (value, 0)
    print(json.dumps(result, sort_keys=True))
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(json.dumps({"status": "refused", "error_type": type(exc).__name__}))
        sys.exit(1)
