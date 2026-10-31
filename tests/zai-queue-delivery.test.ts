import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, HarnessAdapter, SendMessageOptions } from "../src/types/index.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { UserMessageDelivery } from "../src/user-message-delivery.js";
import {
  TRUSTED_MESH_MCP_CLIENT_ID, TRUSTED_MESH_MCP_SCOPE,
  trustedMeshIngressFromMcpAuthInfo,
} from "../src/mesh/authenticated-ingress.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "herder-zai-queue-"));
  const previousStopStore = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(folder, "human-stops.json");
  let generating = true;
  const sent: string[] = [];
  const id = "zai::sidebar%3AQueue%20fixture";
  const getSession = vi.fn(async (): Promise<AgentSession> => ({
    id, harness: "browser-chat", hostId: "roomhacker-server-100",
    cwd: "/home/roomhacker/.browser-chat/zai", title: "Queue fixture",
    status: generating ? "running" : "idle", lastActivity: new Date().toISOString(),
    needsPermission: false,
  }));
  const send = vi.fn(async (_id: string, options: SendMessageOptions) => {
    if (generating) return { ok: false, error: "prompt is already running" };
    sent.push(options.message);
    generating = true;
    return { ok: true, admitted: true, inputId: options.inputId };
  });
  const adapter = {
    type: "browser-chat", name: "Browser chats", getSession,
    sendMessage: send,
    controlCapabilities: { steer: false },
  } as unknown as HarnessAdapter;
  const jobs = new HerderJobRegistry(new HerderEventBus(), { persistencePath: join(folder, "jobs.json") });
  const route = {
    adapter,
    supervisor: { sendMessage: async (_h: string, sid: string, options: SendMessageOptions) => send(sid, options) },
  };
  const delivery = new UserMessageDelivery(new Map([["browser-chat", adapter]]),
    route.supervisor, jobs, { pollMs: 5, maxWaitMs: 3_000, maxPending: 8 });
  cleanup.push(async () => {
    delivery.close();
    if (previousStopStore === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousStopStore;
    await rm(folder, { recursive: true, force: true });
  });
  return { id, jobs, delivery, route, sent, send, getSession, setGenerating: (value: boolean) => { generating = value; } };
}

describe("ZAI browser-chat durable queue admission", () => {
  it("holds FIFO human requests while generating, then sends each only once on idle", async () => {
    const f = await fixture();
    const first = { harness: "browser-chat", sessionId: f.id, inputId: "zai-fixture-1", message: "First fixture", mode: "queue" as const };
    const second = { ...first, inputId: "zai-fixture-2", message: "Second fixture" };
    const a = f.delivery.submit(first, f.route);
    f.delivery.submit(second, f.route);
    await vi.waitFor(() => expect(f.getSession.mock.calls.length).toBeGreaterThan(1));
    expect(f.send).not.toHaveBeenCalled();

    f.setGenerating(false);
    await vi.waitFor(() => expect(f.sent).toEqual(["First fixture"]));
    await vi.waitFor(() => expect(f.getSession.mock.calls.length).toBeGreaterThan(3));
    expect(f.sent).toEqual(["First fixture"]); // First submission started generation again.

    f.setGenerating(false);
    await vi.waitFor(() => expect(f.sent).toEqual(["First fixture", "Second fixture"]));
    // A repeated request with the same delivery input ID reads the existing receipt.
    const duplicate = f.delivery.submit(first, f.route);
    expect(duplicate.job?.id).toBe(a.job?.id);
    expect(f.sent).toHaveLength(2);
  });

  it("also defers authenticated agent queue, never substituting native steer", async () => {
    const f = await fixture();
    const ingress = trustedMeshIngressFromMcpAuthInfo({
      token: "fixture-ingress-token", clientId: TRUSTED_MESH_MCP_CLIENT_ID, scopes: [TRUSTED_MESH_MCP_SCOPE],
    })!;
    const receipt = await f.delivery.submitAgent({
      harness: "browser-chat", sessionId: f.id, inputId: "zai-agent-queue",
      message: "Agent fixture", mode: "queue",
    }, { hostId: "source-host", harness: "opencode", nativeSessionId: "fixture-source" }, ingress, f.route);
    expect(receipt.notSubmitted).not.toBe(true);
    await vi.waitFor(() => expect(f.getSession.mock.calls.length).toBeGreaterThan(1));
    expect(f.send).not.toHaveBeenCalled();
    f.setGenerating(false);
    await vi.waitFor(() => expect(f.sent).toEqual(["Agent fixture"]));
    expect(f.send.mock.calls[0]?.[1]?.steer).toBe(false);
  });
});

describe("Browser chat native admission receipts", () => {
  it("returns retryable busy only before a click, and marks uncertain clicks non-retryable", async () => {
    const { BrowserChatAdapter } = await import("../src/adapters/browser-chat.js");
    const driver = {
      listChats: async () => [],
      async sendMessage() { throw new Error("prompt is already running; ZAI queue must wait"); },
    };
    const adapter = new BrowserChatAdapter(driver, {
      id: "zai", name: "ZAI", harness: "browser-chat", cwd: "/browser/zai",
    });
    expect(await adapter.sendMessage("zai::fixture", { message: "fixture" })).toMatchObject({
      ok: false, error: expect.stringContaining("already running"),
    });
    driver.sendMessage = async () => { throw new Error("ZAI submission outcome unknown: do not retry automatically"); };
    expect(await adapter.sendMessage("zai::fixture", { message: "fixture" })).toMatchObject({
      ok: false, admissionUnknown: true, nonRetryable: true,
    });
    driver.sendMessage = async () => { throw new Error("ZAI composer is unavailable or has an existing draft"); };
    expect(await adapter.sendMessage("zai::fixture", { message: "fixture" })).toMatchObject({
      ok: false, notSubmitted: true, nonRetryable: true,
    });
  });
});
