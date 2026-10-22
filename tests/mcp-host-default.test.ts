import { describe, expect, it } from "vitest";
import { hostname } from "node:os";
import { normalizeHostId } from "../src/coordination-notes.js";
import {
  AgentInfoSchema,
  CreateSessionSchema,
  DeliverSchema,
  ListAgentsSchema,
  NewOrResumeSchema,
  SendMessageSchema,
  SetSessionTargetSchema,
} from "../src/mcp-tools/definitions.js";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";

// One machine has one spelling; "localhost" always means the machine of this process.
describe("work machine defaults", () => {
  it("normalizes a machine identity in exactly one place", () => {
    const local = hostname();
    expect(normalizeHostId(undefined, local)).toBe(local);
    expect(normalizeHostId("", local)).toBe(local);
    expect(normalizeHostId("   ", local)).toBe(local);
    expect(normalizeHostId(null, local)).toBe(local);
    expect(normalizeHostId("localhost", local)).toBe(local);
    expect(normalizeHostId("LOCALHOST", local)).toBe(local);
    expect(normalizeHostId("127.0.0.1", local)).toBe(local);
    expect(normalizeHostId("::1", local)).toBe(local);
    expect(normalizeHostId("  Server-44 ", local)).toBe("server-44");
    expect(normalizeHostId("SERVER-44", local)).toBe("server-44");
    expect(normalizeHostId(local.toUpperCase(), local)).toBe(local);
  });

  it("keeps list_agents on every machine and leaves the new schemas on the local host", () => {
    expect(ListAgentsSchema.parse({}).hostId).toBeUndefined();
    expect(SendMessageSchema.parse({ sessionId: "s", message: "m" }).hostId).toBeUndefined();
    expect(DeliverSchema.parse({ sessionId: "s", message: "m" }).hostId).toBeUndefined();
    expect(AgentInfoSchema.parse({ sessionId: "s" }).hostId).toBeUndefined();
    expect(CreateSessionSchema.parse({ harness: "codex", name: "n", cwd: "/w" }).hostId).toBeUndefined();
    expect(NewOrResumeSchema.parse({ harness: "codex", name: "n", cwd: "/w", message: "m" }).hostId).toBeUndefined();
    expect(SendMessageSchema.parse({ sessionId: "s", message: "m", hostId: "Server-44" }).hostId).toBe("Server-44");
    expect(normalizeHostId(SendMessageSchema.parse({ sessionId: "s", message: "m", hostId: "localhost" }).hostId, hostname())).toBe(hostname());
  });

  it("requires at least one of hostId and cwd for set_session_target", () => {
    expect(SetSessionTargetSchema.safeParse({ sessionId: "s" }).success).toBe(false);
    expect(SetSessionTargetSchema.safeParse({ sessionId: "s", hostId: "server-44" }).success).toBe(true);
    expect(SetSessionTargetSchema.safeParse({ sessionId: "s", cwd: "/w" }).success).toBe(true);
    expect(SetSessionTargetSchema.safeParse({ sessionId: "s", hostId: "server 44" }).success).toBe(false);
  });

  it("routes an explicit machine into the session route and keeps the local host without one", async () => {
    const seen: Array<{ hostId: string; harness: string; nativeSessionId: string }> = [];
    const callbacks = new Map<string, (args: unknown) => Promise<unknown>>();
    const events = new HerderEventBus();
    registerSessionTools(
      { registerTool: (name: string, _schema: unknown, cb: (args: unknown) => Promise<unknown>) => { callbacks.set(name, cb); } } as never,
      {
        adapters: new Map(),
        jobs: new HerderJobRegistry(events),
        events,
        integratorRuntime: {
          adapterForSession: async (address: { hostId: string; harness: string; nativeSessionId: string }) => {
            seen.push(address);
            return { kind: "ordinary" as const };
          },
        } as never,
      },
    );
    const send = callbacks.get("send_message")!;
    // A machine other than this one has no local adapter: the tool says so honestly.
    await expect(send({ sessionId: "s", message: "m", hostId: "Server-44" })).rejects.toThrow("host_target_unavailable:server-44");
    expect(seen.at(-1)?.hostId).toBe("server-44");
    // Without an explicit machine the route stays exactly the local host.
    await send({ sessionId: "s", message: "m" }).catch(() => undefined);
    expect(seen.at(-1)?.hostId).toBe(hostname());
  });
});
