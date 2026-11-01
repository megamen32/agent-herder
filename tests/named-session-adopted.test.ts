import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newOrResumeNamedSession } from "../src/named-session.js";
import type { AgentSession, CreateSessionOptions, HarnessAdapter, SendMessageOptions } from "../src/types/index.js";

// The first adoption of an existing native chat (a browser chat found by its
// title) reports adopted exactly once and never creates anything, so the
// supervisor can deliver the owner MCP intro on the first binding.
const cleanups: string[] = [];
const previousStore = process.env.AGENT_HERDER_NAMED_SESSION_STORE;

afterEach(async () => {
  if (previousStore === undefined) delete process.env.AGENT_HERDER_NAMED_SESSION_STORE;
  else process.env.AGENT_HERDER_NAMED_SESSION_STORE = previousStore;
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agent-herder-adopted-"));
  cleanups.push(path);
  return realpath(path);
}

function session(id: string, title: string, cwd: string): AgentSession {
  return { id, harness: "codex", status: "idle", title, cwd, lastActivity: new Date().toISOString(), needsPermission: false };
}

function adoptableAdapter(cwd: string, existing: AgentSession) {
  let creates = 0;
  const sent: SendMessageOptions[] = [];
  const adapter: HarnessAdapter = {
    type: "codex",
    name: "Fake adoptable",
    async init() {},
    async listSessions() { return [existing]; },
    async getSession(id) { return existing.id === id ? existing : null; },
    async createSession(_options: CreateSessionOptions) { creates += 1; return existing; },
    async findNamedSessions(name, _requestedCwd) { return existing.title === name ? [existing] : []; },
    async sendMessage(_id, options) { sent.push(options); return { ok: true }; },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
  return { adapter, creates: () => creates, sent };
}

describe("first adoption of an existing chat", () => {
  it("reports adopted exactly once for a chat found by title and never creates", async () => {
    const cwd = await workspace();
    process.env.AGENT_HERDER_NAMED_SESSION_STORE = join(cwd, "named-sessions.json");
    const existing = session("codex-existing", "Adopt me", cwd);
    const fake = adoptableAdapter(cwd, existing);

    const first = await newOrResumeNamedSession(new Map([["codex", fake.adapter]]), {
      harness: "codex", name: "Adopt me", cwd, message: "first", mode: "queue", humanRequested: true,
    });
    expect(first).toMatchObject({ ok: true, created: false, adopted: true, sessionId: existing.id });
    expect(fake.creates()).toBe(0);
    expect(fake.sent).toHaveLength(1);

    const second = await newOrResumeNamedSession(new Map([["codex", fake.adapter]]), {
      harness: "codex", name: "Adopt me", cwd, message: "second", mode: "queue", humanRequested: true,
    });
    expect(second).toMatchObject({ ok: true, created: false, sessionId: existing.id });
    expect(second.adopted).toBeFalsy();
    expect(fake.creates()).toBe(0);
  });

  it("keeps created without adopted when the session is actually created", async () => {
    const cwd = await workspace();
    process.env.AGENT_HERDER_NAMED_SESSION_STORE = join(cwd, "named-sessions.json");
    const existing = session("codex-existing", "Adopt me", cwd);
    const fake = adoptableAdapter(cwd, existing);
    fake.adapter.findNamedSessions = async () => [];

    const result = await newOrResumeNamedSession(new Map([["codex", fake.adapter]]), {
      harness: "codex", name: "Fresh one", cwd, message: "hello", mode: "queue", humanRequested: true,
    });
    expect(result).toMatchObject({ ok: true, created: true, sessionId: existing.id });
    expect(result.adopted).toBeFalsy();
    expect(fake.creates()).toBe(1);
  });
});
