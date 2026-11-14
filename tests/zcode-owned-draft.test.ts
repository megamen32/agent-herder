import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZcodeAdapter } from "../src/adapters/zcode.js";
import type { ZcodeClientLike } from "../src/adapters/zcode-protocol.js";
import { getHumanStopStore } from "../src/human-stop-store.js";

const SID = "new-owned-native-draft";
const CWD = "/fixture/registered-project";
const INPUT = { message: "synthetic initial input", queue: true, inputId: "new-create-initial-prime" };
const directories: string[] = [];
const adapters: ZcodeAdapter[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.dispose();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class DraftClient implements ZcodeClientLike {
  calls: Array<{ channel: string; method: string; args: unknown[]; existingOnly: boolean }> = [];
  handlers = new Set<(payload: unknown) => void>();
  disconnected?: () => void;
  beforeRead?: (count: number) => void;
  onSubscribe?: () => void;
  onResync?: () => void;
  readCount = 0;
  cold = false;
  active = false;
  loseSubscriptionAck = false;
  loseInputAck = false;
  snapshot: any = {
    session: { sessionId: SID, workspace: { workspacePath: CWD, workspaceIdentity: CWD },
      traceId: "native-created-trace", title: "", status: "idle", mode: "build", createdAt: 1, updatedAt: 1 },
    settings: { model: { current: { providerId: "native-provider", modelId: "native-model", options: { reasoningLevel: "enabled" } } },
      permission: { mode: "build", rulesRevision: 1 } },
    runtime: { eventSeq: 0, stateRevision: 2, pendingRequestIds: [], goalVerifications: [], goalVerificationTimeline: [] },
    messages: [],
  };
  queue: any = { sessionId: SID, revision: 1, logEpoch: "native-epoch", seq: 1,
    queue: { items: [], autoDrain: true },
    control: { phase: "draft", sessionEnded: false, activeWorks: [], apiRetry: null, stopState: "idle", canStop: false } };
  async start() {}
  async close() { this.active = false; this.handlers.clear(); }
  onDisconnect(handler: () => void) { this.disconnected = handler; return () => {}; }
  listen(_channel: string, event: string, _arg: unknown, handler: (payload: unknown) => void) {
    if (event === "onDynamicConversationFrame") this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit() {
    for (const handler of this.handlers) handler({ subscriptionId: "owned-subscription", topic: "conversation/" + SID,
      fromSeq: 0, toSeq: 1, payload: { kind: "snapshot", snapshot: structuredClone(this.queue) } });
  }
  async call(channel: string, method: string, args: unknown[]) { return this.perform(channel, method, args, false); }
  async callIfReady(channel: string, method: string, args: unknown[]) { return this.perform(channel, method, args, true); }
  private async perform(channel: string, method: string, args: unknown[], existingOnly: boolean): Promise<unknown> {
    this.calls.push({ channel, method, args, existingOnly });
    if (method === "initialize") return { available: true };
    if (channel === "project" && method === "readTree") return {
      projects: [{ id: "registered-project", hostId: "local", roots: [{ rootPath: CWD, isPrimary: true }] }],
    };
    if (method === "createSession") return this.snapshot;
    if (method === "renameTask") return {};
    if (method === "readSessionEvents") return { events: [] };
    if (method === "readSession") {
      this.beforeRead?.(++this.readCount);
      if (this.cold) throw new Error("Session runtime is not ready");
      return this.snapshot;
    }
    if (method === "subscribeConversationV4") {
      this.active = true; this.onSubscribe?.();
      if (this.loseSubscriptionAck) throw new Error("lost subscription acknowledgement");
      this.emit(); return { ack: { subscriptionId: "owned-subscription" } };
    }
    if (method === "resyncConversationV4") { this.onResync?.(); this.emit(); return {}; }
    if (method === "unsubscribeConversationV4") { this.active = false; return {}; }
    if (method === "sendConversationCommandV4") {
      expect(this.active).toBe(true);
      if (this.loseInputAck) throw new Error("lost native input acknowledgement");
      const envelope = (args[0] as any).envelope;
      return { commandId: envelope.commandId, status: "accepted",
        result: { type: "inputAccepted", inputId: "native-input-1", delivery: "queue" } };
    }
    throw new Error("Unexpected fixture method " + method);
  }
  writes() { return this.calls.filter(call => call.method === "sendConversationCommandV4"); }
  subscriptions() { return this.calls.filter(call => call.method === "subscribeConversationV4"); }
}

function setup(client = new DraftClient()) {
  const directory = mkdtempSync(join(tmpdir(), "zcode-owned-draft-")); directories.push(directory);
  // No native SQLite file: a real deferred draft is persisted by its first V4 input.
  const adapter = new ZcodeAdapter({ client, cwd: CWD, localDbPath: join(directory, "not-created.sqlite") });
  adapters.push(adapter);
  vi.spyOn(adapter, "nativeReadWithoutActivation", "get").mockReturnValue(true);
  vi.spyOn(getHumanStopStore(), "isHeld").mockResolvedValue(false);
  vi.spyOn(getHumanStopStore(), "rememberGeneratedPrompt").mockResolvedValue(undefined);
  return { adapter, client, create: () => adapter.createSession({ name: "synthetic QA", cwd: CWD, mode: "build", fullAccess: false }) };
}

describe("ZCode adapter-owned deferred draft first input", () => {
  it("admits exactly one real automation V4 command while holding the native residency subscription", async () => {
    const h = setup(); expect(await h.create()).toMatchObject({ id: SID });
    const result = await h.adapter.sendHerderQueuedMessage(SID, INPUT);
    expect(result).toMatchObject({ ok: true, admitted: true, inputId: INPUT.inputId });
    expect(h.client.calls.find(call => call.method === "createSession")?.args).toMatchObject([{ persistence: "deferred", projectId: "registered-project" }]);
    expect(h.client.writes()).toHaveLength(1);
    expect(h.client.writes()[0]).toMatchObject({ existingOnly: true, args: [{ envelope: {
      commandId: "agent-herder:auto:" + INPUT.inputId, clientId: "agent-herder", sessionId: SID,
      type: "sendText", payload: { text: INPUT.message, requestedDelivery: "queue" },
    } }] });
    expect(getHumanStopStore().rememberGeneratedPrompt).toHaveBeenCalledWith("zcode", SID, INPUT.message);
    expect(h.client.subscriptions()).toHaveLength(1);
    expect(h.client.active).toBe(false);
    expect(h.client.calls.some(call => /resume|ensureSessionReady|setAutoDrain|setModel/i.test(call.method))).toBe(false);
  });

  it("cannot obtain initial eligibility by reading a resident draft created by another adapter instance", async () => {
    const first = setup(); await first.create();
    const second = setup(first.client);
    expect(await second.adapter.getSession(SID)).toMatchObject({ id: SID });
    expect(await second.adapter.sendHerderQueuedMessage(SID, INPUT)).toMatchObject({ notSubmitted: true });
    expect(first.client.writes()).toHaveLength(0);
    expect(first.client.subscriptions()).toHaveLength(0);
  });

  it.each(["model", "permission", "trace"] as const)("keeps confirmed create without granting eligibility for incomplete %s proof", async field => {
    const h = setup();
    if (field === "model") delete h.client.snapshot.settings.model.current;
    if (field === "permission") h.client.snapshot.settings.permission = {};
    if (field === "trace") delete h.client.snapshot.session.traceId;
    expect(await h.create()).toMatchObject({ id: SID });
    expect(await h.adapter.sendHerderQueuedMessage(SID, INPUT)).toMatchObject({ notSubmitted: true });
    expect(h.client.subscriptions()).toHaveLength(0);
    expect(h.client.writes()).toHaveLength(0);
  });

  it.each([
    ["model", (c: DraftClient) => { c.snapshot.settings.model.current.options.reasoningLevel = "changed"; }],
    ["permission", (c: DraftClient) => { c.snapshot.settings.permission.rulesRevision++; }],
  ] as const)("retains an independent creation snapshot and refuses changed %s", async (_name, mutate) => {
    const h = setup(); await h.create(); mutate(h.client);
    expect(await h.adapter.sendHerderQueuedMessage(SID, INPUT)).toMatchObject({ notSubmitted: true });
    expect(h.client.subscriptions()).toHaveLength(0);
    expect(h.client.writes()).toHaveLength(0);
  });

  it.each([
    ["absent runtime", (c: DraftClient) => { c.cold = true; }],
    ["different SID", (c: DraftClient) => { c.snapshot.session.sessionId = "foreign"; }],
    ["different workspace", (c: DraftClient) => { c.snapshot.session.workspace.workspacePath = "/foreign"; }],
    ["different trace", (c: DraftClient) => { c.snapshot.session.traceId = "foreign"; }],
    ["running", (c: DraftClient) => { c.snapshot.session.status = "running"; }],
    ["stopped", (c: DraftClient) => { c.snapshot.session.status = "stopped"; }],
    ["unknown", (c: DraftClient) => { c.snapshot.session.status = "unknown"; }],
    ["active turn", (c: DraftClient) => { c.snapshot.runtime.activeTurnId = "turn"; }],
    ["pending request", (c: DraftClient) => { c.snapshot.runtime.pendingRequestIds = ["permission"]; }],
    ["prior message", (c: DraftClient) => { c.snapshot.messages = [{ role: "user" }]; }],
    ["prior event", (c: DraftClient) => { c.snapshot.runtime.eventSeq = 1; }],
    ["goal work", (c: DraftClient) => { c.snapshot.runtime.goalVerifications = [{}]; }],
  ] as const)("refuses %s before any subscription instead of restoring a cached draft", async (_name, mutate) => {
    const h = setup(); await h.create(); mutate(h.client);
    expect(await h.adapter.sendHerderQueuedMessage(SID, INPUT)).toMatchObject({ notSubmitted: true });
    expect(h.client.subscriptions()).toHaveLength(0);
    expect(h.client.writes()).toHaveLength(0);
  });

  it.each([
    ["queued input", (c: DraftClient) => { c.queue.queue.items = [{ queueItemId: "foreign-input" }]; }],
    ["active work", (c: DraftClient) => { c.queue.control.activeWorks = [{}]; }],
    ["API retry", (c: DraftClient) => { c.queue.control.apiRetry = {}; }],
    ["stop", (c: DraftClient) => { c.queue.control.stopState = "stopping"; }],
    ["canStop", (c: DraftClient) => { c.queue.control.canStop = true; }],
    ["ended", (c: DraftClient) => { c.queue.control.sessionEnded = true; }],
    ...["prewarming", "running", "completedSuccess", "completedInterrupted", "error", "idle"].map(phase =>
      [phase, (c: DraftClient) => { c.queue.control.phase = phase; }] as const),
  ] as const)("preserves post-subscription uncertainty and writes nothing for V4 %s", async (_name, mutate) => {
    const h = setup(); await h.create(); mutate(h.client);
    const result = await h.adapter.sendHerderQueuedMessage(SID, INPUT);
    expect(result).toMatchObject({ admissionUnknown: true, nonRetryable: true });
    expect(result.notSubmitted).not.toBe(true);
    expect(h.client.writes()).toHaveLength(0);
    expect(h.client.active).toBe(false);
  });

  it("rechecks the complete queue and settings after resync", async () => {
    const h = setup(); await h.create();
    h.client.onResync = () => { h.client.snapshot.settings.permission.mode = "yolo"; };
    expect(await h.adapter.sendHerderQueuedMessage(SID, INPUT)).toMatchObject({ admissionUnknown: true });
    expect(h.client.writes()).toHaveLength(0);
  });

  it("keeps HumanStop dominant before and after the native boundary", async () => {
    for (const afterBoundary of [false, true]) {
      const h = setup(); await h.create();
      vi.mocked(getHumanStopStore().isHeld).mockImplementation(async () => afterBoundary ? h.client.active : true);
      const result = await h.adapter.sendHerderQueuedMessage(SID, INPUT);
      expect(result).toMatchObject(afterBoundary ? { admissionUnknown: true } : { notSubmitted: true });
      expect(h.client.writes()).toHaveLength(0);
    }
  });

  it("consumes eligibility before await, refusing parallel and repeated initial attempts", async () => {
    const h = setup(); await h.create();
    const first = h.adapter.sendHerderQueuedMessage(SID, INPUT);
    const concurrent = await h.adapter.sendHerderQueuedMessage(SID, { ...INPUT, inputId: "concurrent-initial" });
    expect(concurrent).toMatchObject({ notSubmitted: true });
    expect(await first).toMatchObject({ ok: true });
    expect(await h.adapter.sendHerderQueuedMessage(SID, INPUT)).toMatchObject({ ok: true, admitted: true });
    // A different future operation must satisfy the ordinary persisted cold guard.
    expect(await h.adapter.sendHerderQueuedMessage(SID, { ...INPUT, inputId: "different-future-wake" })).toMatchObject({ notSubmitted: true });
    expect(h.client.writes()).toHaveLength(1);
    expect(h.client.subscriptions()).toHaveLength(1);
  });

  it.each(["subscription", "input"] as const)("retains UNKNOWN after lost %s ACK and never resubmits the initial input", async stage => {
    const h = setup(); await h.create();
    h.client.loseSubscriptionAck = stage === "subscription"; h.client.loseInputAck = stage === "input";
    const original = await h.adapter.sendHerderQueuedMessage(SID, INPUT);
    expect(original).toMatchObject({ admissionUnknown: true });
    expect(await h.adapter.sendHerderQueuedMessage(SID, INPUT)).toEqual(original);
    expect(h.client.writes()).toHaveLength(stage === "input" ? 1 : 0);
    expect(h.client.subscriptions()).toHaveLength(1);
    expect(h.client.handlers.size).toBe(0);
  });

  it("invalidates initial authority on disconnect and never reconnects the native writer", async () => {
    const h = setup(); await h.create();
    h.client.onResync = () => h.client.disconnected?.();
    expect(await h.adapter.sendHerderQueuedMessage(SID, INPUT)).toMatchObject({ admissionUnknown: true });
    expect(h.client.writes()).toHaveLength(0);
    expect(await h.adapter.sendHerderQueuedMessage(SID, INPUT)).toMatchObject({ admissionUnknown: true });
    expect(h.client.subscriptions()).toHaveLength(1);
  });

  it("does not regain unused creation authority after transport disconnect", async () => {
    const h = setup(); await h.create(); h.client.disconnected?.();
    expect(await h.adapter.sendHerderQueuedMessage(SID, INPUT)).toMatchObject({ notSubmitted: true });
    expect(h.client.subscriptions()).toHaveLength(0);
    expect(h.client.writes()).toHaveLength(0);
  });

  it("refuses a human origin on the automation-only owned draft path", async () => {
    const h = setup(); await h.create();
    expect(await h.adapter.sendHerderQueuedMessage(SID, { ...INPUT, origin: "human" })).toMatchObject({ notSubmitted: true });
    expect(h.client.subscriptions()).toHaveLength(0);
    expect(h.client.writes()).toHaveLength(0);
  });
});
