import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCanonicalAutomationClient, type CanonicalAutomationClient } from "../src/canonical-herder.js";
import { createCanonicalRuntimeStatus, CanonicalRuntimeStatusError, parseCanonicalRuntimeStatusRequest,
  type RuntimeProcessIdentity } from "../src/canonical-runtime-status.js";
import { createProcessWaitGate } from "../src/process-wait-gate.js";
import { CanonicalResumeAfterService } from "../src/resume-after-canonical.js";
import type { ResumeAfterBackend } from "../src/resume-after.js";
import { createWebServer } from "../src/web/server.js";
import { canonicalFixture, sha256 } from "./helpers/canonical-herder-fixture.js";

const challenge = "a1".repeat(32);
const probe = { harness: "codex", nativeSessionId: "fixture-native", nodeRef: "server-100" };
const files = ["index.js", "canonical-runtime-status.js", "canonical-herder.js", "canonical-migration.js",
  "resume-after-runtime.js", "resume-after-canonical.js", "process-wait-gate.js"];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function fixture() {
  const canonical = await canonicalFixture();
  const root = path.join(canonical.root, "runtime");
  cleanup.push(async () => {
    await fs.chmod(root, 0o700).catch(() => undefined);
    await canonical.cleanup();
  });
  canonical.config.node_ref = "server-100";
  await canonical.writeConfig();
  await fs.mkdir(root, { mode: 0o700 });
  const inventory: Record<string, string> = {};
  for (const file of files) {
    const bytes = `// isolated readonly runtime fixture ${file}\n`;
    await fs.writeFile(path.join(root, file), bytes, { mode: 0o400 });
    inventory[file] = sha256(bytes);
  }
  await fs.chmod(root, 0o500);
  const node = path.join(canonical.root, "node-proof-fixture");
  // Never executed. The injectable process identity owns this fixture inode.
  await fs.writeFile(node, "isolated node image proof\n", { mode: 0o500 });
  const nodeStat = await fs.stat(node);
  const manifest = { version: 1, kind: "herder-canonical-ts-runtime", capability: "canonical-scheduler-wait-gate-v1",
    source_commit: "b".repeat(40), root, entry: "index.js", files: inventory,
    node_binary: node, node_sha256: sha256(await fs.readFile(node)) };
  const manifestPath = path.join(canonical.root, "runtime-manifest.json");
  const env = canonical.env;
  env.AGENT_HERDER_TS_RUNTIME_MANIFEST = manifestPath;
  const writeManifest = async () => {
    const bytes = JSON.stringify(manifest) + "\n";
    await fs.chmod(manifestPath, 0o600).catch(() => undefined);
    await fs.writeFile(manifestPath, bytes, { mode: 0o600 });
    await fs.chmod(manifestPath, 0o400);
    env.AGENT_HERDER_TS_RUNTIME_MANIFEST_SHA256 = sha256(bytes);
  };
  await writeManifest();
  const identity: RuntimeProcessIdentity = { pid: 4242, boot_id: "8a381653-1ca3-4f2d-a9a1-547182b1af38", start_ticks: "9001",
    entry: path.join(root, "index.js"), node_binary: node, node_device: nodeStat.dev, node_inode: nodeStat.ino,
    module_path: path.join(root, "canonical-runtime-status.js") };
  const now = Date.now();
  let response: Record<string, unknown> = { version: 1, configured: true, complete: true, mapped: true,
    blocked: false, reason: "no_armed_wait", sessionRefs: ["session:fixture"], ruleRefs: [], observedAt: new Date(now).toISOString() };
  let beforeReply: (() => Promise<void>) | undefined;
  const call = vi.fn(async (_authority: string, tool: string, args: Record<string, unknown>) => {
    if (tool !== "automation" || args.action !== "wait_status") throw new Error("unexpected_native_mutation");
    await beforeReply?.();
    return response;
  });
  const transportFactory = async () => ({ call });
  const client = (await createCanonicalAutomationClient({ env, transportFactory }))!;
  const service = new CanonicalResumeAfterService(client);
  const fallback = vi.fn(async () => ({ blocked: false, reason: "must_not_use_legacy" }));
  const gate = createProcessWaitGate({ env, transportFactory, now: () => now, query: fallback });
  const status = (options: Parameters<typeof createCanonicalRuntimeStatus>[1] = {}) => createCanonicalRuntimeStatus(service, {
    env, now: () => now, processIdentity: async () => ({ ...identity }), observeGate: target => gate.observeCanonical!(target), ...options,
  });
  return { canonical, root, node, manifest, manifestPath, identity, env, now, client, service, gate, call, fallback,
    writeManifest, status,
    reply(value: Partial<Record<string, unknown>>) { response = { ...response, ...value }; },
    beforeReply(action: () => Promise<void>) { beforeReply = action; },
  };
}

describe("runtime status request boundary", () => {
  it("requires the exact challenge and preserves native identities", () => {
    expect(parseCanonicalRuntimeStatusRequest(new URLSearchParams({ challenge }))).toEqual({ challenge });
    expect(parseCanonicalRuntimeStatusRequest(new URLSearchParams({ challenge, harness: "codex",
      nativeSessionId: "native:exact/identity", nodeRef: "server-100" }))).toEqual({ challenge,
      probe: { harness: "codex", nativeSessionId: "native:exact/identity", nodeRef: "server-100" } });
  });
  it.each([
    "", "challenge=ABC", `challenge=${challenge}&challenge=${challenge}`,
    `challenge=${challenge}&config=/tmp/override`, `challenge=${challenge}&harness=codex`,
    `challenge=${challenge}&nativeSessionId=native`, `challenge=${challenge}&nodeRef=server-44`,
    `challenge=${challenge}&harness=codex&nativeSessionId=%20native`,
    `challenge=${challenge}&harness=codex&nativeSessionId=native%00`,
    `challenge=${challenge}&harness=../../other&nativeSessionId=native`,
  ])("rejects malformed or ambiguous request %s", query => {
    expect(() => parseCanonicalRuntimeStatusRequest(new URLSearchParams(query))).toThrow(CanonicalRuntimeStatusError);
    try { parseCanonicalRuntimeStatusRequest(new URLSearchParams(query)); } catch (error) {
      expect((error as CanonicalRuntimeStatusError).status).toBe(400);
    }
  });
});

describe("actual canonical runtime proof", () => {
  it("binds the loaded service, immutable tree, process, Node and the same read-only wait gate", async () => {
    const f = await fixture();
    const result = await f.status().observe({ challenge, probe });
    expect(result).toMatchObject({ version: 1, kind: "herder-canonical-runtime-status", challenge, migration_ready: true,
      process: { pid: f.identity.pid, boot_id: f.identity.boot_id, start_ticks: f.identity.start_ticks },
      runtime: { manifest: f.manifestPath, source_commit: f.manifest.source_commit, legacy_fallback: false,
        resume_after_authority: "canonical", capability: "canonical-scheduler-wait-gate-v1" },
      canonical: { config: f.canonical.configPath, config_sha256: f.env.AGENT_HERDER_CANONICAL_CONFIG_SHA256,
        epoch: f.canonical.config.epoch, authority: f.canonical.config.authority,
        writer_drain_sha256: f.canonical.config.writer_drain.sha256 },
      probe: { request: { harness: "codex", native_session_id: "fixture-native", node_ref: "server-100" }, gateBlocked: false } });
    expect(f.call.mock.calls).toEqual([[f.canonical.config.authority, "automation", {
      action: "wait_status", harness: "codex", native_session_id: "fixture-native", node_ref: "server-100" }]]);
    expect(f.fallback).not.toHaveBeenCalled();
    expect(await f.gate.blocks("codex", "fixture-native")).toBe(false);
    expect(f.call).toHaveBeenCalledTimes(2);
    expect(f.call.mock.calls.every(([, tool, args]) => tool === "automation" && args.action === "wait_status")).toBe(true);
  });

  it("reports backend identity without inventing a native observation when no probe was requested", async () => {
    const f = await fixture();
    expect(await f.status().observe({ challenge })).toMatchObject({ probe: null, migration_ready: true });
    expect(f.call).not.toHaveBeenCalled();
  });

  it.each([
    { blocked: true, complete: true, configured: true, reason: "armed_wait", ruleRefs: ["wait-rule:pending"] },
    { blocked: false, complete: false, configured: true, reason: "partial_inventory" },
    { blocked: false, complete: true, configured: false, reason: "authority_unconfigured" },
  ])("keeps the installed gate blocked for %s", async response => {
    const f = await fixture(); f.reply(response);
    expect(await f.status().observe({ challenge, probe })).toMatchObject({ probe: { gateBlocked: true, decision: response } });
    expect(await f.gate.blocks("codex", "fixture-native")).toBe(true);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("rejects unavailable and stale native observations without leaking transport credentials", async () => {
    const f = await fixture();
    const secret = "fixture-secret-do-not-serialize";
    f.call.mockRejectedValueOnce(new Error(`Authorization: Bearer ${secret}`));
    const error = await f.status().observe({ challenge, probe }).catch(error => error);
    expect(error).toMatchObject({ code: "canonical_runtime_unavailable", status: 503 });
    expect(String(error)).not.toContain(secret);
    f.reply({ observedAt: new Date(f.now - 6000).toISOString() });
    await expect(f.status().observe({ challenge, probe })).rejects.toMatchObject({ code: "canonical_runtime_unavailable" });
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("refuses a probe that selects a different node before any native read", async () => {
    const f = await fixture();
    await expect(f.status().observe({ challenge, probe: { ...probe, nodeRef: "server-44" } }))
      .rejects.toMatchObject({ code: "canonical_runtime_unavailable" });
    expect(f.call).not.toHaveBeenCalled();
  });

  it("rejects a lookalike client that was not captured by the actual client factory", async () => {
    const f = await fixture();
    const forged = { ...f.client } as CanonicalAutomationClient;
    const service = new CanonicalResumeAfterService(forged);
    await expect(createCanonicalRuntimeStatus(service, { env: f.env, processIdentity: async () => f.identity })
      .observe({ challenge })).rejects.toMatchObject({ code: "canonical_runtime_unavailable" });
    expect(f.call).not.toHaveBeenCalled();
  });

  it("rejects legacy service and unconfigured runtime without creating another backend", async () => {
    const f = await fixture();
    const legacy = { authority: "legacy" } as ResumeAfterBackend;
    await expect(createCanonicalRuntimeStatus(legacy, { env: f.env }).observe({ challenge }))
      .rejects.toMatchObject({ code: "canonical_backend_not_active" });
    delete f.env.AGENT_HERDER_TS_RUNTIME_MANIFEST_SHA256;
    await expect(f.status().observe({ challenge })).rejects.toMatchObject({ code: "runtime_manifest_unconfigured" });
    expect(f.call).not.toHaveBeenCalled();
  });

  it("requires retained writer-drain evidence from the actual service", async () => {
    const f = await fixture();
    await fs.unlink(f.canonical.drainPath);
    await expect(f.status().observe({ challenge, probe })).rejects.toMatchObject({ code: "canonical_runtime_unavailable" });
    expect(f.call).not.toHaveBeenCalled();
  });
});

describe("runtime proof drift and immutable artifact failures", () => {
  it("rejects missing capability module, unlisted file, writable module and digest drift", async () => {
    const f = await fixture();
    delete f.manifest.files["resume-after-canonical.js"];
    await f.writeManifest();
    await expect(f.status().observe({ challenge })).rejects.toMatchObject({ code: "runtime_manifest_invalid" });
    f.manifest.files["resume-after-canonical.js"] = sha256(await fs.readFile(path.join(f.root, "resume-after-canonical.js")));
    await f.writeManifest();
    await fs.chmod(f.root, 0o700);
    const extra = path.join(f.root, "unreviewed.js");
    await fs.writeFile(extra, "unreviewed\n", { mode: 0o400 }); await fs.chmod(f.root, 0o500);
    await expect(f.status().observe({ challenge })).rejects.toMatchObject({ code: "runtime_tree_inventory_mismatch" });
    await fs.chmod(f.root, 0o700); await fs.unlink(extra); await fs.chmod(f.root, 0o500);
    const module = path.join(f.root, "process-wait-gate.js");
    await fs.chmod(module, 0o600);
    await expect(f.status().observe({ challenge })).rejects.toMatchObject({ code: "runtime_file_untrusted" });
    await fs.writeFile(module, "changed source\n"); await fs.chmod(module, 0o400);
    await expect(f.status().observe({ challenge })).rejects.toMatchObject({ code: "runtime_tree_digest_mismatch" });
    expect(f.call).not.toHaveBeenCalled();
  });

  it("rejects a symlink module and an executable inode mismatch", async () => {
    const f = await fixture();
    const module = path.join(f.root, "process-wait-gate.js");
    const original = await fs.readFile(module);
    await fs.chmod(f.root, 0o700); await fs.unlink(module); await fs.symlink(f.node, module); await fs.chmod(f.root, 0o500);
    await expect(f.status().observe({ challenge })).rejects.toMatchObject({ code: "runtime_tree_inventory_mismatch" });
    await fs.chmod(f.root, 0o700); await fs.unlink(module); await fs.writeFile(module, original, { mode: 0o400 }); await fs.chmod(f.root, 0o500);
    await expect(f.status({ processIdentity: async () => ({ ...f.identity, node_inode: f.identity.node_inode + 1 }) })
      .observe({ challenge })).rejects.toMatchObject({ code: "runtime_node_binding_mismatch" });
  });

  it.each(["entry", "module_path", "node_binary"] as const)("refuses process %s outside its pinned runtime", async field => {
    const f = await fixture();
    await expect(f.status({ processIdentity: async () => ({ ...f.identity, [field]: "/tmp/unrelated" }) })
      .observe({ challenge })).rejects.toMatchObject({ code: "runtime_process_binding_mismatch" });
  });

  it("rejects canonical config generation changed during the native read", async () => {
    const f = await fixture();
    f.beforeReply(async () => { f.canonical.config.epoch = "rotated-during-read"; await f.canonical.writeConfig(); });
    await expect(f.status().observe({ challenge, probe })).rejects.toMatchObject({ code: "canonical_runtime_unavailable" });
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("keeps ordinary blocks() closed if native read races a canonical pin change", async () => {
    const f = await fixture();
    f.beforeReply(async () => { f.env.AGENT_HERDER_CANONICAL_CONFIG_SHA256 = "9".repeat(64); });
    expect(await f.gate.blocks("codex", "fixture-native")).toBe(true);
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("rechecks the actual backend after a gate read, including an independently observed gate", async () => {
    const f = await fixture();
    const observation = await f.gate.observeCanonical!(probe);
    await expect(f.status({ observeGate: async () => {
      f.env.AGENT_HERDER_CANONICAL_CONFIG_SHA256 = "8".repeat(64);
      return observation;
    } }).observe({ challenge, probe })).rejects.toMatchObject({ code: "canonical_runtime_unavailable" });
  });

  it("rejects mismatched gate authority without falling back to a second writer", async () => {
    const f = await fixture();
    const observation = await f.gate.observeCanonical!(probe);
    await expect(f.status({ observeGate: async () => ({ ...observation, authority: "mcp:shell:server-44:AgentHerder" }) })
      .observe({ challenge, probe })).rejects.toMatchObject({ code: "canonical_gate_binding_mismatch" });
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it("rejects process birth changed across observation and identical manifest bytes replaced in flight", async () => {
    const f = await fixture();
    let reads = 0;
    await expect(f.status({ processIdentity: async () => ({ ...f.identity, start_ticks: ++reads === 1 ? "9001" : "9002" }) })
      .observe({ challenge })).rejects.toMatchObject({ code: "runtime_process_changed" });
    f.beforeReply(async () => {
      const replacement = f.manifestPath + ".replacement";
      await fs.writeFile(replacement, await fs.readFile(f.manifestPath), { mode: 0o400 });
      await fs.rename(replacement, f.manifestPath);
    });
    await expect(f.status().observe({ challenge, probe })).rejects.toMatchObject({ code: "runtime_process_changed" });
  });
});

async function httpServer(observe?: (request: { challenge: string }) => Promise<Record<string, unknown>>) {
  const server = createWebServer({ adapters: new Map(), converter: {} as never, mcpAuthToken: "fixture-runtime-token",
    sessionObservationManagedExternally: true, ...(observe ? { canonicalRuntimeStatus: { observe } } : {}) });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/api/canonical-runtime-status`;
}

describe("authenticated runtime proof HTTP route", () => {
  it("does not observe runtime before the existing owner bearer boundary", async () => {
    const observe = vi.fn(async (request: { challenge: string }) => ({ challenge: request.challenge, migration_ready: true }));
    const url = await httpServer(observe);
    const unauthenticated = await fetch(`${url}?challenge=${challenge}&token=fixture-runtime-token`);
    expect(unauthenticated.status).toBe(401);
    expect(observe).not.toHaveBeenCalled();
    const response = await fetch(`${url}?challenge=${challenge}`, { headers: { authorization: "Bearer fixture-runtime-token" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ challenge, migration_ready: true });
    expect(body).not.toContain("fixture-runtime-token");
    expect(observe).toHaveBeenCalledExactlyOnceWith({ challenge });
  });

  it("rejects write methods and malformed query before calling the observer", async () => {
    const observe = vi.fn(async () => ({ migration_ready: true }));
    const url = await httpServer(observe);
    const headers = { authorization: "Bearer fixture-runtime-token" };
    expect((await fetch(`${url}?challenge=${challenge}`, { method: "POST", headers, body: "{}" })).status).toBe(405);
    expect((await fetch(`${url}?challenge=${challenge}&config=/tmp/override`, { headers })).status).toBe(400);
    expect(observe).not.toHaveBeenCalled();
  });

  it("returns a bounded unavailable error for missing backend and raw transport failure", async () => {
    const headers = { authorization: "Bearer fixture-runtime-token" };
    const missing = await httpServer();
    expect((await fetch(`${missing}?challenge=${challenge}`, { headers })).status).toBe(503);
    const failed = await httpServer(async () => { throw new Error("Authorization: Bearer fixture-secret-unavailable"); });
    const response = await fetch(`${failed}?challenge=${challenge}`, { headers });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "canonical_runtime_unavailable" });
  });
});
