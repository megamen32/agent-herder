#!/usr/bin/env python3
"""Opt-in real native process lease canary with private authority and durable effect receipts.

The selected installed harness is reused only for newly created QA sessions.
No shared Herder selector or ownership store is modified. Effects are checkpointed
before admission and are never replayed automatically after an uncertain result.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time

MARKER = "PROCESS_LEASES_V1"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def create(path, value, mode=0o600):
    data = value if isinstance(value, bytes) else (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, "wb") as out:
        out.write(data); out.flush(); os.fsync(out.fileno())


def save(path, value):
    fd, name = tempfile.mkstemp(prefix=".canary-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as out:
            json.dump(value, out, indent=2, sort_keys=True); out.write("\n")
            out.flush(); os.fsync(out.fileno())
        os.replace(name, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        if os.path.exists(name): os.unlink(name)


def check(ok, reason):
    if not ok: raise RuntimeError(reason)


class MCP:
    def __init__(self, root, state):
        self.seq = 0
        self.buffer = b""
        self.err = open(root / "native-mcp.stderr.log", "ab")
        self.proc = subprocess.Popen(
            [sys.executable, state["launcher"]], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=self.err, bufsize=0, start_new_session=True,
            env=dict(os.environ, HERDER_V1_ENTRY=str(root / "selector.json")))
        self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                               "clientInfo": {"name": "process-lease-canary", "version": "1"}})
        self.notify("notifications/initialized", {})
        self.tools = self.rpc("tools/list", {})["tools"]

    def notify(self, method, params):
        self.proc.stdin.write((json.dumps({"jsonrpc":"2.0", "method":method, "params":params})+"\n").encode())
        self.proc.stdin.flush()

    def rpc(self, method, params):
        self.seq += 1; ident = self.seq
        self.proc.stdin.write((json.dumps({"jsonrpc":"2.0", "id":ident, "method":method, "params":params})+"\n").encode())
        self.proc.stdin.flush()
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            if b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                result = json.loads(line)
                if result.get("id") != ident: continue
                if "error" in result: raise RuntimeError("RPC error: " + json.dumps(result["error"])[:500])
                return result.get("result", {})
            wait = max(0, deadline-time.monotonic())
            if not select.select([self.proc.stdout], [], [], wait)[0]: break
            data = os.read(self.proc.stdout.fileno(), 65536)
            if not data: raise RuntimeError("candidate MCP exited; inspect private stderr")
            self.buffer += data
        raise TimeoutError("MCP timeout: effect UNKNOWN, no replay")

    def call(self, name, args):
        read_only = (name, args.get("action")) in {
            ("automation", "get"), ("resource", "get"),
            ("session", "messages"), ("compat_task", "get")}
        retry_deadline = time.monotonic()+150
        while True:
            value = self.rpc("tools/call", {"name": name, "arguments": args})
            if not value.get("isError"): break
            detail = value.get("structuredContent") or value.get("content")
            # A canonical writer may hold the gate during a bounded native
            # admission. Retry this read only; never retry a possible effect.
            if read_only and isinstance(detail, dict) and detail.get("effect") == "none" and detail.get("code") == "scope_unavailable" and time.monotonic()<retry_deadline:
                time.sleep(0.5);continue
            raise RuntimeError("tool "+name+" failed: "+json.dumps(detail)[:1000])
        data = value.get("structuredContent")
        if isinstance(data, dict): return data
        for part in value.get("content", []):
            if part.get("type") == "text":
                try:
                    data = json.loads(part["text"])
                    if isinstance(data, dict): return data
                except ValueError: pass
        return value

    def close(self):
        if self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGTERM)
            try: self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL); self.proc.wait(timeout=5)
        self.err.close()


def effect(client, root, state, label, tool, args):
    check(label not in state["effects"], label+" was already attempted; inspect receipt, no replay")
    state["effects"][label] = {"status": "UNKNOWN", "tool": tool,
                               "request_key": args.get("request_key"), "started_at": time.time()}
    save(root / "checkpoint.json", state)
    value = client.call(tool, args)
    state["effects"][label].update(status="returned", result=value)
    save(root / "checkpoint.json", state)
    return value


def task_ref(value):
    return value.get("task_ref") or value.get("taskId") or value.get("_herder_create_task") or value.get("_herder_delivery_task")


def observe_task(client, root, state, label, timeout=180):
    admission = state["effects"][label]["result"]
    ref = task_ref(admission)
    check(ref, "missing durable task reference")
    deadline = time.monotonic()+timeout
    while time.monotonic() < deadline:
        value = client.call("compat_task", {"action": "get", "task_ref": ref})
        state["effects"][label]["observed_task"] = value
        save(root/"checkpoint.json", state)
        if value.get("status") == "completed":
            result = value.get("result") or {}
            completed = result.get("structuredContent") or result
            # Creation and first prompt are different effects. Preserve a
            # confirmed native identity even when admission or the model fails.
            session = completed.get("create", {}).get("session_ref") or completed.get("session_ref")
            if label == "create_session" and session:
                with sqlite3.connect("file:"+state["database"]+"?mode=ro", uri=True) as db:
                    rows = db.execute("SELECT native_session_id,node_ref,instance_id FROM session_bindings WHERE session_ref=?",
                                      (session,)).fetchall()
                check(len(rows) == 1, "confirmed create has no exact durable native binding")
                state["session_ref"] = session
                state["native_session_id"],state["native_node_ref"],state["native_instance_id"] = rows[0]
                save(root/"checkpoint.json", state)
            check(not result.get("isError"), "native task completed with an error")
            return completed
        if value.get("status") in ("failed", "cancelled"):
            raise RuntimeError("native task "+value["status"])
        time.sleep(3)
    raise TimeoutError("native task has no terminal receipt; no replay")


def messages(client, session):
    value = client.call("session", {"action":"messages", "session_ref":session})
    page = value.get("page", value)
    return page, page.get("messages", [])


def wait_marker(client, session, marker, timeout=120):
    deadline = time.monotonic()+timeout
    while time.monotonic()<deadline:
        page, rows = messages(client, session)
        found = [x for x in rows if x.get("role") == "assistant" and x.get("text", "").strip() == marker]
        if found:
            return {"count":len(found), "ids":[x.get("id") for x in found],
                    "text":[x.get("text") for x in found], "history_complete":page.get("complete")}
        time.sleep(3)
    raise TimeoutError("native assistant marker missing; no resend")


def prepare(args):
    root = args.root
    check(root.is_absolute() and root.resolve() == root and root.parent.is_dir(), "canonical existing parent required")
    if not root.exists(): root.mkdir(mode=0o700)
    check(root.stat().st_uid == os.getuid() and not root.stat().st_mode & 0o077, "private canary root required")
    check(not (root/"checkpoint.json").exists(), "canary already prepared")
    manifest_path = args.manifest
    manifest = json.loads(manifest_path.read_text())
    for key in ("core", "compat", "node", "bootstrap", "process_worker", "process_config"):
        check(sha(manifest[key]) == manifest["sha256"][key], "artifact digest mismatch: "+key)
    base = json.loads(args.profile.read_text())
    migration_profile = None
    if "adapter_migration" in manifest:
        helper_path = Path(__file__).resolve().parents[2]/"deploy/fleet/process-leases-candidate.py"
        spec = importlib.util.spec_from_file_location("process_lease_candidate", helper_path)
        candidate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(candidate)
        # Validate the complete old/new component and profile transition.
        # This reads staged payloads and never creates live authority files.
        candidate.check_candidate(manifest_path.parent/"selector.json",
                                  manifest_path.parent/"fixture/launch-v1-core.py")
        migration = candidate.read_json(manifest["adapter_migration"])
        rows = [row for row in migration["profiles"] if row["previous_path"] == str(args.profile)]
        check(len(rows) <= 1, "ambiguous migrated profile")
        if rows:
            migration_profile = rows[0]
            check(sha(args.profile) == migration_profile["previous_sha256"], "original profile changed")
            check(sha(migration_profile["payload"]) == migration_profile["payload_sha256"], "staged profile changed")
            base = candidate.read_json(migration_profile["payload"])
    kind = base["owner"]["kind"]
    check(kind in ("codex", "opencode", "zcode", "chatgpt", "zai", "hermes"), "unsupported explicit harness")
    remote = base["owner"]["ahap_script"] != manifest["adapters"][kind]
    if remote:
        matches = [w for w in manifest.get("remote_ahap_wrappers", []) if
            (w["node"], w["instance"], w["kind"], w["script"]) ==
            (base["owner"]["node"], base["owner"]["instance"], kind, base["owner"]["ahap_script"])]
        check(len(matches) == 1, "exact pinned remote wrapper required")
        check(sha(base["owner"]["ahap_script"]) == matches[0]["script_sha256"] and
              sha(base["owner"]["ahap_script"] + ".json") == matches[0]["config_sha256"],
              "remote wrapper/config digest mismatch")
    else:
        check(sha(base["owner"]["ahap_script"]) == manifest["sha256"]["adapters"][kind], "adapter digest mismatch")
    protected = root/"herder-owner-home"
    protected.mkdir(mode=0o700)
    out = subprocess.run([manifest["bootstrap"], str(protected)], check=True, capture_output=True, text=True, timeout=30)
    seed = json.loads(out.stdout)
    work = root/"work";work.mkdir(mode=0o700)
    create(work/"AGENTS.md", b"QA fixture only. The only authorized task is to echo the exact requested marker and end the turn. Do not use tools, read other workspaces, change files, or start agents.\n")
    create(work/"hello.c", b'#include <stdio.h>\nint main(void) { puts("PROCESS_BUILD_OK"); return 0; }\n')
    build_source = """import os,subprocess,time
from pathlib import Path
root=Path(__file__).parent
fd=os.open(root/'build-started',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
os.write(fd,b'one build\\\\n');os.close(fd)
subprocess.run(['/usr/bin/cc',str(root/'hello.c'),'-o',str(root/'hello')],check=True)
out=subprocess.check_output([str(root/'hello')],text=True).strip()
assert out=='PROCESS_BUILD_OK'
print(out,flush=True)
time.sleep(40)
print('PROCESS_BUILD_FINISHED',flush=True)
"""
    create(work/"build.py", build_source.encode())
    for argv in (["git","init","--quiet"], ["git","add","AGENTS.md","hello.c","build.py"],
                 ["git","-c","user.name=Herder QA","-c","user.email=qa@localhost","-c","core.hooksPath=/dev/null","commit","--quiet","-m","Process lease canary fixture"]):
        subprocess.run(argv, cwd=work, check=True, capture_output=True)
    owner = copy.deepcopy(base["owner"])
    if not remote:
        owner["cwd"] = str(work)
        if kind == "zcode": owner.setdefault("ahap_env", {})["AHAP_ZCODE_CWD"] = str(work)
        if kind == "codex": owner.setdefault("ahap_env", {})["AHAP_CODEX_CWD"] = str(work)
    profile = Path(seed["profile_seed"]).parent/"profile.json"
    create(profile, {k:seed[k] for k in ("database","gate","generation")} | {"owner":owner})
    config = json.loads(Path(manifest["process_config"]).read_text())
    config.update(execution_root=str(root/"executions"), administrators=[owner["principal"]])
    config["resources"].update(root=str(root/"resources"), storage_id="qa-process-"+root.name)
    for directory in (root/"executions",root/"resources",root/"resources/resources"): directory.mkdir(mode=0o700)
    create(root/"resources/storage.json", {"schema":"v1","storage_id":config["resources"]["storage_id"]})
    create(root/"process-runtime.json", config, 0o400)
    isolated = copy.deepcopy(manifest)
    isolated["process_config"] = str(root/"process-runtime.json")
    isolated["sha256"]["process_config"] = sha(root/"process-runtime.json")
    # A candidate that carries the wait reader is tested with the same pinned helper.
    create(root/"manifest.json", isolated, 0o400)
    create(root/"selector.json", {"manifest":str(root/"manifest.json"),"manifest_sha256":sha(root/"manifest.json"),"profiles":[str(profile)]}, 0o400)
    state = {"version":1,"status":"prepared","run":root.name,"effects":{},
             "source_commit":manifest["source_commit"],"base_manifest":str(manifest_path),"base_manifest_sha256":sha(manifest_path),
             "base_profile":str(args.profile),"base_profile_sha256":sha(args.profile),
             "profile":str(profile),"database":seed["database"],"generation":seed["generation"],
             "instance_ref":owner["instance"],"kind":kind,"work":str(work),
             "launcher":str(manifest_path.parent/"fixture/launch-v1-core.py"),
             "resource_ref":"qa:process-build:"+root.name,"storage_id":config["resources"]["storage_id"]}
    if migration_profile:
        state["adapter_profile_migration"] = {key:migration_profile[key] for key in
            ("kind","previous_path","previous_sha256","path","sha256","payload","payload_sha256")}
        state["adapter_migration_sha256"] = manifest["sha256"]["adapter_migration"]
    create(root/"checkpoint.json", state)
    return state


def session_start(client, root, state):
    marker = "READY_"+MARKER
    prompt = ("This is a disposable test session for Agent Herder. Do not use tools, inspect files, contact anyone, or start work. "
              "Reply exactly "+marker+" and end this turn. When a later process completion receipt arrives, "
              "reply exactly RESUMED_"+MARKER+" exit=0 and end the turn. Never continue a repository task.")
    result = effect(client,root,state,"create_session","create",{"action":"create","instance_ref":state["instance_ref"],
        "prompt":prompt,"request_key":state["run"]+"-create"})
    state["create_admission"] = result;save(root/"checkpoint.json",state)
    completed = observe_task(client,root,state,"create_session")
    session = completed.get("create", {}).get("session_ref") or completed.get("session_ref")
    check(session, "native create receipt has no session reference")
    state["session_ref"] = session;save(root/"checkpoint.json",state)
    state["initial_reply"] = wait_marker(client,session,marker)
    with sqlite3.connect("file:"+state["database"]+"?mode=ro", uri=True) as db:
        rows=db.execute("SELECT native_session_id,node_ref,instance_id FROM session_bindings WHERE session_ref=?",(session,)).fetchall()
    check(len(rows)==1, "exact native session binding missing")
    state["native_session_id"],state["native_node_ref"],state["native_instance_id"]=rows[0]
    state["status"]="session_ready";save(root/"checkpoint.json",state)


def run_process(client,root,state):
    check(state.get("status")=="session_ready", "exact initial assistant reply required")
    resource=state["resource_ref"]
    descriptor=effect(client,root,state,"resource_register","resource",{"action":"register","resource_ref":resource,
        "scope":{"type":"global"},"kind":{"type":"other","name":"build"},"external_ref":"fixture:"+state["run"],
        "authority_ref":state["storage_id"]})
    state["descriptor"]=descriptor
    expires=int(time.time())+15
    claim=effect(client,root,state,"resource_claim","resource",{"action":"claim","resource_ref":resource,
        "purpose":"Only this QA build","request_key":state["run"]+"-claim","expires_at":"unix-seconds:"+str(expires)})
    state["initial_claim"]=claim;save(root/"checkpoint.json",state)
    current=client.call("resource",{"action":"get","resource_ref":resource})
    state["initial_resource"]=current
    claim_id=(current.get("claim") or {}).get("claim_id") or claim.get("claim_id")
    revision=(current.get("resource") or {}).get("revision") or descriptor.get("revision")
    check(claim_id and revision,"canonical resource/claim receipt missing")
    rule={"kind":"process_completion","execution":{"mode":"start","argv":[sys.executable,str(root/"work/build.py")],
        "cwd":state["work"],"deadline_unix_ms":int(time.time()*1000)+180000,"stop_grace_ms":1000},
        "bindings":[{"resource_ref":resource,"claim_id":claim_id,"revision":revision,"ttl_seconds":15,"on_exit":"release"}],
        "wake_message":"The supervised QA build has finished. Do not use tools. Reply exactly RESUMED_"+MARKER+" exit=0 and end."}
    admission=effect(client,root,state,"process_wait","automation",{"action":"create","session_ref":state["session_ref"],
        "rule":rule,"request_key":state["run"]+"-process"})
    state["process_admission"]=admission
    state["rule_ref"]=admission.get("rule_ref")
    state["status"]="process_registered";save(root/"checkpoint.json",state)
    check(state["rule_ref"],"durable rule reference missing")
    time.sleep(4)
    state["before_restart"]=client.call("automation",{"action":"get","rule_ref":state["rule_ref"]})
    save(root/"checkpoint.json",state)
    client.close()
    time.sleep(18)
    client=MCP(root,state)
    state["renewed_resource"]=client.call("resource",{"action":"get","resource_ref":resource})
    state["after_restart"]=client.call("automation",{"action":"get","rule_ref":state["rule_ref"]})
    renewed=(state["renewed_resource"].get("claim") or {}).get("expires_at")
    check(renewed and renewed.startswith("unix-seconds:") and int(renewed.split(":")[1])>int(time.time()),
          "worker did not renew the claim while core was absent")
    check(Path(state["work"],"build-started").read_text()=="one build\\n","build start receipt mismatch")
    state["renewal_after_core_restart"]=True;save(root/"checkpoint.json",state)
    return client


def observe(client,root,state):
    check(state.get("rule_ref") and state.get("session_ref"), "existing process receipt required")
    deadline=time.monotonic()+180
    while time.monotonic()<deadline:
        value=client.call("automation",{"action":"get","rule_ref":state["rule_ref"]})
        state["process_observed"]=value;save(root/"checkpoint.json",state)
        # Read the persisted wait state without guessing a tool response projection.
        with sqlite3.connect("file:"+state["database"]+"?mode=ro",uri=True) as db:
            entries=db.execute("SELECT setting_key,value_json FROM settings WHERE setting_key LIKE 'state:process-rule:%'").fetchall()
        states=[json.loads(v) for k,v in entries if state["rule_ref"] in k]
        if states and states[0].get("phase")=="confirmed":break
        if states and states[0].get("phase") in ("rejected","cancelled"):
            raise RuntimeError("wake requires reconciliation: "+states[0]["phase"])
        time.sleep(3)
    else:raise TimeoutError("automatic wake receipt not confirmed")
    state["wait_state"]=states[0]
    state["wake_reply"]=wait_marker(client,state["session_ref"],"RESUMED_"+MARKER+" exit=0")
    state["terminal_resource"]=client.call("resource",{"action":"get","resource_ref":state["resource_ref"]})
    check(state["terminal_resource"].get("claim") is None,"claim not released after complete process tree")
    check(state["wake_reply"]["count"]==1,"unexpected multiple native assistant wake replies")
    state["artifact_sha256"]=sha(root/"work/hello")
    with sqlite3.connect("file:"+state["database"]+"?mode=ro",uri=True) as db:
        intents=db.execute("SELECT task_id,state,native_receipt FROM intents WHERE request_key=?",
                           ("process-wake:"+state["rule_ref"],)).fetchall()
    check(len(intents)==1 and intents[0][1]=="confirmed" and intents[0][2],"exact canonical native delivery receipt missing")
    state["wake_intents"]=[{"task_id":x[0],"state":x[1],"native_receipt":json.loads(x[2])} for x in intents]
    state["status"]="PASS";save(root/"checkpoint.json",state)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",type=Path,required=True)
    parser.add_argument("--action",choices=["prepare","preflight","start-session","reconcile-session","run-process","observe","archive"],required=True)
    parser.add_argument("--manifest",type=Path)
    parser.add_argument("--profile",type=Path)
    args=parser.parse_args();root=args.root;client=None
    state=None
    try:
        if args.action=="prepare":
            check(args.manifest and args.profile,"prepare needs explicit manifest/profile")
            state=prepare(args)
        else:
            state=json.loads((root/"checkpoint.json").read_text())
            client=MCP(root,state)
            if args.action=="preflight":
                state["preflight"]={"tools":[x["name"] for x in client.tools],
                    "instances":client.call("discover",{"action":"instances"})}
                save(root/"checkpoint.json",state)
            elif args.action=="start-session":session_start(client,root,state)
            elif args.action=="reconcile-session":
                # Reads the original task only. Never repeats create or prompt.
                completed = observe_task(client,root,state,"create_session",timeout=30)
                check(state.get("session_ref"), "create identity remains unknown")
                state["initial_reply"] = wait_marker(client,state["session_ref"],"READY_"+MARKER,timeout=30)
                state["status"]="session_ready";save(root/"checkpoint.json",state)
            elif args.action=="run-process":
                client=run_process(client,root,state);observe(client,root,state)
            elif args.action=="observe":observe(client,root,state)
            elif args.action=="archive":
                check(state.get("status")=="PASS","archive only verified completed QA")
                state["archive"]=effect(client,root,state,"archive","session",{"action":"archive","session_ref":state["session_ref"],"request_key":state["run"]+"-archive"})
                save(root/"checkpoint.json",state)
        print(json.dumps({"status":state["status"],"checkpoint":str(root/"checkpoint.json"),
            "session_ref":state.get("session_ref"),"native_session_id":state.get("native_session_id"),
            "rule_ref":state.get("rule_ref"),"source_commit":state["source_commit"]},sort_keys=True))
    except Exception as error:
        if state:
            state["last_error"]={"action":args.action,"type":type(error).__name__,"message":str(error)[:1200],"at":time.time()}
            save(root/"checkpoint.json",state)
        print(json.dumps({"status":"INCOMPLETE","error_type":type(error).__name__,"error":str(error)[:1200]}),file=sys.stderr)
        raise
    finally:
        if client:client.close()


if __name__=="__main__":
    main()
