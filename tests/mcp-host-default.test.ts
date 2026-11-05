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
    expect(normalizeHostId("remote-ssh-discovered:104.bezrabotnyi.com", "roomhacker-server-100")).toBe("roomhacker-server-100");
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
        // No machine is callable here: the machine of this test is this one only.
        routingPeers: [],
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

  it("never creates a requested remote session on the local machine when its owner is unavailable", async () => {
    let localCreates = 0;
    const callbacks = new Map<string, (args: any) => Promise<unknown>>();
    const events = new HerderEventBus();
    const adapter = {
      type: "codex", name: "Codex",
      listSessions: async () => [],
      createSession: async () => { localCreates++; return { id: "local-wrong-host" }; },
    };
    registerSessionTools({ registerTool: (name: string, _schema: unknown, cb: any) => callbacks.set(name, cb) } as never, {
      adapters: new Map([["codex", adapter as never]]), jobs: new HerderJobRegistry(events), events, routingPeers: [],
    });
    await expect(callbacks.get("create_session")!({ harness: "codex", name: "remote-test", cwd: "/tmp", hostId: "server-44", model: "gpt-6-luna" }))
      .rejects.toThrow("host_target_unavailable:server-44");
    expect(localCreates).toBe(0);
  });

  it("routes remote creation to its owner with a stable intent and preserves the host in its receipt", async () => {
    const calls: any[] = [];
    const callbacks = new Map<string, (args: any) => Promise<any>>();
    const events = new HerderEventBus();
    const peer = { hostId: "server-44", sshHost: "example.invalid", nativeUser: "user", port: 1, python: "/usr/bin/python3" };
    const transport = { call: async (...args: any[]) => { calls.push(args); return args[1] === "fleet_node_info" ? { structuredContent: { hostId: "server-44", guardedNamedCreate: true } } : { structuredContent: { ok: true, created: true, harness: "codex", sessionId: "remote-id", cwd: "/tmp" } }; } };
    registerSessionTools({ registerTool: (name: string, _schema: unknown, cb: any) => callbacks.set(name, cb) } as never, {
      adapters: new Map(), jobs: new HerderJobRegistry(events), events, routingPeers: [peer], transport: transport as never,
    });
    const args = { harness: "codex", name: "remote-test", cwd: "/tmp", hostId: "server-44", model: "gpt-6-luna" };
    const reply = await callbacks.get("create_session")!(args);
    expect(calls[0][1]).toBe("fleet_node_info");
    expect(calls[1][0]).toBe("mcp:shell:server-44:AgentHerder");
    expect(calls[1][1]).toBe("create_session");
    expect(calls[1][3]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(reply.content[0].text)).toMatchObject({ ok: true, sessionId: "remote-id", hostId: "server-44" });
  });

  it("refuses creation before mutation when an older owner lacks the HumanStop guard", async () => {
    const callbacks = new Map<string, (args: any) => Promise<any>>();
    const events = new HerderEventBus();
    const peer = { hostId: "server-44", sshHost: "example.invalid", nativeUser: "user", port: 1, python: "/usr/bin/python3" };
    const calls: string[] = [];
    const transport = { call: async (_target: string, tool: string) => { calls.push(tool); return { structuredContent: { hostId: "server-44" } }; } };
    registerSessionTools({ registerTool: (name: string, _schema: unknown, cb: any) => callbacks.set(name, cb) } as never, {
      adapters: new Map(), jobs: new HerderJobRegistry(events), events, routingPeers: [peer], transport: transport as never,
    });
    await expect(callbacks.get("create_session")!({ harness: "codex", name: "held", cwd: "/tmp", hostId: "server-44" })).rejects.toThrow("remote_named_create_guard_unavailable");
    expect(calls).toEqual(["fleet_node_info"]);
  });

  it("does not fall back locally when a named remote create-and-deliver has no route", async () => {
    const callbacks = new Map<string, (args: any) => Promise<unknown>>();
    const events = new HerderEventBus();
    let created = 0;
    const adapter = { type: "codex", name: "Codex", listSessions: async () => [], createSession: async () => { created++; return { id: "wrong-host" }; } };
    registerSessionTools({ registerTool: (name: string, _schema: unknown, cb: any) => callbacks.set(name, cb) } as never, {
      adapters: new Map([["codex", adapter as never]]), jobs: new HerderJobRegistry(events), events, routingPeers: [],
    });
    await expect(callbacks.get("new_or_resume")!({ harness: "codex", name: "remote-deliver", cwd: "/tmp", hostId: "server-44", message: "test" }))
      .rejects.toThrow("host_target_unavailable:server-44");
    expect(created).toBe(0);
  });

  it("does not use local adapters for a remote session when the project router is absent", async () => {
    const callbacks = new Map<string, (args: any) => Promise<unknown>>();
    const events = new HerderEventBus();
    registerSessionTools({ registerTool: (name: string, _schema: unknown, cb: any) => callbacks.set(name, cb) } as never, {
      adapters: new Map(), jobs: new HerderJobRegistry(events), events, routingPeers: [],
    });
    await expect(callbacks.get("deliver")!({ sessionId: "remote-id", harness: "codex", hostId: "server-44", message: "test" }))
      .rejects.toThrow("host_target_unavailable:server-44");
  });

  it("sends an explicit remote start through the owning peer using its existing admission path", async () => {
    const callbacks = new Map<string, (args: any) => Promise<any>>();
    const events = new HerderEventBus();
    const peer = { hostId: "server-44", sshHost: "example.invalid", nativeUser: "user", port: 1, python: "/usr/bin/python3" };
    const calls: any[] = [];
    const transport = { call: async (...args: any[]) => { calls.push(args); return { content: [{ type: "text", text: '{"ok":true,"delivery":"durable_pending"}' }] }; } };
    registerSessionTools({ registerTool: (name: string, _schema: unknown, cb: any) => callbacks.set(name, cb) } as never, {
      adapters: new Map(), jobs: new HerderJobRegistry(events), events, routingPeers: [peer], transport: transport as never,
    });
    await callbacks.get("deliver")!({ sessionId: "remote-id", harness: "codex", hostId: "server-44", message: "test", inputId: "intent-1", activation: "always" });
    expect(calls[0][0]).toBe("mcp:shell:server-44:AgentHerder");
    expect(calls[0][1]).toBe("send_message");
    expect(calls[0][2]).toMatchObject({ sessionId: "remote-id", harness: "codex", message: "test", inputId: "intent-1", mode: "queue" });
    expect(calls[0][2]).not.toHaveProperty("humanRequested");
  });

  it("marks a lost remote delivery response unknown without sending again", async () => {
    const callbacks = new Map<string, (args: any) => Promise<any>>();
    const events = new HerderEventBus();
    const peer = { hostId: "server-44", sshHost: "example.invalid", nativeUser: "user", port: 1, python: "/usr/bin/python3" };
    let calls = 0;
    const transport = { call: async () => { calls++; throw new Error("connection lost"); } };
    registerSessionTools({ registerTool: (name: string, _schema: unknown, cb: any) => callbacks.set(name, cb) } as never, {
      adapters: new Map(), jobs: new HerderJobRegistry(events), events, routingPeers: [peer], transport: transport as never,
    });
    const reply = await callbacks.get("deliver")!({ sessionId: "remote-id", harness: "codex", hostId: "server-44", message: "test", inputId: "intent-1", activation: "always" });
    expect(JSON.parse(reply.content[0].text)).toMatchObject({ delivery: "unknown", admissionUnknown: true, nonRetryable: true, inputId: "intent-1" });
    expect(calls).toBe(1);
  });

  it("preserves project-scope denial before forwarding remote delivery", async () => {
    const callbacks = new Map<string, (args: any) => Promise<any>>();
    const events = new HerderEventBus();
    const peer = { hostId: "server-44", sshHost: "example.invalid", nativeUser: "user", port: 1, python: "/usr/bin/python3" };
    let calls = 0;
    registerSessionTools({ registerTool: (name: string, _schema: unknown, cb: any) => callbacks.set(name, cb) } as never, {
      adapters: new Map(), jobs: new HerderJobRegistry(events), events, routingPeers: [peer],
      transport: { call: async () => { calls++; } } as never,
      integratorRuntime: { adapterForSession: async () => ({ kind: "deny" }) } as never,
    });
    await expect(callbacks.get("deliver")!({ sessionId: "remote-id", harness: "codex", hostId: "server-44", message: "test", inputId: "intent-1", activation: "always" }))
      .rejects.toThrow("project_session_scope_unavailable");
    expect(calls).toBe(0);
  });
});
