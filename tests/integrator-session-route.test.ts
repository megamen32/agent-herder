import { mkdtemp, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createWebServer } from "../src/web/server.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import type { AgentSession, HarnessAdapter, SendMessageOptions } from "../src/types/index.js";

function record(id: string, role: "user" | "assistant", text: string): string {
  return JSON.stringify({ type: "response_item", payload: { type: "message", id, role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
}

describe("exact native transcript session route", () => {
  it("pages the current adapter export with scoped continuation while appends stay outside the frozen prefix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herder-integrator-transcript-"));
    let exported = [record("m1", "user", "hello"), record("m2", "assistant", "answer"), record("m3", "user", "again")].join("\n") + "\n";
    const session: AgentSession = { id: "thread-1", harness: "codex", status: "running", title: "fixture", cwd: dir, lastActivity: new Date().toISOString() };
    const getSession = vi.fn(async (id: string) => id === session.id ? session : null);
    const adapter = {
      type: "codex", name: "fixture", async init() {}, async listSessions() { return [session]; }, getSession,
      async getRawTranscript(id: string) {
        if (id !== session.id) return null;
        return { bytes: new TextEncoder().encode(exported), complete: true, source: { kind: "native-file" as const, location: "adapter-export", format: "jsonl" as const }, timestampCoverage: "partial" as const };
      },
      async sendMessage() { return { ok: true, admitted: true, turnId: "turn-1" }; },
      async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
    } as HarnessAdapter;
    const adapters = new Map([["codex", adapter]]);
    const supervisor = { async getSession(harness: string, id: string) { return harness === "codex" && id === session.id ? session : null; } } as any;
    const server = createWebServer({ adapters, converter: {} as any, supervisor, jobs: new HerderJobRegistry(new HerderEventBus()) });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture bind failed");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const firstResponse = await fetch(`${base}/api/sessions/codex/thread-1/transcript?limit=1`);
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json() as any;
      expect(first.session).toMatchObject({ id: "thread-1", harness: "codex", status: "running" });
      expect(first.transcript.scope).toEqual({ hostId: hostname(), harness: "codex", nativeSessionId: "thread-1" });
      expect(first.transcript.events[0]).toMatchObject({ eventId: "m1", author: { kind: "unknown", sourceRole: "user" }, text: "hello" });
      expect(first.transcript.nextCursor).toEqual(expect.any(String));
      expect(first.steerEndpoint).toBe("/api/sessions/codex/thread-1/message");

      exported += `${record("m4", "assistant", "appended")}\n`;
      const secondResponse = await fetch(`${base}/api/sessions/codex/thread-1/transcript?limit=1&cursor=${encodeURIComponent(first.transcript.nextCursor)}`);
      expect(secondResponse.status).toBe(200);
      const second = await secondResponse.json() as any;
      expect(second.transcript.events.map((event: any) => event.eventId)).toEqual(["m2"]);
      const thirdResponse = await fetch(`${base}/api/sessions/codex/thread-1/transcript?limit=1&cursor=${encodeURIComponent(second.transcript.nextCursor)}`);
      const third = await thirdResponse.json() as any;
      expect(third.transcript.events.map((event: any) => event.eventId)).toEqual(["m3"]);
      expect(third.transcript.complete).toBe(true);
      const fresh = await (await fetch(`${base}/api/sessions/codex/thread-1/transcript?limit=1`)).json() as any;
      expect(fresh.transcript.totalEvents).toBe(4);
      expect(getSession).toHaveBeenCalledWith("thread-1");

      const wrongSession = await fetch(`${base}/api/sessions/codex/other/transcript?limit=1`);
      expect(wrongSession.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns the exact existing steer endpoint for its bound session", async () => {
    const session: AgentSession = { id: "exact-id", harness: "codex", status: "idle", cwd: "/tmp", lastActivity: new Date().toISOString() };
    const sendMessage = vi.fn(async (_id: string, _options: SendMessageOptions) => ({ ok: true, admitted: true }));
    const adapter = { type: "codex", name: "fixture", async init() {}, async listSessions() { return [session]; }, async getSession() { return session; }, async getRawTranscript() {
      return { bytes: new TextEncoder().encode(record("m", "assistant", "ready") + "\n"), complete: true, source: { kind: "native-file" as const, location: "adapter-export", format: "jsonl" as const }, timestampCoverage: "none" as const };
    }, sendMessage, async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; } } as HarnessAdapter;
    const adapters = new Map([["codex", adapter]]);
    const jobs = new HerderJobRegistry(new HerderEventBus());
    const server = createWebServer({ adapters, converter: {} as any, supervisor: { async sendMessage(harness: string, id: string, options: SendMessageOptions) {
      if (harness !== "codex" || id !== session.id) throw new Error("wrong target");
      return sendMessage(id, options);
    } } as any, jobs });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture bind failed");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const page = await (await fetch(`${base}/api/sessions/codex/exact-id/transcript`)).json() as any;
      const steer = await fetch(`${base}${page.steerEndpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "Continue this task", humanRequested: true, inputId: "integrator-steer-1", mode: "steer" }) });
      expect([200, 202]).toContain(steer.status);
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
      expect(sendMessage).toHaveBeenCalledWith("exact-id", expect.objectContaining({ origin: "human", inputId: "integrator-steer-1", steer: true }));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
