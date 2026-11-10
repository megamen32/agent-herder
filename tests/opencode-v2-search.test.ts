import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { scanSessionSearchSources } from "../src/session-search-sources.js";

it("indexes native OpenCode v2 messages and detects edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "herder-search-opencode-v2-"));
  for (const key of ["CODEX_HOME", "MINIMAX_CODE_SESSION_STORE", "ZCODE_DB_PATH", "HERMES_STATE_DB", "CLAUDE_PROJECTS_DIR", "AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT"]) vi.stubEnv(key, join(root, key));
  const path = join(root, "opencode.db"); vi.stubEnv("OPENCODE_DB_PATH", path);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE session_v2(id,title,directory,time_updated); CREATE TABLE session_message(id,session_id,type,seq,time_created,time_updated,data); INSERT INTO session_v2 VALUES('s1','fixture','/work',1)");
  db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?,?,?)").run("m1", "s1", "user", 1, 1, 1, JSON.stringify({ text: "first message" }));
  const scan = async () => {
    const statuses: any[] = []; const found: any[] = [];
    for await (const session of scanSessionSearchSources({ onStatus: status => statuses.push(status) })) {
      const chunks = []; for await (const chunk of session.chunks) chunks.push(chunk);
      if (session.harness === "opencode") found.push({ session, chunks });
    }
    return { status: statuses.find(x => x.harness === "opencode"), found };
  };
  try {
    const before = await scan();
    expect(before.status).toMatchObject({ state: "complete" });
    expect(before.found[0]).toMatchObject({ session: { nativeSessionId: "s1" }, chunks: [{ text: "first message" }] });
    db.prepare("UPDATE session_message SET data=? WHERE id=?").run(JSON.stringify({ text: "other message" }), "m1");
    // An in-place data edit that bumps no envelope column is served from the
    // index-only change key: the cheap scan keeps the previous revision.
    const cheap = await scan();
    expect(cheap.found[0].session.revision).toBe(before.found[0].session.revision);
    // The periodic resync rehash bounds how long such an edit may stay
    // unnoticed; with the resync interval forced to every scan it is detected.
    vi.stubEnv("AGENT_HERDER_SESSION_SEARCH_RESYNC_SCANS", "1");
    const after = await scan();
    expect(after.found[0].session.revision).not.toBe(before.found[0].session.revision);
    expect(after.found[0].chunks[0].text).toBe("other message");
    vi.unstubAllEnvs();
    // A harness-maintained change key (new message) is detected immediately.
    db.exec("INSERT INTO session_message VALUES('m2','s1','user',2,2,2,'{\"text\":\"second message\"}')");
    vi.stubEnv("AGENT_HERDER_SESSION_SEARCH_RESYNC_SCANS", "60");
    vi.stubEnv("OPENCODE_DB_PATH", path);
    for (const key of ["CODEX_HOME", "MINIMAX_CODE_SESSION_STORE", "ZCODE_DB_PATH", "HERMES_STATE_DB", "CLAUDE_PROJECTS_DIR", "AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT"]) vi.stubEnv(key, join(root, key));
    const appended = await scan();
    expect(appended.found[0].session.revision).not.toBe(after.found[0].session.revision);
    expect(appended.found[0].chunks.map(chunk => chunk.text)).toEqual(["other message", "second message"]);
  } finally { db.close(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});

it("accepts a stable database when only file permissions change during a scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "herder-search-metadata-"));
  for (const key of ["CODEX_HOME", "MINIMAX_CODE_SESSION_STORE", "ZCODE_DB_PATH", "HERMES_STATE_DB", "CLAUDE_PROJECTS_DIR", "AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT"]) vi.stubEnv(key, join(root, key));
  const path = join(root, "opencode.db"); vi.stubEnv("OPENCODE_DB_PATH", path);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE session_v2(id,title,directory,time_updated); CREATE TABLE session_message(id,session_id,type,seq,time_created,time_updated,data); INSERT INTO session_v2 VALUES('s1','fixture','/work',1); INSERT INTO session_message VALUES('m1','s1','user',1,1,1,'{\"text\":\"hello\"}')");
  db.close();
  try {
    const statuses: any[] = [];
    for await (const session of scanSessionSearchSources({ onStatus: status => statuses.push(status) })) {
      if (session.harness === "opencode") await chmod(path, 0o600);
      for await (const _ of session.chunks) { /* consume the snapshot */ }
    }
    expect(statuses.find(x => x.harness === "opencode")).toMatchObject({ state: "complete" });
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});

it("finds the v2 database in the configured XDG data directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "herder-search-xdg-"));
  for (const key of ["CODEX_HOME", "MINIMAX_CODE_SESSION_STORE", "ZCODE_DB_PATH", "HERMES_STATE_DB", "CLAUDE_PROJECTS_DIR", "AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT"]) vi.stubEnv(key, join(root, key));
  vi.stubEnv("HOME", root); vi.stubEnv("OPENCODE_DB_PATH", ""); vi.stubEnv("XDG_DATA_HOME", root);
  await mkdir(join(root, "opencode"));
  const path = join(root, "opencode", "opencode.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE session_v2(id,title,directory,time_updated); CREATE TABLE session_message(id,session_id,type,seq,time_created,time_updated,data); INSERT INTO session_v2 VALUES('xdg-session','fixture','/work',1)");
  db.close();
  try {
    const statuses: any[] = []; const ids: string[] = [];
    for await (const session of scanSessionSearchSources({ onStatus: status => statuses.push(status) })) {
      if (session.harness === "opencode") ids.push(session.nativeSessionId);
      for await (const _ of session.chunks) { /* consume the stable snapshot */ }
    }
    expect(statuses.find(x => x.harness === "opencode")).toMatchObject({ state: "complete", source: path });
    expect(ids).toContain("xdg-session");
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});
