import { describe, expect, it } from "vitest";
import { ZcodeAdapter } from "../src/adapters/zcode.js";
import type { ZcodeClientLike } from "../src/adapters/zcode-protocol.js";

// Native contract: installed zcode-server.cjs f7a537a6, commandEnvelopeSchema,
// sendConversationCommandV4, commandAckSchema/inputAccepted. No live tenant.
class NativeCommands implements ZcodeClientLike {
  calls: Array<{ method: string; params: any }> = [];
  commands = new Map<string, any>();
  events: unknown[] = [];
  messages: unknown[] = [];
  reply?: (params: any) => unknown;
  async start() {}
  async close() {}
  async call(_channel: string, method: string, args: unknown[]) {
    const params = args[0] as any;
    this.calls.push({ method, params });
    if (method === "readSession") return { session: { sessionId: "owned", status: "running" }, runtime: { activeTurnId: "active", pendingRequestIds: [] } };
    if (method === "readSessionEvents") return { events: this.events };
    if (method === "readSessionMessages") return this.messages;
    if (method === "sendConversationCommandV4") {
      if (this.reply) return this.reply(params);
      const envelope = params.envelope;
      const previous = this.commands.get(envelope.commandId);
      const ack = previous ? { ...previous, status: "duplicate" } : {
        commandId: envelope.commandId, status: "accepted", revisionAtDecision: 5,
        result: { type: "inputAccepted", inputId: `native-${envelope.commandId}`, delivery: envelope.payload.requestedDelivery },
      };
      this.commands.set(envelope.commandId, ack);
      return ack;
    }
    throw new Error(`Forbidden legacy/completion call: ${method}`);
  }
}
const adapter = (client: NativeCommands) => new ZcodeAdapter({ client, cwd: "/workspace", localDbPath: "/nonexistent/isolated-zcode-db" });
const message = { message: "repair owned mount", inputId: "operation-1", origin: "human" as const };

describe("ZCode registered communication native command admission", () => {
  it("guides the active native turn without legacy send, stop or completion wait", async () => {
    const client = new NativeCommands();
    expect(await adapter(client).sendMessage("owned", { ...message, steer: true })).toMatchObject({ ok: true, admitted: true, inputId: "operation-1" });
    expect(client.calls.find(c => c.method === "sendConversationCommandV4")?.params).toMatchObject({
      workspacePath: "/workspace", envelope: { commandId: "operation-1", clientId: "agent-herder", sessionId: "owned", type: "sendText", payload: { text: message.message, requestedDelivery: "guide" } },
    });
    expect(client.calls.map(c => c.method)).toEqual(["readSession", "sendConversationCommandV4"]);
  });
  it("keeps one stable native queue identity across adapter recreation and distinguishes intentional identical text", async () => {
    const client = new NativeCommands();
    expect(await adapter(client).sendMessage("owned", { ...message, queue: true })).toMatchObject({ ok: true, admitted: true, pending: true });
    expect(await adapter(client).sendMessage("owned", { ...message, queue: true })).toMatchObject({ ok: true, admitted: true });
    expect(await adapter(client).sendMessage("owned", { ...message, inputId: "operation-2", queue: true })).toMatchObject({ ok: true, admitted: true });
    expect(client.commands.size).toBe(2);
    expect(client.calls.filter(c => c.method === "sendConversationCommandV4").map(c => c.params.envelope.commandId)).toEqual(["operation-1", "operation-1", "operation-2"]);
  });
  it("does not advertise a native guide fallback to queue as successful direct delivery", async () => {
    const client = new NativeCommands();
    client.reply = ({ envelope }) => ({ commandId: envelope.commandId, status: "accepted", revisionAtDecision: 5, result: { type: "inputAccepted", inputId: "native", delivery: "queue" } });
    expect(await adapter(client).sendMessage("owned", { ...message, steer: true })).toMatchObject({ ok: false, admitted: true, nonRetryable: true, inputId: "operation-1" });
    expect(client.calls).toHaveLength(2);
  });
  it("rejects an unrelated command receipt without retry or false admission", async () => {
    const client = new NativeCommands();
    client.reply = () => ({ commandId: "foreign", status: "accepted", revisionAtDecision: 5, result: { type: "inputAccepted", inputId: "native", delivery: "guide" } });
    expect(await adapter(client).sendMessage("owned", { ...message, steer: true })).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true });
    expect(client.calls).toHaveLength(2);
  });
  it("does not confuse accepted command envelope with input admission", async () => {
    const client = new NativeCommands();
    client.reply = ({ envelope }) => ({ commandId: envelope.commandId, status: "accepted", revisionAtDecision: 5 });
    expect(await adapter(client).sendMessage("owned", { ...message, steer: true })).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true });
  });
  it("preserves lost-receipt uncertainty and never replays through legacy sendPrompt", async () => {
    const client = new NativeCommands();
    client.reply = () => { throw new Error("transport disconnected after write"); };
    expect(await adapter(client).sendMessage("owned", { ...message, steer: true })).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true, inputId: "operation-1" });
    expect(client.calls.map(c => c.method)).toEqual(["readSession", "sendConversationCommandV4"]);
  });
  it("returns native unsupported rejection instead of quietly queueing or stopping", async () => {
    const client = new NativeCommands();
    client.reply = ({ envelope }) => ({ commandId: envelope.commandId, status: "rejected", revisionAtDecision: 5, reasonCode: "guide_not_supported", message: "Native guide unsupported" });
    expect(await adapter(client).sendMessage("owned", { ...message, steer: true })).toMatchObject({ ok: false, admitted: false, inputId: "operation-1", error: expect.stringContaining("guide_not_supported") });
    expect(client.calls).toHaveLength(2);
  });
  it("lets native idle guide resolve to startNow without inventing an active turnId", async () => {
    const client = new NativeCommands();
    client.reply = ({ envelope }) => ({ commandId: envelope.commandId, status: "accepted", revisionAtDecision: 5, result: { type: "inputAccepted", inputId: "native", delivery: "startNow" } });
    const result = await adapter(client).sendMessage("owned", { ...message, steer: true });
    expect(result).toMatchObject({ ok: true, admitted: true, inputId: "operation-1" });
    expect(result.turnId).toBeUndefined();
  });
  it("uses the automation origin identity on the registered MCP path", async () => {
    const client = new NativeCommands();
    expect(await adapter(client).sendMessage("owned", { message: message.message, inputId: message.inputId, steer: true })).toMatchObject({ ok: true, inputId: "operation-1" });
    expect(client.commands.has("agent-herder:auto:operation-1")).toBe(true);
  });
  it("reconciles native queue attribution after adapter recreation without assuming inputId equals commandId", async () => {
    const client = new NativeCommands();
    await adapter(client).sendMessage("owned", { ...message, origin: "automation", queue: true });
    client.events = [{ type: "turn.steerQueued", payload: { inputId: "different-native-id", intent: { sourceCommandId: "agent-herder:auto:operation-1" } } }];
    expect(await adapter(client).getMessageAdmission("owned", message.inputId)).toEqual({ state: "admitted" });
    expect(client.calls.filter(c => c.method === "sendConversationCommandV4")).toHaveLength(1);
  });
  it("reconciles persisted canonical sourceCommandId and keeps missing history uncertain", async () => {
    const client = new NativeCommands();
    client.messages = [{ info: { role: "user", metadata: { inputId: "different-native-id", sourceCommandId: "operation-1" } } }];
    expect(await adapter(client).getMessageAdmission("owned", message.inputId)).toEqual({ state: "admitted" });
    expect(await adapter(client).getMessageAdmission("owned", "not-observed")).toMatchObject({ state: "unknown" });
    expect(client.calls.some(c => c.method === "sendConversationCommandV4")).toBe(false);
  });
  it.each([{ inputId: "", delivery: "guide" }, { inputId: "native", delivery: "invalid" }])("rejects malformed native input receipt %j without replay", async result => {
    const client = new NativeCommands();
    client.reply = ({ envelope }) => ({ commandId: envelope.commandId, status: "accepted", revisionAtDecision: 5, result: { type: "inputAccepted", ...result } });
    expect(await adapter(client).sendMessage("owned", { ...message, steer: true })).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true });
    expect(client.calls).toHaveLength(2);
  });
  it("prioritizes an exact native failure after command-to-input attribution", async () => {
    const client = new NativeCommands();
    client.events = [
      { type: "turn.failed", payload: { inputId: "native-X", error: { type: "provider_error", message: "provider failed" } } },
      { type: "turn.steerQueued", payload: { inputId: "native-X", intent: { sourceCommandId: "operation-1" } } },
    ];
    expect(await adapter(client).getMessageAdmission("owned", "operation-1")).toMatchObject({ state: "failed", error: expect.stringContaining("provider failed") });
  });
  it("reconciles guide attribution in the native drainedInputs envelope", async () => {
    const client = new NativeCommands();
    client.events = [{ type: "turn.steerDrained", payload: { pendingInputIds: ["native-X"], targetTurnId: "active", injectedMessageIds: ["message-X"], drainedInputs: [{ pendingInputId: "native-X", messageId: "message-X", text: "owned", delivery: "guide", intent: { sourceCommandId: "operation-1" } }] } }];
    expect(await adapter(client).getMessageAdmission("owned", "operation-1")).toEqual({ state: "admitted" });
    expect(client.calls.some(c => c.method === "sendConversationCommandV4")).toBe(false);
  });
});
