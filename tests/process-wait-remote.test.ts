import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProcessWaitGate } from "../src/process-wait-gate.js";

const authority = "mcp:shell:roomhacker-server-100:AgentHerder";
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function status(changes: Record<string, unknown> = {}) {
  return {
    version: 1, configured: true, complete: true, blocked: false,
    reason: "process_wait_absent", mapped: false, sessionRefs: [], ruleRefs: [],
    observedAt: new Date().toISOString(), ...changes,
  };
}

async function oldLocalSelector() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "herder-wait-remote-"));
  roots.push(root);
  const manifest = path.join(root, "manifest.json");
  const data = JSON.stringify({ source_commit: "old-unconfigured-runtime" });
  await fs.writeFile(manifest, data, { mode: 0o600 });
  const selector = path.join(root, "selector.json");
  await fs.writeFile(selector, JSON.stringify({
    manifest, manifest_sha256: createHash("sha256").update(data).digest("hex"),
  }), { mode: 0o600 });
  return { root, selector };
}

describe("canonical remote process wait authority", () => {
  it("reads the exact native authority for every fence without a negative cache or node guessing", async () => {
    const call = vi.fn().mockResolvedValueOnce(status()).mockResolvedValueOnce(status({
      blocked: true, reason: "process_wait_armed", mapped: true, sessionRefs: ["canonical-session"], ruleRefs: ["rule"],
    })).mockResolvedValueOnce(status());
    const gate = createProcessWaitGate({ authority, env: {}, transportFactory: async () => ({ call }) });
    expect(await gate.blocks("codex", "native-session")).toBe(false);
    expect(await gate.blocks("codex", "native-session")).toBe(true);
    expect(await gate.blocks("codex", "native-session")).toBe(false);
    expect(call).toHaveBeenCalledTimes(3);
    expect(call).toHaveBeenLastCalledWith(authority, "automation", {
      action: "wait_status", harness: "codex", native_session_id: "native-session",
    });
    expect(call.mock.calls.every(args => args[0] === authority)).toBe(true);
  });

  it("passes only the explicit trusted node mapping and leaves registry aliases untouched", async () => {
    const call = vi.fn().mockResolvedValue(status());
    const gate = createProcessWaitGate({
      env: { AGENT_HERDER_PROCESS_WAIT_AUTHORITY: authority, AGENT_HERDER_PROCESS_WAIT_NODE_REF: "server-44" },
      transportFactory: async () => ({ call }),
    });
    expect(await gate.blocks("codex", "remote-session")).toBe(false);
    expect(call).toHaveBeenCalledWith(authority, "automation", {
      action: "wait_status", harness: "codex", native_session_id: "remote-session", node_ref: "server-44",
    });
  });

  it("never treats an unconfigured local selector as absence of a remote wait", async () => {
    const { selector } = await oldLocalSelector();
    const call = vi.fn().mockRejectedValue(new Error("authority unavailable"));
    const gate = createProcessWaitGate({ authority, selector, env: {}, transportFactory: async () => ({ call }) });
    expect(await gate.blocks("codex", "native-session")).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    const noCredential = createProcessWaitGate({ authority, selector, env: {} });
    expect(await noCredential.blocks("codex", "native-session")).toBe(true);
  });

  it("requires complete fresh typed evidence before permitting continuation", async () => {
    const cases = [
      { blocked: false, reason: "old-untyped-response" },
      status({ complete: false }),
      status({ observedAt: "2000-01-01T00:00:00Z" }),
      status({ observedAt: new Date(Date.now() + 60_000).toISOString() }),
      status({ mapped: false, sessionRefs: ["unexplained-match"] }),
      { isError: true, content: [{ type: "text", text: "harness_authority_not_configured" }] },
      { status: "failed", error: "canonical reader unavailable" },
    ];
    for (const response of cases) {
      const call = vi.fn().mockResolvedValue(response);
      const gate = createProcessWaitGate({ authority, env: {}, transportFactory: async () => ({ call }) });
      expect(await gate.blocks("codex", "native-session")).toBe(true);
    }
    const call = vi.fn().mockResolvedValue({ structuredContent: { result: status({
      configured: false, reason: "process_wait_unconfigured",
    }) } });
    expect(await createProcessWaitGate({ authority, env: {}, transportFactory: async () => ({ call }) })
      .blocks("codex", "native-session")).toBe(false);
  });

  it("fails closed for stalled reads, unsupported authorities and missing binding", async () => {
    vi.useFakeTimers();
    const gate = createProcessWaitGate({ authority, env: {}, transportFactory: async () => ({
      call: vi.fn(() => new Promise(() => {})),
    }) });
    const waiting = gate.blocks("codex", "native-session");
    await vi.advanceTimersByTimeAsync(6000);
    expect(await waiting).toBe(true);
    const factory = vi.fn().mockResolvedValue(undefined);
    expect(await createProcessWaitGate({ authority: "mcp:shell:roomhacker-server-100:HerderFleet",
      env: {}, transportFactory: factory }).blocks("codex", "native-session")).toBe(true);
    expect(factory).not.toHaveBeenCalled();
  });

  it("keeps implicit absent local activation compatible and explicit activation fail closed", async () => {
    vi.spyOn(os, "homedir").mockReturnValue("/nonexistent-fixture-process-wait-home");
    expect(await createProcessWaitGate({ env: {} }).blocks("codex", "native-session")).toBe(false);
    expect(await createProcessWaitGate({ env: {}, launcher: "/explicit/unavailable/launcher" })
      .blocks("codex", "native-session")).toBe(true);
  });

  it("reuses the approved pinned GPTAdmin transport without fleet discovery, remap or new credentials", async () => {
    const { root } = await oldLocalSelector();
    const config = path.join(root, "existing-mcp-config.json");
    const url = "https://fixture.gptadmin.bezrabotnyi.com/mcp";
    const headers = { Authorization: "Bearer isolated-test-credential" };
    const pin = createHash("sha256").update(JSON.stringify([url, headers])).digest("hex");
    await fs.writeFile(config, JSON.stringify({ mcp: { servers: { gptadmin: { url, headers } } } }), { mode: 0o600 });
    const operations: Array<Record<string, any>> = [];
    const fetcher = vi.fn(async (endpoint: string | URL | Request, init?: RequestInit) => {
      expect(String(endpoint)).toBe(url);
      const body = JSON.parse(String(init?.body));
      operations.push(body);
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(JSON.stringify({
        jsonrpc: "2.0", id: body.id,
        result: body.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: {} }
          : { structuredContent: { status: "completed", calls: 1, result: status() } },
      }), { headers: { "content-type": "application/json", "mcp-session-id": "isolated-read-session" } });
    });
    vi.stubGlobal("fetch", fetcher);
    const gate = createProcessWaitGate({
      env: { AGENT_HERDER_PROCESS_WAIT_AUTHORITY: authority, AGENT_HERDER_FLEET_MESH_CONFIG: config,
        AGENT_HERDER_FLEET_CREDENTIAL_PIN: pin },
    });
    expect(await gate.blocks("codex", "native-session")).toBe(false);
    expect(await gate.blocks("codex", "native-session")).toBe(false);
    expect(operations.map(item => item.method)).toEqual([
      "initialize", "notifications/initialized", "tools/call", "tools/call",
    ]);
    const exec = operations.filter(item => item.method === "tools/call");
    expect(exec.every(item => item.params.name === "exec")).toBe(true);
    expect(exec[0]!.params.arguments.code).toBe(
      'return await mcp.call("mcp:shell:roomhacker-server-100:AgentHerder","automation",{"action":"wait_status","harness":"codex","native_session_id":"native-session"});',
    );
    // A credential file change without the approved generation must block.
    await fs.writeFile(config, JSON.stringify({ mcp: { servers: { gptadmin: { url,
      headers: { Authorization: "Bearer rotated-unapproved-test-credential" } } } } }), { mode: 0o600 });
    expect(await gate.blocks("codex", "native-session")).toBe(true);
    expect(operations).toHaveLength(4);
  });
});
