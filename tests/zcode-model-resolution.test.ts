import { describe, expect, it } from "vitest";
import { ZcodeAdapter, type ZcodeAdapterOptions } from "../src/adapters/zcode.js";
import type { ZcodeClientLike } from "../src/adapters/zcode-protocol.js";

const providerId = "4cc673aa-6c6a-418b-8b91-9e601fef99f6";
const selectedModel = "minimax/MiniMax-M3";

class ModelResolutionClient implements ZcodeClientLike {
  readonly calls: Array<{ channel: string; method: string; args: unknown[] }> = [];
  private started = false;

  async start(): Promise<void> { this.started = true; }
  async close(): Promise<void> { this.started = false; }
  isStarted(): boolean { return this.started; }

  async call(channel: string, method: string, args: unknown[]): Promise<unknown> {
    this.calls.push({ channel, method, args });
    if (channel === "model-selection" && method === "getView") {
      return { providers: [{ providerId, providerName: "minimax", models: [{ modelId: "MiniMax-M3", config: { enabled: true } }] }] };
    }
    if (channel === "zcode-agent" && method === "createSession") {
      return { session: { sessionId: "created-fake-session", status: "idle", model: (args[0] as { model?: unknown }).model } };
    }
    if (channel === "zcode-task" && method === "renameTask") return { title: (args[0] as { title: string }).title };
    throw new Error(`unexpected fake ZCode call ${channel}.${method}`);
  }
}

describe("ZCode model identity", () => {
  it("launches the exact listed provider alias through its native provider identity", async () => {
    const client = new ModelResolutionClient();
    const adapter = new ZcodeAdapter({
      cwd: "/workspace",
      client,
      modelIds: [selectedModel],
    } satisfies ZcodeAdapterOptions);

    try {
      expect(await adapter.listModels()).toContain(selectedModel);

      await adapter.createSession({ name: "model-resolution-fixture", cwd: "/workspace", model: selectedModel });

      expect(client.calls.find((call) => call.method === "createSession")?.args[0]).toMatchObject({
        model: { providerId, modelId: "MiniMax-M3" },
      });
    } finally {
      await adapter.dispose();
    }
  });
});
