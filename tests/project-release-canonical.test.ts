import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { ProjectReleaseLeaseStore, type ReleaseAcquisition } from "../src/project-release-lease.js";
import { executeProjectRelease, registerProjectReleaseTools } from "../src/mcp/project-release-tools.js";
import { runReleaseAdmin } from "../src/project-release-admin.js";
import { canonicalAuthority, withCanonicalGuard } from "../src/project-release-canonical.js";
import { emptyHarnessRuntimeSettings, setHarnessRuntimeSettingsPathForTests } from "../src/harness-runtime-settings.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
let runtimeSettingsDir: string;
beforeAll(async () => {
  runtimeSettingsDir = await mkdtemp(join(tmpdir(), "herder-canonical-settings-"));
  const settingsPath = join(runtimeSettingsDir, "harness-runtime-settings.json");
  await writeFile(settingsPath, JSON.stringify({ ...emptyHarnessRuntimeSettings(), releaseOccupancyEnabled: true }), { mode: 0o600 });
  setHarnessRuntimeSettingsPathForTests(settingsPath);
});
afterAll(async () => {
  setHarnessRuntimeSettingsPathForTests(undefined);
  await rm(runtimeSettingsDir, { recursive: true, force: true });
});
const owner = { hostId: "fixture", harness: "test", nativeSessionId: "session-a" };

async function fixture(disabledVersion?: 1 | 2) {
  const root = await mkdtemp(join(tmpdir(), "herder-canonical-facade-")); directories.push(root);
  const ledger = join(root, "ledger.json"), config = join(root, "config.json"), bridge = join(root, "bridge.py"), calls = join(root, "calls.jsonl");
  const primary = { fleetDir: await realpath(root), unit: "primary.service" };
  const secondary = { ...primary, unit: "secondary.service" };
  await writeFile(config, JSON.stringify({ calls, owner, primary, secondary, disabledVersion }), { mode: 0o600 });
  await writeFile(calls, "", { mode: 0o600 });
  await writeFile(bridge, `#!/usr/bin/env python3
import json,sys
config=json.load(open(sys.argv[2]))
guard=False
for line in sys.stdin:
 request=json.loads(line)
 with open(config['calls'],'a') as out: out.write(json.dumps({'request':request,'argv':sys.argv})+'\\n')
 action=request['action']
 target=request.get('deploymentTarget',config['primary'])
 lease={'project':request.get('project','project'),'owner':request.get('owner',config['owner']),'fence':119,'acquiredAt':1000,'expiresAt':301000,'deploymentTarget':target}
 if config.get('disabledVersion') and action=='check':
  response={'ok':False,'error':'release_occupancy_disabled'} if config['disabledVersion']==2 else {'ok':True,'result':{'bypassed':True}}
 elif request.get('token')=='b'*64 and target!=config['secondary']: response={'ok':False,'error':'proof_mismatch'}
 else:
  if action=='acquire': result={'acquired':True,'lease':lease,'token':request['token']}
  elif action=='status': result={'lease':lease,'remainingSeconds':300,'nextFence':120,'deploymentInProgress':False,'contact':None,'resourceRef':'secondary-slot' if target==config['secondary'] else 'build-slot','revision':1,'deploymentTarget':target}
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
  return { root, ledger, state, calls, history, primary, secondary, store: new ProjectReleaseLeaseStore(ledger) };
}

describe("sealed project release compatibility facade", () => {
  it.each([1, 2] as const)("consults the disabled v%s authority before allowing any bypass", async version => {
    const f = await fixture(version);
    const settings = join(f.root, "off.json");
    await writeFile(settings, JSON.stringify(emptyHarnessRuntimeSettings()));
    setHarnessRuntimeSettingsPathForTests(settings);
    try {
      const proof = { owner, token: "a".repeat(64), fence: 119, deploymentTarget: f.secondary };
      expect((await f.store.status("project", f.secondary)).resourceRef).toBe("secondary-slot");
      expect((await f.store.acquire("project", owner, 300, f.secondary)).acquired).toBe(false);
      for (const action of ["check", "renew", "release"] as const) {
        const result = f.store[action]("project", proof);
        if (version === 2) await expect(result).rejects.toThrow("release_occupancy_disabled");
        else await expect(result).resolves.toMatchObject({ bypassed: true });
      }
      let cleanupRan = false;
      const cleanup = f.store.withIntegrationCleanup("project", proof, "integration", "/fixture", async () => { cleanupRan = true; });
      if (version === 2) await expect(cleanup).rejects.toThrow("release_occupancy_disabled");
      else await cleanup;
      expect(cleanupRan).toBe(version === 1);
      const history = await f.history();
      expect(history.map(({ request }) => request.action)).toEqual(["status", "status", "check", "check", "check", "check"]);
      expect(history.at(-1).request.deploymentTarget).toBeUndefined();
    } finally { setHarnessRuntimeSettingsPathForTests(join(runtimeSettingsDir, "harness-runtime-settings.json")); }
  });

  it.each(["default", "secondary"])("roundtrips the %s selector through the admin proof and all MCP lease actions", async selection => {
    const f = await fixture();
    execFileSync("git", ["init", "-q", f.root]);
    const alias = join(f.root, "fleet-link");
    await symlink(f.secondary.fleetDir, alias);
    const explicit = selection === "secondary";
    const selector = explicit ? { deploymentTarget: { ...f.secondary, fleetDir: alias } } : {};
    const localOwner = { ...owner, hostId: hostname() };
    const options = { ledger: f.ledger, authorityHost: hostname() };
    const proofOut = join(f.root, "proof.json");
    const acquired = await runReleaseAdmin({ ...options, proofOut,
      request: { action: "acquire", cwd: f.root, owner: localOwner, ...selector } });
    expect(acquired).toMatchObject({ acquired: true, lease: { deploymentTarget: explicit ? f.secondary : f.primary } });
    const { project, ...proof } = JSON.parse(await readFile(proofOut, "utf8"));
    expect(project).toBe(await realpath(join(f.root, ".git")));
    expect(proof.owner).toEqual(localOwner);
    expect(Object.keys(proof).sort()).toEqual(explicit ? ["deploymentTarget", "fence", "owner", "token"] : ["fence", "owner", "token"]);
    if (explicit) expect(proof.deploymentTarget).toEqual(f.secondary);
    const server = new McpServer({ name: "release-authority", version: "1" });
    registerProjectReleaseTools(server, f.store);
    const client = new Client({ name: "release-consumer", version: "1" }, { versionNegotiation: { mode: "auto" } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const call = async (args: object) => {
        const result = await client.callTool({ name: "project_release_lease", arguments: { cwd: f.root, ...args } });
        expect(result.isError).not.toBe(true);
        const [content] = result.content;
        if (content?.type !== "text") throw new Error("missing release tool response");
        return JSON.parse(content.text);
      };
      expect(await call({ action: "status", ...selector })).toMatchObject({
        resourceRef: explicit ? "secondary-slot" : "build-slot", deploymentTarget: explicit ? f.secondary : f.primary,
      });
      for (const action of ["check", "renew", "release"]) await call({ action, ...proof });
    } finally {
      await client.close();
      await server.close();
    }
    const history = await f.history();
    expect(history.map(({ request }) => request.action)).toEqual(["acquire", "status", "check", "renew", "release"]);
    expect(history.map(({ request }) => request.deploymentTarget)).toEqual(Array(5).fill(explicit ? f.secondary : undefined));
  });

  it("requires a proof for the default resource for project-wide claim, finish and cleanup", async () => {
    const f = await fixture(), project = "project", cwd = "/fixture/worktree";
    await f.store.projectLifecycle(project, owner, cwd, "active", 1000);
    await f.store.projectLifecycle(project, owner, cwd, "ended", 1001);
    const { integration } = await f.store.prepareIntegration(project, owner, "fixture-inventory", { target: "main" });
    const id = integration!.id;
    const primary = { owner, token: "a".repeat(64), fence: 119 };
    const secondary = { ...primary, token: "b".repeat(64), deploymentTarget: f.secondary };
    await expect(f.store.check(project, secondary)).resolves.toMatchObject({ deploymentTarget: f.secondary });
    await expect(f.store.claimIntegration(project, secondary, id)).rejects.toThrow("proof_mismatch");
    await expect(f.store.claimIntegration(project, { ...primary, token: secondary.token }, id)).rejects.toThrow("proof_mismatch");
    await expect(f.store.claimIntegration(project, { ...primary, deploymentTarget: f.secondary }, id)).rejects.toThrow("target_mismatch");
    await f.store.claimIntegration(project, primary, id);
    await expect(f.store.finishIntegration(project, secondary, id, [])).rejects.toThrow("proof_mismatch");
    let cleanupRan = false;
    await expect(f.store.withIntegrationCleanup(project, secondary, id, cwd, async () => { cleanupRan = true; })).rejects.toThrow("proof_mismatch");
    expect(cleanupRan).toBe(false);
    await f.store.finishIntegration(project, primary, id, [], "verified");
    expect((await f.history()).slice(1).every(({ request }) => request.action === "check" && !("deploymentTarget" in request))).toBe(true);
  });

  it.skipIf(!process.env.HERDER_RESOURCE_BRIDGE_BIN)("roundtrips real Rust ownership and guarded integration cleanup", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "herder-real-ts-facade-"))); directories.push(root);
    const binary = join(root, "herder_resource_bridge");
    await copyFile(process.env.HERDER_RESOURCE_BRIDGE_BIN!, binary); await chmod(binary, 0o755);
    const authority = join(root, "authority"), resources = join(authority, "resources"), resource = join(resources, "release");
    const repo = join(root, "repo"), project = join(repo, ".git"), fleet = join(root, "fleet"), execution = join(root, "executions");
    for (const path of [authority, resources, resource, repo, fleet, execution]) {
      await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700);
    }
    execFileSync("git", ["init", "-q", repo]);
    const save = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await save(join(authority, "storage.json"), { schema: "v1", storage_id: "fixture-storage" });
    await save(join(resource, "resource.json"), { schema: "v1", storage_id: "fixture-storage", resource_ref: "release", scope: { type: "global" },
      descriptor: { resource_ref: "release", scope: { type: "global" }, kind: { type: "deployment" }, external_ref: "fixture-ts-target", authority_ref: "fixture-storage", attachment: null, revision: 1 } });
    const processConfig = join(root, "process.json"), config = join(root, "compat.json"), ledger = join(root, "ledger.json");
    const deploymentTarget = { fleetDir: fleet, unit: "fixture.service" };
    await save(processConfig, { version: 1, node_ref: hostname(), worker: binary, execution_root: execution,
      resources: { storage_id: "fixture-storage", authority_node: hostname(), root: authority, schema: "v1", route: { type: "local" } }, administrators: ["alice"] });
    await save(config, { version: 1, process_config: processConfig, ledger, seal_id: "ts-fixture-seal", principal_ref: "alice",
      runtime_settings_path: join(runtimeSettingsDir, "harness-runtime-settings.json"),
      mappings: [{ project, resource_ref: "release", revision: 1, previous_fence: 118, deployment_target: deploymentTarget }] });
    await save(ledger, { version: 2, canonical: { version: 1, config, bridge: binary, seal_id: "ts-fixture-seal" }, projects: { [project]: { fence: 118 } } });
    const store = new ProjectReleaseLeaseStore(ledger), before = await readFile(ledger, "utf8");
    const acquired = await executeProjectRelease({ action: "acquire", cwd: repo, ttlSeconds: 30 }, store,
      { harness: "codex", sessionId: "fixture-session" }) as ReleaseAcquisition & { project: string };
    expect(acquired.acquired).toBe(true); if (!acquired.acquired) throw new Error("fixture acquire failed");
    expect(acquired.lease.fence).toBe(119);
    expect(acquired.lease.deploymentTarget).toEqual(deploymentTarget);
    const owner = acquired.lease.owner;
    const proof = { owner, token: acquired.token, fence: acquired.lease.fence };
    const wrongTarget = { ...deploymentTarget, unit: "unmapped.service" };
    for (const action of ["status", "check", "renew", "release"]) {
      await expect(executeProjectRelease({ action, cwd: repo, ...proof, deploymentTarget: wrongTarget }, store))
        .rejects.toThrow("proof_mismatch");
    }
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
