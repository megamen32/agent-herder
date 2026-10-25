import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { SendMessageSchema, toolDefinitions } from "../src/mcp-tools/definitions.js";
import { handleSendMessage } from "../src/mcp-tools/handlers.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { UserMessageDelivery } from "../src/user-message-delivery.js";
import { TRUSTED_MESH_MCP_CLIENT_ID, TRUSTED_MESH_MCP_SCOPE, trustedMeshIngressFromMcpAuthInfo } from "../src/mesh/authenticated-ingress.js";

let root: string | undefined;
let previousStop: string | undefined;
const deliveries: UserMessageDelivery[] = [];
afterEach(async () => {
  deliveries.splice(0).forEach((delivery) => delivery.close());
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  if (previousStop === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousStop;
  previousStop = undefined;
});

async function fixture(running = true) {
  root = await mkdtemp(join(tmpdir(), "herder-send-default-"));
  previousStop = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
  process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(root, "human-stops.json");
  const id = randomUUID();
  const session = { id, harness: "codex", cwd: "/fixture/project", hostId: "fixture", title: "fixture",
    status: running ? "running" : "idle", needsPermission: false, lastActivity: new Date().toISOString() };
  const sendActiveMessage = vi.fn(async (_id: string, options: any) => ({
    ok: true, admitted: true, inputId: options.inputId, turnId: "fixture-current-turn",
  }));
  const sendMessage = vi.fn(async (_id: string, options: any) => ({
    ok: true, admitted: true, inputId: options.inputId, turnId: "fixture-new-turn",
  }));
  const adapter = { type: "codex", getSession: vi.fn(async () => session), sendActiveMessage, sendMessage };
  const adapters = new Map([["codex", adapter]]) as any;
  const events = new HerderEventBus();
  const jobs = new HerderJobRegistry(events, { persistencePath: join(root, "jobs.json") });
  const delivery = new UserMessageDelivery(adapters, { sendMessage: async (_harness, sid, options) => sendMessage(sid, options) }, jobs,
    { pollMs: 1, maxWaitMs: 2_000, maxPending: 4 });
  deliveries.push(delivery);
  const ingress = trustedMeshIngressFromMcpAuthInfo({ token: "test", clientId: TRUSTED_MESH_MCP_CLIENT_ID, scopes: [TRUSTED_MESH_MCP_SCOPE] })!;
  return { id, adapters, sendActiveMessage, sendMessage, jobs, delivery, ingress };
}

async function waitForOneJob(jobs: HerderJobRegistry) {
  let job = jobs.list()[0];
  expect(job).toBeDefined();
  await vi.waitFor(() => expect(jobs.get(job!.id)?.state).toBe("completed"));
  job = jobs.get(job!.id)!;
  return job;
}

it("omitted ordinary mode is steer and reaches the current active turn once", async () => {
  const f = await fixture();
  const args = { sessionId: f.id, harness: "codex", inputId: randomUUID(), message: "fixture delta" };
  expect(SendMessageSchema.parse(args).mode).toBe("steer");
  await handleSendMessage(f.adapters, args, f.delivery, f.ingress);
  await waitForOneJob(f.jobs);
  expect(f.sendActiveMessage).toHaveBeenCalledTimes(1);
  expect(f.sendActiveMessage.mock.calls[0][1]).toMatchObject({ steer: true, queue: false, activeTurnOnly: true });
  expect(f.sendMessage).not.toHaveBeenCalled();
});

it("publishes the same steer default in the legacy tool schema", () => {
  const tool = toolDefinitions.find((item) => item.name === "send_message")!;
  expect((tool.inputSchema.properties as any).mode.default).toBe("steer");
});

it("retains explicit queue and sync selections; queue uses the shared native queue admission", async () => {
  const f = await fixture();
  const args = { sessionId: f.id, harness: "codex", inputId: randomUUID(), message: "fixture deferred delta", mode: "queue" };
  expect(SendMessageSchema.parse(args).mode).toBe("queue");
  expect(SendMessageSchema.parse({ ...args, mode: "sync" }).mode).toBe("sync");
  await handleSendMessage(f.adapters, args, f.delivery, f.ingress);
  await waitForOneJob(f.jobs);
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
  expect(f.sendMessage.mock.calls[0][1]).toMatchObject({ queue: true, steer: false });
  expect(f.sendMessage.mock.calls[0][1]).not.toHaveProperty("activeTurnOnly");
  expect(f.sendActiveMessage).not.toHaveBeenCalled();
});

it("does not wake an inactive target by default and gives an explicit queue next action", async () => {
  const f = await fixture(false);
  const result = await handleSendMessage(f.adapters, {
    sessionId: f.id, harness: "codex", inputId: randomUUID(), message: "fixture inactive delta",
  }, f.delivery, f.ingress);
  expect(JSON.parse(result)).toMatchObject({
    delivery: "not_attempted", reason: "inactive_requires_queue", activated: false,
    nextAction: { mode: "queue" },
  });
  expect(f.jobs.list()).toHaveLength(0);
  expect(f.sendMessage).not.toHaveBeenCalled();
  expect(f.sendActiveMessage).not.toHaveBeenCalled();
});
