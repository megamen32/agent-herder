import { afterEach, describe, expect, it } from "vitest";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectReleaseLeaseStore } from "../src/project-release-lease.js";
import { canonicalAuthority, withCanonicalGuard } from "../src/project-release-canonical.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const owner = { hostId: "fixture", harness: "test", nativeSessionId: "session-a" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "herder-canonical-facade-")); directories.push(root);
  const ledger = join(root, "ledger.json"), config = join(root, "config.json"), bridge = join(root, "bridge.py"), calls = join(root, "calls.jsonl");
  await writeFile(config, JSON.stringify({ calls, owner }), { mode: 0o600 });
  await writeFile(calls, "", { mode: 0o600 });
  await writeFile(bridge, `#!/usr/bin/env python3
import json,sys
config=json.load(open(sys.argv[2]))
guard=False
for line in sys.stdin:
 request=json.loads(line)
 with open(config['calls'],'a') as out: out.write(json.dumps({'request':request,'argv':sys.argv})+'\\n')
 action=request['action']
 lease={'project':request.get('project','project'),'owner':config['owner'],'fence':119,'acquiredAt':1000,'expiresAt':301000}
 if request.get('token')=='b'*64: response={'ok':False,'error':'proof_mismatch'}
 else:
  if action=='acquire': result={'acquired':True,'lease':lease,'token':request['token']}
  elif action=='status': result={'lease':lease,'remainingSeconds':300,'nextFence':120,'deploymentInProgress':False,'contact':None,'resourceRef':'build-slot','revision':1}
  elif action=='release': result={'released':True}
  elif action=='guard': guard=True;result={'guarded':True,'guardId':'fixture-guard','lease':lease}
  elif action=='finished': guard=False;result={'finished':True}
  else: result=lease
  response={'ok':True,'result':result}
 print(json.dumps(response),flush=True)
if guard:
 with open(config['calls'],'a') as out: out.write(json.dumps({'unresolved':True})+'\\n')
`, { mode: 0o700 });
  await chmod(bridge, 0o700);
  const state = { version: 2, canonical: { version: 1, config, bridge, seal_id: "reviewed-fixture-seal" }, projects: { project: { fence: 118 } } };
  await writeFile(ledger, JSON.stringify(state), { mode: 0o600 });
  const history = async () => (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean).map(v => JSON.parse(v));
  return { root, ledger, state, calls, history, store: new ProjectReleaseLeaseStore(ledger) };
}

describe("sealed project release compatibility facade", () => {
  it.skipIf(!process.env.HERDER_RESOURCE_BRIDGE_BIN)("roundtrips real Rust ownership and guarded integration cleanup", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "herder-real-ts-facade-"))); directories.push(root);
    const binary = join(root, "herder_resource_bridge");
    await copyFile(process.env.HERDER_RESOURCE_BRIDGE_BIN!, binary); await chmod(binary, 0o755);
    const authority = join(root, "authority"), resources = join(authority, "resources"), resource = join(resources, "release");
    const project = join(root, "repo", ".git"), fleet = join(root, "fleet"), execution = join(root, "executions");
    for (const path of [authority, resources, resource, join(root, "repo"), project, fleet, execution]) {
      await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700);
    }
    const save = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await save(join(authority, "storage.json"), { schema: "v1", storage_id: "fixture-storage" });
    await save(join(resource, "resource.json"), { schema: "v1", storage_id: "fixture-storage", resource_ref: "release", scope: { type: "global" },
      descriptor: { resource_ref: "release", scope: { type: "global" }, kind: { type: "deployment" }, external_ref: "fixture-ts-target", authority_ref: "fixture-storage", attachment: null, revision: 1 } });
    const processConfig = join(root, "process.json"), config = join(root, "compat.json"), ledger = join(root, "ledger.json");
    const deploymentTarget = { fleetDir: fleet, unit: "fixture.service" };
    await save(processConfig, { version: 1, node_ref: hostname(), worker: binary, execution_root: execution,
      resources: { storage_id: "fixture-storage", authority_node: hostname(), root: authority, schema: "v1", route: { type: "local" } }, administrators: ["alice"] });
    await save(config, { version: 1, process_config: processConfig, ledger, seal_id: "ts-fixture-seal", principal_ref: "alice",
      mappings: [{ project, resource_ref: "release", revision: 1, previous_fence: 118, deployment_target: deploymentTarget }] });
    await save(ledger, { version: 2, canonical: { version: 1, config, bridge: binary, seal_id: "ts-fixture-seal" }, projects: { [project]: { fence: 118 } } });
    const store = new ProjectReleaseLeaseStore(ledger), before = await readFile(ledger, "utf8");
    const acquired = await store.acquire(project, owner, 30, deploymentTarget);
    expect(acquired.acquired).toBe(true); if (!acquired.acquired) throw new Error("fixture acquire failed");
    expect(acquired.lease.fence).toBe(119);
    const proof = { owner, token: acquired.token, fence: acquired.lease.fence };
    expect((await store.status(project)).lease?.fence).toBe(119);
    await store.renew(project, proof, 60);
    expect((await store.check(project, proof)).owner).toEqual(owner);
    expect(await readFile(ledger, "utf8")).toBe(before);
    await store.projectLifecycle(project, owner, "/fixture/worktree", "active", 1000);
    await store.projectLifecycle(project, owner, "/fixture/worktree", "ended", 1001);
    const prepared = await store.prepareIntegration(project, owner, "fixture-inventory", { target: "main" });
    const id = prepared.integration!.id;
    await store.claimIntegration(project, proof, id);
    expect(await store.withIntegrationCleanup(project, proof, id, "/fixture/worktree", async () => "completed")).toBe("completed");
    expect(JSON.parse(await readFile(join(resource, "execution-binding.json"), "utf8")).resolved_receipt).toBeTruthy();
    // Proof identity survives repository cleanup or relocation after admission.
    await rename(join(root, "repo"), join(root, "moved-repo"));
    await store.release(project, proof);
    expect((await store.status(project)).lease).toBeNull();
    expect(JSON.parse(await readFile(ledger, "utf8")).projects[project].lease).toBeUndefined();
  });

  it("routes all ownership operations to the bridge without rewriting legacy ownership", async () => {
    const f = await fixture(), before = await readFile(f.ledger, "utf8");
    const acquired = await f.store.acquire("project", owner, 300);
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) throw new Error("fixture acquisition failed");
    const proof = { owner, token: acquired.token, fence: acquired.lease.fence };
    expect(proof.token).toMatch(/^[a-f0-9]{64}$/);
    expect((await f.store.status("project")).resourceRef).toBe("build-slot");
    await f.store.renew("project", proof, 300);
    await f.store.check("project", proof);
    await f.store.release("project", proof);
    expect(await readFile(f.ledger, "utf8")).toBe(before);
    const history = await f.history();
    expect(history.map(v => v.request.action)).toEqual(["acquire", "status", "renew", "check", "release"]);
    expect(JSON.stringify(history.map(v => v.argv))).not.toContain(proof.token);
    expect(history[0].request.token).toBe(proof.token);
    expect(await f.store.endSession(owner, Date.now())).toEqual({ released: 0 });
    expect((await f.history()).length).toBe(5);
  });

  it("never falls back to a legacy lease when canonical proof is rejected", async () => {
    const f = await fixture(), before = await readFile(f.ledger, "utf8");
    await expect(f.store.check("project", { owner, token: "b".repeat(64), fence: 119 })).rejects.toThrow("proof_mismatch");
    expect(await readFile(f.ledger, "utf8")).toBe(before);
    expect(JSON.parse(before).projects.project.lease).toBeUndefined();
  });

  it("rejects a mixed seal containing any old owner record", async () => {
    const f = await fixture();
    const mixed = { ...f.state, projects: { project: { fence: 118, lease: null } } };
    await writeFile(f.ledger, JSON.stringify(mixed));
    await expect(f.store.status("project")).rejects.toThrow("release_canonical_seal_invalid");
    expect(await f.history()).toEqual([]);
    expect(canonicalAuthority({ version: 1, projects: {} })).toBeUndefined();
    expect(() => canonicalAuthority({ version: 1, canonical: f.state.canonical, projects: {} })).toThrow();
    const nested = { ...f.state, projects: { project: { inventory: [{ lease: null }] } } };
    expect(() => canonicalAuthority(nested)).toThrow("release_canonical_seal_invalid");
  });

  it("keeps advisory lifecycle metadata without creating an owner", async () => {
    const f = await fixture();
    await f.store.projectLifecycle("project", owner, "/fixture/worktree", "active", 1000);
    await f.store.projectLifecycle("project", owner, "/fixture/worktree", "ended", 1001);
    const saved = JSON.parse(await readFile(f.ledger, "utf8"));
    expect(saved.version).toBe(2);
    expect(saved.canonical).toEqual(f.state.canonical);
    expect(saved.projects.project.lease).toBeUndefined();
    expect(Object.values(saved.projects.project.sessions)).toHaveLength(1);
  });

  it("holds the guard through an effect and declares finished only after success", async () => {
    const f = await fixture(), authority = canonicalAuthority(f.state)!;
    const request = { project: "project", owner, token: "a".repeat(64), fence: 119 };
    expect(await withCanonicalGuard(authority, request, async () => {
      expect((await f.history()).map(v => v.request?.action)).toEqual(["guard"]);
      return "effect-complete";
    })).toBe("effect-complete");
    expect((await f.history()).map(v => v.request?.action)).toEqual(["guard", "finished"]);
    await expect(withCanonicalGuard(authority, request, async () => { throw new Error("effect outcome unknown"); })).rejects.toThrow("effect outcome unknown");
    for (let attempt = 0; attempt < 100 && !(await f.history()).some(v => v.unresolved); attempt++)
      await new Promise(resolve => setTimeout(resolve, 10));
    const history = await f.history();
    expect(history.filter(v => v.request?.action === "finished")).toHaveLength(1);
    expect(history.at(-1).unresolved).toBe(true);
  });
});
