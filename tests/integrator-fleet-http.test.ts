import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebServer } from "../src/web/server.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import type { Server } from "node:http";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

function session(id: string): AgentSession {
  return { id, harness: "codex", status: "idle", title: id, cwd: "/project", lastActivity: new Date(0).toISOString(), needsPermission: false };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("owner HTTP scoped Fleet session routes", () => {
  it("keeps transcript, message, resume, and stop on the per-request scoped port; ordinary routes stay unchanged", async () => {
    const scopedGet = vi.fn(async (id: string) => id === "scoped-1" ? session(id) : null);
    const scopedMessages = vi.fn(async () => [{ id: "m1", role: "assistant" as const, text: "scoped preview", parts: [{ type: "text" as const, text: "scoped preview" }] }]);
    const scopedRaw = vi.fn(async () => ({ bytes: new TextEncoder().encode(JSON.stringify({ type: "response_item", payload: { type: "message", id: "raw-1", role: "assistant", content: [{ type: "output_text", text: "full scoped transcript" }] } }) + "\n"), complete: true, source: { kind: "native-file" as const, location: "fixture", format: "jsonl" as const }, timestampCoverage: "none" as const }));
    const ordinaryGet = vi.fn(async (id: string) => id === "ordinary-1" ? session(id) : null);
    const ordinaryRaw = vi.fn(async () => ({ bytes: new TextEncoder().encode(JSON.stringify({ type: "response_item", payload: { type: "message", id: "ordinary-raw", role: "assistant", content: [{ type: "output_text", text: "ordinary transcript" }] } }) + "\n"), complete: true, source: { kind: "native-file" as const, location: "ordinary", format: "jsonl" as const }, timestampCoverage: "none" as const }));
    const scopedAdapter: HarnessAdapter = {
      type: "codex", name: "scoped fixture", async init() {}, async listSessions() { return [session("scoped-1")]; },
      getSession: scopedGet, getSessionMessages: scopedMessages, getRawTranscript: scopedRaw,
      async sendMessage() { return { ok: true }; }, async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
    };
    const ordinaryAdapter: HarnessAdapter = {
      ...scopedAdapter, name: "ordinary fixture", getSession: ordinaryGet, getRawTranscript: ordinaryRaw,
    };
    const supervisor = {
      getSession: vi.fn(async (_harness: string, id: string) => id === "ordinary-1" ? session(id) : null),
      getSessionDetails: vi.fn(async (_harness: string, id: string) => ({
        session: session(id), lineage: { kind: "external" }, children: [],
        messages: [{ id: "ordinary-message", role: "assistant", text: "ordinary", parts: [{ type: "text", text: "ordinary" }] }],
        history: { source: "acp-load", complete: false },
      })),
      sendMessage: vi.fn(async (_harness: string, _id: string) => ({ ok: true, admitted: true })),
      resumeSession: vi.fn(async () => ({ ok: true })), stopSession: vi.fn(async () => ({ ok: true })),
    };
    const scopedSupervisor = {
      getSession: vi.fn(async (_harness: string, id: string) => id === "scoped-1" ? session(id) : null),
      getSessionDetails: vi.fn(async (_harness: string, id: string, options?: { quick?: boolean }) => {
        const exact = await scopedAdapter.getSession(id, { includeMetrics: !options?.quick });
        const messages = await scopedAdapter.getSessionMessages?.(id, 3) ?? [];
        return { session: exact!, lineage: { kind: "unknown" }, children: [], messages, history: { source: "acp-load", complete: false } };
      }),
      sendMessage: vi.fn(async (_harness: string, _id: string) => ({ ok: true, admitted: true })),
      resumeSession: vi.fn(async () => ({ ok: true })), stopSession: vi.fn(async () => ({ ok: true })),
    };
    const integratorRuntime = {
      adapterForSession: vi.fn(async ({ nativeSessionId }: { nativeSessionId: string }) =>
        nativeSessionId === "scoped-1" ? { kind: "scoped" as const, adapter: scopedAdapter }
          : nativeSessionId === "ordinary-1" ? { kind: "ordinary" as const }
            : { kind: "deny" as const, reason: "binding_unresolved" }),
    };
    const scopedSupervisorFactory = vi.fn((sessionAdapters: Map<string, HarnessAdapter>) => {
      if (sessionAdapters.get("codex") !== scopedAdapter) throw new Error("scoped adapter map was not isolated");
      return scopedSupervisor as any;
    });
    const jobs = new HerderJobRegistry(new HerderEventBus());
    const server = createWebServer({ adapters: new Map([["codex", ordinaryAdapter]]), converter: {} as any, supervisor: supervisor as any,
      integratorRuntime: integratorRuntime as any, scopedSupervisorFactory, jobs });
    const base = await listen(server);

    const scopedRead = await fetch(`${base}/api/sessions/codex/scoped-1/details?quick=1`);
    expect(scopedRead.status).toBe(200);
    expect((await scopedRead.json()).messages).toMatchObject([{ id: "m1", text: "scoped preview" }]);
    expect(scopedGet).toHaveBeenCalledWith("scoped-1", { includeMetrics: false });
    expect(scopedMessages).toHaveBeenCalledOnce();
    expect(supervisor.getSessionDetails).not.toHaveBeenCalled();

    const transcript = await fetch(`${base}/api/sessions/codex/scoped-1/transcript`);
    expect(transcript.status).toBe(200);
    expect(JSON.stringify(await transcript.json())).toContain("full scoped transcript");
    expect(scopedRaw).toHaveBeenCalledOnce(); expect(ordinaryRaw).not.toHaveBeenCalled();

    const unresolved = await fetch(`${base}/api/sessions/codex/unresolved/details?quick=1`);
    expect(unresolved.status).toBe(409);
    expect(supervisor.getSessionDetails).not.toHaveBeenCalled();

    const messageBody = { humanRequested: true, inputId: "stable-scoped-message-1", mode: "steer", message: "continue" };
    const firstMessage = await fetch(`${base}/api/sessions/codex/scoped-1/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(messageBody) });
    expect([200, 202]).toContain(firstMessage.status);
    await vi.waitFor(() => expect(scopedSupervisor.sendMessage).toHaveBeenCalledTimes(1));
    const replay = await fetch(`${base}/api/sessions/codex/scoped-1/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(messageBody) });
    expect([200, 202]).toContain(replay.status);
    expect(scopedSupervisor.sendMessage).toHaveBeenCalledTimes(1);
    expect(supervisor.sendMessage).not.toHaveBeenCalled();

    const scopedResume = await fetch(`${base}/api/sessions/codex/scoped-1/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ humanRequested: true, inputId: "stable-resume-1" }) });
    expect(scopedResume.status).toBe(200); expect(scopedSupervisor.resumeSession).toHaveBeenCalledOnce();
    const scopedStop = await fetch(`${base}/api/sessions/codex/scoped-1/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ humanRequested: true }) });
    expect(scopedStop.status).toBe(200); expect(scopedSupervisor.stopSession).toHaveBeenCalledOnce();
    expect(supervisor.stopSession).not.toHaveBeenCalled();

    const ordinaryRead = await fetch(`${base}/api/sessions/codex/ordinary-1/details?quick=1`);
    expect(ordinaryRead.status).toBe(200);
    expect(supervisor.getSessionDetails).toHaveBeenCalledOnce();
    const ordinaryStop = await fetch(`${base}/api/sessions/codex/ordinary-1/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ humanRequested: true }) });
    expect(ordinaryStop.status).toBe(200);
    expect(supervisor.stopSession).toHaveBeenCalledOnce();
    const ordinaryMessage = await fetch(`${base}/api/sessions/codex/ordinary-1/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...messageBody, inputId: "stable-ordinary-message-1" }) });
    expect([200, 202]).toContain(ordinaryMessage.status);
    await vi.waitFor(() => expect(supervisor.sendMessage).toHaveBeenCalledTimes(1));
    expect(scopedSupervisor.sendMessage).toHaveBeenCalledTimes(1);
    expect(ordinaryAdapter.getSession).toHaveBeenCalledWith("ordinary-1");
  });
});
