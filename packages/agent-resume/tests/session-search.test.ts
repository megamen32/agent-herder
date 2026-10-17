import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { searchSessions } from "../src/harness/search.js";
import type { HarnessClient } from "../src/harness/client.js";

// Focused integration: marker search across real-shaped stores.
// Expected <2s/max 20s. One temporary Codex SQLite, one Claude transcript
// directory and one stub OpenCode client; no harness and no provider.
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "herder-search-"));
  const codexDir = join(home, ".codex");
  mkdirSync(codexDir, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(codexDir, "state_5.sqlite"));
  db.exec("create table threads (id text, cwd text, title text, preview text, updated_at_ms integer, rollout_path text, model text, archived integer)");
  const rollout = join(codexDir, "rollout.jsonl");
  writeFileSync(rollout, [
    JSON.stringify({ type: "message", payload: { role: "assistant", text: "Marker: A7kQ2 — нач��а разбор" } }),
    JSON.stringify({ type: "message", payload: { role: "assistant", text: "обычный текст" } }),
  ].join("\n"), "utf8");
  db.prepare("insert into threads values (?,?,?,?,?,?,?,?)").run("th_1", "/work/app", "Codex thread", "preview", 5_000, rollout, "gpt-6.1-sol", 0);
  db.prepare("insert into threads values (?,?,?,?,?,?,?,?)").run("th_2", "/work/other", "Unrelated", "preview", 9_000, null, "gpt-6.1-sol", 0);
  db.close();

  const claudeProject = join(home, ".claude/projects", "-work-app");
  mkdirSync(claudeProject, { recursive: true });
  writeFileSync(join(claudeProject, "sess-claude.jsonl"), [
    JSON.stringify({ message: { role: "user", content: "начать" } }),
    JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "Marker: A7kQ2 в ответе" }] } }),
  ].join("\n"), "utf8");

  const opencode: HarnessClient = {
    kind: "opencode",
    async init() {},
    async listSessions() {
      return [
        { id: "ses_hit", harness: "opencode", title: "OpenCode chat", cwd: "/work/app", lastActivity: new Date(7_000).toISOString() },
        { id: "ses_other", harness: "opencode", title: "Another", cwd: "/work/app", lastActivity: new Date(8_000).toISOString() },
      ];
    },
    async getMessages(id) {
      return id === "ses_hit"
        ? [{ id: "m1", role: "assistant", text: "Marker: A7kQ2 отработал", parts: [] }]
        : [{ id: "m2", role: "assistant", text: "ничего", parts: [] }];
    },
    async send() { return { ok: true }; },
    async waitForIdle() {},
    async interrupt() { return { ok: true }; },
    async listModels() { return []; },
  };
  return { home, opencode };
}

it("finds the session that carries the marker, in every supported store", async () => {
  const { home, opencode } = await fixture();
  const sources = await import("../src/harness/session-sources.js");
  const deps = { sources: [sources.codexSessionSource({ home }), sources.claudeSessionSource({ home })], clients: [opencode] };

  const codex = await searchSessions(deps, { agent: "codex", cwd: "/work/app", marker: "A7kQ2" });
  expect(codex.map((item) => item.sessionId)).toEqual(["th_1"]);

  const claude = await searchSessions(deps, { agent: "claude", cwd: "/work/app", marker: "A7kQ2" });
  expect(claude.map((item) => item.sessionId)).toEqual(["sess-claude"]);

  const opencodeHits = await searchSessions(deps, { agent: "opencode", cwd: "/work/app", marker: "A7kQ2" });
  expect(opencodeHits.map((item) => item.sessionId)).toEqual(["ses_hit"]);
}, 20_000);

it("returns the newest sessions when no marker is given", async () => {
  const { home, opencode } = await fixture();
  const sources = await import("../src/harness/session-sources.js");
  const deps = { sources: [sources.codexSessionSource({ home })], clients: [opencode] };
  const all = await searchSessions(deps, { limit: 10 });
  expect(all.length).toBeGreaterThan(0);
  expect(all.every((item) => item.sessionId)).toBe(true);
});

it("refuses a malformed marker instead of searching everything", async () => {
  const { home, opencode } = await fixture();
  const sources = await import("../src/harness/session-sources.js");
  const deps = { sources: [sources.codexSessionSource({ home })], clients: [opencode] };
  await expect(searchSessions(deps, { marker: "nope" })).rejects.toThrow(/5 ASCII alphanumeric/);
});

it("keeps answering when one store is unreadable", async () => {
  const { opencode } = await fixture();
  const broken = {
    agent: "codex",
    async list(): Promise<never> { throw new Error("store locked"); },
  };
  const out = await searchSessions({ sources: [broken], clients: [opencode] }, { cwd: "/work/app", limit: 5 });
  expect(out.map((item) => item.sessionId)).toEqual(["ses_other", "ses_hit"]);
});