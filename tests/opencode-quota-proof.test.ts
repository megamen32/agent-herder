import { expect, it, vi } from "vitest";
import plugin from "../integrations/opencode/agent-herder-autopilot.js";

function nativeClient(options: { metadata?: Record<string, unknown>; status?: number } = {}) {
  const session = {
    id: "ses_quota",
    outcome: "failed",
    metadata: options.metadata ?? { retained: { owner: "other-plugin" } },
  };
  // SDK response is in the explicitly requested chronological `order: asc`.
  const messages = [
    { info: { id: "msg_user", sessionID: session.id, role: "user", metadata: { agentHerderInputId: "dispatch-stable-id" } }, parts: [] },
    { info: {
      id: "msg_assistant", parentID: "msg_user", sessionID: session.id, role: "assistant",
      providerID: "omniroute", modelID: "minimax/MiniMax-M3.1-Flash",
      statusCode: options.status ?? 429,
      error: { code: "quota_exhausted", message: "Weekly limit exhausted; Bearer secret-token-value" },
    }, parts: [] },
  ];
  return {
    state: { session },
    session: {
      get: vi.fn(async () => ({ data: { ...session, metadata: session.metadata } })),
      messages: vi.fn(async () => ({ data: messages })),
      update: vi.fn(async ({ body }: { body: { metadata: Record<string, unknown> } }) => {
        session.metadata = body.metadata;
        return { data: session };
      }),
    },
  };
}

async function emitTerminalQuota(hooks: any) {
  await hooks.event({ event: { type: "message.updated", properties: { info: {
    id: "msg_assistant", parentID: "msg_user", sessionID: "ses_quota", role: "assistant",
    providerID: "omniroute", modelID: "minimax/MiniMax-M3.1-Flash",
    metadata: {}, error: { code: "quota_exhausted", status: 429, message: "Weekly limit exhausted" },
  } } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_quota" } } });
}

const fakeShell = (..._args: unknown[]) => ({ quiet: async () => ({ text: () => JSON.stringify({ enabled: false }) }) });

it("persists exact terminal native lineage, preserving metadata and verifying readback", async () => {
  const client = nativeClient();
  const hooks = await plugin.server({ directory: "/tmp", client, $: fakeShell } as any);
  await emitTerminalQuota(hooks);
  expect(client.session.update).toHaveBeenCalledTimes(1);
  expect(client.session.messages).toHaveBeenCalledWith({
    path: { id: "ses_quota" }, query: { order: "asc", limit: 150 },
  });
  expect(client.state.session.metadata).toMatchObject({
    retained: { owner: "other-plugin" },
    agentHerder: { quotaFailure: {
      status: "failed", inputId: "dispatch-stable-id", userMessageId: "msg_user",
      parentMessageId: "msg_user", assistantMessageId: "msg_assistant", nativeTurnId: "msg_assistant",
      providerId: "omniroute", modelId: "minimax/MiniMax-M3.1-Flash",
      errorCode: "quota_exhausted", statusCode: 429,
    } },
  });
  expect(JSON.stringify(client.state.session.metadata)).not.toContain("secret-token-value");
});

it("V2 setup subscribes to native events and persists exact quota proof through the V2 session context", async () => {
  const client = nativeClient();
  const events = [
    { type: "message.updated", properties: { info: {
      id: "msg_assistant", parentID: "msg_user", sessionID: "ses_quota", role: "assistant",
      providerID: "omniroute", modelID: "minimax/MiniMax-M3.1-Flash",
      metadata: {}, statusCode: 429, error: { code: "quota_exhausted", message: "Weekly limit exhausted" },
    } } },
    { type: "session.idle", properties: { sessionID: "ses_quota" } },
  ];
  const ctx = {
    event: { subscribe: vi.fn(({ signal }: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          if (signal.aborted) return;
          yield event;
        }
      },
    })) },
    session: client.session,
  };
  const dispose = await plugin.setup(ctx);
  await vi.waitFor(() => expect(client.session.update).toHaveBeenCalledTimes(1));
  expect(ctx.event.subscribe).toHaveBeenCalledTimes(1);
  expect(ctx.event.subscribe.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  expect(client.state.session.metadata).toMatchObject({
    agentHerder: { quotaFailure: {
      inputId: "dispatch-stable-id", parentMessageId: "msg_user",
      assistantMessageId: "msg_assistant", statusCode: 429,
    } },
  });
  await dispose();
  expect(ctx.event.subscribe.mock.calls[0][0].signal.aborted).toBe(true);
});

it.each([401, 403, 502])("does not persist quota proof for authentication/status %s even with quota wording", async status => {
  const client = nativeClient({ status });
  const hooks = await plugin.server({ directory: "/tmp", client, $: fakeShell } as any);
  await emitTerminalQuota(hooks);
  expect(client.session.update).not.toHaveBeenCalled();
});

it("fails closed when native session metadata is absent", async () => {
  const client = nativeClient({ metadata: undefined });
  client.session.get.mockImplementation(async () => ({ data: { ...client.state.session, metadata: undefined } }));
  const hooks = await plugin.server({ directory: "/tmp", client, $: fakeShell } as any);
  await emitTerminalQuota(hooks);
  expect(client.session.update).not.toHaveBeenCalled();
});

it("does not accept metadata writes whose native readback differs", async () => {
  const client = nativeClient();
  client.session.update.mockImplementation(async () => ({ data: client.state.session }));
  const hooks = await plugin.server({ directory: "/tmp", client, $: fakeShell } as any);
  await emitTerminalQuota(hooks);
  expect(client.session.update).toHaveBeenCalledTimes(1);
  expect(client.state.session.metadata).not.toHaveProperty("agentHerder.quotaFailure");
});
