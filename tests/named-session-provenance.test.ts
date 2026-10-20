import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newOrResumeNamedSession } from "../src/named-session.js";
import type { AgentSession, CreateSessionOptions, HarnessAdapter, SendMessageOptions } from "../src/types/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function session(id: string, cwd: string): AgentSession {
  return { id, harness: "codex", status: "idle", title: id, cwd, lastActivity: new Date().toISOString(), needsPermission: false };
}

function fakeAdapter(cwd: string) {
  const sent: SendMessageOptions[] = [];
  let created: AgentSession | undefined;
  const adapter: HarnessAdapter = {
    type: "codex",
    name: "Fake Codex",
    async init() {},
    async listSessions() { return created ? [created] : []; },
    async getSession(id) { return created?.id === id ? created : null; },
    async createSession(_options: CreateSessionOptions) { created = session("codex-child", cwd); return created; },
    async sendMessage(_id, options) { sent.push(options); return { ok: true }; },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
  return { adapter, sent };
}

describe("new_or_resume relay provenance", () => {
  it.each([false, true])("marks the prompt as an AI relay when humanRequested=%s without changing the body or delivery identity", async (humanRequested) => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-herder-relay-"));
    tempDirs.push(cwd);
    const fake = fakeAdapter(cwd);
    const body = "Do the assigned work.\nKeep this exact second line.";
    const result = await newOrResumeNamedSession(new Map([["codex", fake.adapter]]), {
      harness: "codex", name: `relay-${humanRequested}`, cwd, message: body,
      inputId: "stable-relay-input", humanRequested,
    });

    expect(result.ok).toBe(true);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.message).toBe(
      "🤖 Сообщение от ИИ через Agent Herder\n<agent-herder-origin version=\"1\" kind=\"agent-relay\" transport=\"new_or_resume\" />\n\n" + body,
    );
    expect(fake.sent[0]).toMatchObject({ inputId: "stable-relay-input", origin: humanRequested ? "human" : "automation" });
  });
});
