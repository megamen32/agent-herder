import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createNamedSession, newOrResumeNamedSession } from "../src/named-session.js";
import { toolDefinitions } from "../src/mcp-tools/definitions.js";
import { handleCreateSession, handleNewOrResume } from "../src/mcp-tools/handlers.js";
import type { AgentSession, CreateSessionOptions, HarnessAdapter, SendMessageOptions } from "../src/types/index.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agent-herder-named-session-"));
  cleanups.push(path);
  return realpath(path);
}

function session(id: string, title: string, cwd: string, harness: "opencode" | "codex" = "opencode"): AgentSession {
  return {
    id,
    harness,
    status: "idle",
    title,
    cwd,
    lastActivity: new Date().toISOString(),
    needsPermission: false,
  };
}

function fakeAdapter(harness: "opencode" | "codex", initial: AgentSession[] = []) {
  const sessions = [...initial];
  const deliveries: Array<{ id: string; options: SendMessageOptions }> = [];
  let creates = 0;
  let failDelivery = false;
  const adapter: HarnessAdapter = {
    type: harness,
    name: `Fake ${harness}`,
    async init() {},
    async listSessions() { return [...sessions]; },
    async getSession(id) { return sessions.find((item) => item.id === id) || null; },
    async createSession(options: CreateSessionOptions) {
      creates += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const created = session(`${harness}-${creates}`, options.name, options.cwd, harness);
      sessions.push(created);
      return created;
    },
    async sendMessage(id, options) {
      deliveries.push({ id, options });
      return failDelivery ? { ok: false, error: "delivery failed" } : { ok: true };
    },
    async stopSession() { return { ok: true }; },
    async respondPermission() { return { ok: true }; },
    async setPermissions() { return { ok: true }; },
  };
  return {
    adapter,
    sessions,
    deliveries,
    creates: () => creates,
    failNextDelivery: () => { failDelivery = true; },
  };
}

describe("named session creation and reuse", () => {
  it("serializes find-or-create across two Agent Herder processes", async () => {
    const cwd = await workspace();
    const storePath = join(cwd, "sessions.json");
    const lockDir = join(cwd, "locks");
    await writeFile(storePath, "[]");
    const fixture = join(process.cwd(), "tests/fixtures/named-session-process.mjs");

    const run = (message: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(process.execPath, [fixture, storePath, cwd, message], {
        env: { ...process.env, AGENT_HERDER_LOCK_DIR: lockDir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== 0) return reject(new Error(`fixture exited ${code}: ${stderr}`));
        resolve(JSON.parse(stdout));
      });
    });

    const [first, second] = await Promise.all([run("disk 95%"), run("disk 96%")]);
    const sessions = JSON.parse(await readFile(storePath, "utf8"));
    expect(sessions).toHaveLength(1);
    expect(first.sessionId).toBe("session-1");
    expect(second.sessionId).toBe("session-1");
    expect([first.created, second.created].sort()).toEqual([false, true]);
  });

  it("keeps create_session and new_or_resume in the MCP contract", async () => {
    const cwd = await workspace();
    const fake = fakeAdapter("opencode");
    const adapters = new Map([["opencode", fake.adapter]]);
    expect(toolDefinitions.map((tool) => tool.name)).toEqual(expect.arrayContaining(["create_session", "new_or_resume"]));

    const created = JSON.parse(await handleCreateSession(adapters, { harness: "opencode", name: "manual_100", cwd }));
    const resumed = JSON.parse(await handleNewOrResume(adapters, {
      harness: "opencode",
      name: "manual_100",
      cwd,
      message: "continue",
      mode: "queue",
    }));
    expect(created).toMatchObject({ ok: true, created: true, sessionId: "opencode-1" });
    expect(resumed).toMatchObject({ ok: true, created: false, sessionId: "opencode-1", delivery: "accepted" });
  });

  it("rejects a relative CWD before adapter work", async () => {
    const fake = fakeAdapter("opencode");
    await expect(createNamedSession(new Map([["opencode", fake.adapter]]), {
      harness: "opencode",
      name: "repair_100",
      cwd: "relative/project",
    })).rejects.toThrow("cwd must be an absolute path");
    expect(fake.creates()).toBe(0);
  });

  it("releases the in-process queue when cross-process lock acquisition fails", async () => {
    const cwd = await workspace();
    const invalidLockRoot = join(cwd, "not-a-directory");
    await writeFile(invalidLockRoot, "file");
    const fake = fakeAdapter("opencode");
    const adapters = new Map([["opencode", fake.adapter]]);
    const previousLockDir = process.env.AGENT_HERDER_LOCK_DIR;
    try {
      process.env.AGENT_HERDER_LOCK_DIR = invalidLockRoot;
      await expect(createNamedSession(adapters, { harness: "opencode", name: "repair_100", cwd })).rejects.toThrow();

      process.env.AGENT_HERDER_LOCK_DIR = join(cwd, "valid-locks");
      await expect(createNamedSession(adapters, { harness: "opencode", name: "repair_100", cwd })).resolves.toMatchObject({
        ok: true,
        created: true,
        sessionId: "opencode-1",
      });
    } finally {
      if (previousLockDir === undefined) delete process.env.AGENT_HERDER_LOCK_DIR;
      else process.env.AGENT_HERDER_LOCK_DIR = previousLockDir;
    }
  });

  it("creates a named session with a canonical CWD", async () => {
    const cwd = await workspace();
    const fake = fakeAdapter("opencode");

    const result = await createNamedSession(new Map([["opencode", fake.adapter]]), {
      harness: "opencode",
      name: "repair_100",
      cwd,
    });

    expect(result).toEqual({ ok: true, created: true, sessionId: "opencode-1", harness: "opencode", name: "repair_100", cwd });
  });

  it("scopes native session discovery to the requested CWD before creating", async () => {
    const cwd = await workspace();
    const existing = session("existing", "repair_100", cwd);
    const fake = fakeAdapter("opencode", [existing]);
    const listRequests: Array<string | undefined> = [];
    const listAll = fake.adapter.listSessions.bind(fake.adapter);
    fake.adapter.listSessions = async (options?: { cwd?: string }) => {
      listRequests.push(options?.cwd);
      return options?.cwd === cwd ? listAll() : [];
    };

    const result = await newOrResumeNamedSession(new Map([["opencode", fake.adapter]]), {
      harness: "opencode",
      name: "repair_100",
      cwd,
      message: "disk 95%",
      mode: "queue",
    });

    expect(listRequests).toEqual([cwd]);
    expect(fake.creates()).toBe(0);
    expect(result).toMatchObject({ ok: true, created: false, sessionId: "existing", delivery: "accepted" });
  });

  it("serializes concurrent calls, creates once, and delivers every message", async () => {
    const cwd = await workspace();
    const fake = fakeAdapter("opencode");
    const adapters = new Map([["opencode", fake.adapter]]);

    const [first, second] = await Promise.all([
      newOrResumeNamedSession(adapters, { harness: "opencode", name: "repair_100", cwd, message: "disk 95%", mode: "queue" }),
      newOrResumeNamedSession(adapters, { harness: "opencode", name: "repair_100", cwd, message: "disk 96%", mode: "queue" }),
    ]);

    expect(fake.creates()).toBe(1);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first).toMatchObject({ ok: true, sessionId: "opencode-1", delivery: "accepted" });
    expect(second).toMatchObject({ ok: true, sessionId: "opencode-1", delivery: "accepted" });
    expect(fake.deliveries.map((item) => item.options.message).sort()).toEqual(["disk 95%", "disk 96%"]);
  });

  it("fails closed on duplicate exact identities before delivery", async () => {
    const cwd = await workspace();
    const fake = fakeAdapter("codex", [session("one", "repair_100", cwd, "codex"), session("two", "repair_100", cwd, "codex")]);

    const result = await newOrResumeNamedSession(new Map([["codex", fake.adapter]]), {
      harness: "codex",
      name: "repair_100",
      cwd,
      message: "disk full",
      mode: "sync",
    });

    expect(result).toMatchObject({ ok: false, created: false, delivery: "not_attempted" });
    expect(result.error).toContain("Ambiguous named session");
    expect(fake.deliveries).toHaveLength(0);
  });

  it("preserves the created session id when delivery fails", async () => {
    const cwd = await workspace();
    const fake = fakeAdapter("codex");
    fake.failNextDelivery();

    const result = await newOrResumeNamedSession(new Map([["codex", fake.adapter]]), {
      harness: "codex",
      name: "repair_100",
      cwd,
      message: "disk full",
      mode: "sync",
    });

    expect(result).toMatchObject({ ok: false, created: true, sessionId: "codex-1", delivery: "failed", error: "delivery failed" });
  });
  it("uses adapter exact-name lookup when available", async () => {
    const cwd = await workspace();
    const fake = fakeAdapter("codex");
    let listCalls = 0;
    let exactCalls = 0;
    fake.adapter.listSessions = async () => { listCalls += 1; return []; };
    fake.adapter.findNamedSessions = async (name, requestedCwd) => {
      exactCalls += 1;
      expect(name).toBe("repair_100");
      expect(requestedCwd).toBe(cwd);
      return [];
    };

    const result = await newOrResumeNamedSession(new Map([["codex", fake.adapter]]), {
      harness: "codex", name: "repair_100", cwd, message: "probe", mode: "queue",
    });

    expect(result).toMatchObject({ ok: true, created: true, delivery: "accepted" });
    expect(exactCalls).toBe(1);
    expect(listCalls).toBe(0);
  });

});
