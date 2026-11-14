import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, chmod, lstat, link, rename, symlink, copyFile, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scanSessionSearchSources, type SearchSourceStatus } from "../src/session-search-sources.js";

const fault = vi.hoisted(() => ({ path: "", field: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    const value = await fs.lstat(...args);
    if (String(args[0]) !== fault.path || !fault.field) return value;
    if (fault.field === "error") throw Object.assign(new Error("denied"), { code: "EACCES" });
    return Object.assign(Object.create(Object.getPrototypeOf(value)), value,
      { [fault.field]: Number(value[fault.field as "uid" | "gid"]) + 1 });
  } };
});

const roots: string[] = [];
const writers: DatabaseSync[] = [];
afterEach(async () => {
  fault.path = ""; fault.field = "";
  for (const db of writers.splice(0)) db.close();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type Fixture = { path: string; wal: string; harness: "zcode" | "hermes" };
async function fixture(harness: Fixture["harness"] = "zcode", walState: "empty" | "absent" | "nonempty" = "empty"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "herder-zcode-wal-")); roots.push(root);
  for (const name of ["CODEX_HOME", "MINIMAX_CODE_SESSION_STORE", "OPENCODE_DB_PATH",
    "ZCODE_DB_PATH", "HERMES_STATE_DB", "CLAUDE_PROJECTS_DIR", "AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT"])
    vi.stubEnv(name, join(root, "absent-" + name));
  const path = join(root, "native.sqlite"), wal = path + "-wal";
  vi.stubEnv(harness === "zcode" ? "ZCODE_DB_PATH" : "HERMES_STATE_DB", path);
  const db = new DatabaseSync(path); db.exec("PRAGMA journal_mode=WAL");
  if (harness === "zcode") {
    db.exec("CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,directory TEXT,time_updated INTEGER);"
      + "CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);"
      + "CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);"
      + "CREATE INDEX message_session ON message(session_id,time_created,id);"
      + "CREATE INDEX part_session ON part(session_id,message_id,time_created,id);"
      + "INSERT INTO session VALUES('session-one','Fixture','/work',1);");
    for (let n = 1; n <= 2; n++) {
      db.prepare("INSERT INTO message VALUES(?,?,?,?)").run("m" + n, "session-one", n, JSON.stringify({ role: "user" }));
      db.prepare("INSERT INTO part VALUES(?,?,?,?,?)").run("p" + n, "session-one", "m" + n, n, JSON.stringify({ text: "needle-" + n }));
    }
  } else {
    db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,cwd TEXT);"
      + "CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,content TEXT,timestamp REAL);"
      + "CREATE INDEX messages_session ON messages(session_id,timestamp);"
      + "INSERT INTO sessions VALUES('session-one','Fixture','/work');"
      + "INSERT INTO messages VALUES(1,'session-one','needle-1',1),(2,'session-one','needle-2',2);");
  }
  if (walState === "nonempty") writers.push(db);
  else {
    db.close();
    if (walState === "empty") {
      const reader = new DatabaseSync(path, { readOnly: true });
      try { reader.prepare("SELECT count(*) FROM " + (harness === "zcode" ? "session" : "sessions")).get(); }
      finally { reader.close(); }
      expect((await lstat(wal)).size).toBe(0);
      // An exact whole-second mtime also isolates inode-only replacement tests.
      await utimes(wal, 1_700_000_000, 1_700_000_000);
    }
  }
  return { path, wal, harness };
}

async function scan(f: Fixture, mutate: () => Promise<void> = async () => {}) {
  const statuses: SearchSourceStatus[] = [], chunks: string[] = [];
  let changed = false;
  for await (const session of scanSessionSearchSources({ onStatus: status => statuses.push(status) })) {
    for await (const chunk of session.chunks) if (session.harness === f.harness) chunks.push(chunk.text);
    if (!changed && session.harness === f.harness) {
      changed = true; await delay(5); await mutate();
    }
  }
  expect(changed).toBe(true);
  return { status: statuses.find(status => status.harness === f.harness), chunks };
}

async function touchCtime(path: string) {
  const before = await lstat(path); await chmod(path, before.mode & 0o7777);
}
function mainStamp(value: Awaited<ReturnType<typeof lstat>>) {
  return [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs];
}
function expectPartial(result: Awaited<ReturnType<typeof scan>>) {
  expect(result.status).toMatchObject({ state: "partial", reason: "native_source_changed_during_scan" });
}

describe("ZCode same empty WAL ctime observation", () => {
  it("accepts only ctime drift while preserving complete native text and the main DB", async () => {
    const f = await fixture(), mainBefore = await lstat(f.path), walBefore = await lstat(f.wal);
    const result = await scan(f, () => touchCtime(f.wal));
    const mainAfter = await lstat(f.path), walAfter = await lstat(f.wal);
    expect(result.status).toMatchObject({ state: "complete", sessions: 1, chunks: 2 });
    expect(result.chunks).toEqual(["needle-1", "needle-2"]);
    expect(mainStamp(mainAfter)).toEqual(mainStamp(mainBefore));
    for (const key of ["dev", "ino", "size", "mtimeMs", "mode", "uid", "gid", "nlink"] as const)
      expect(walAfter[key]).toBe(walBefore[key]);
    expect(walAfter.ctimeMs).not.toBe(walBefore.ctimeMs);
  });

  it("keeps main DB metadata changes partial even when its bytes need not change", async () => {
    const f = await fixture(); expectPartial(await scan(f, () => touchCtime(f.path)));
  });

  it("keeps a byte-identical replacement main DB partial", async () => {
    const f = await fixture();
    expectPartial(await scan(f, async () => {
      await rename(f.path, f.path + ".original"); await copyFile(f.path + ".original", f.path);
    }));
  });

  it("keeps a real native content commit partial", async () => {
    const f = await fixture();
    expectPartial(await scan(f, async () => {
      const writer = new DatabaseSync(f.path);
      try { writer.prepare("UPDATE part SET data=? WHERE id='p1'").run(JSON.stringify({ text: "changed-native-text" })); }
      finally { writer.close(); }
    }));
  });

  it("keeps changed WAL mtime partial", async () => {
    const f = await fixture();
    expectPartial(await scan(f, () => utimes(f.wal, 1_700_000_000, 1_700_000_001)));
  });

  it("keeps changed WAL permissions partial", async () => {
    const f = await fixture();
    expectPartial(await scan(f, async () => {
      const mode = (await lstat(f.wal)).mode & 0o7777; await chmod(f.wal, mode ^ 0o040);
    }));
  });

  it.each(["uid", "gid", "error"])("requires unchanged observed WAL %s without privileged filesystem mutation", async field => {
    const f = await fixture();
    expectPartial(await scan(f, async () => {
      await touchCtime(f.wal); fault.path = f.wal; fault.field = field;
    }));
  });

  it("keeps a replacement empty WAL partial even with the original mtime", async () => {
    const f = await fixture(), before = await lstat(f.wal);
    expectPartial(await scan(f, async () => {
      await rename(f.wal, f.wal + ".original"); await writeFile(f.wal, "");
      await utimes(f.wal, 1_700_000_000, 1_700_000_000);
    }));
    expect((await lstat(f.wal)).ino).not.toBe(before.ino);
    expect((await lstat(f.wal)).mtimeMs).toBe(before.mtimeMs);
  });

  it("keeps WAL hard-link changes partial", async () => {
    const f = await fixture();
    expectPartial(await scan(f, () => link(f.wal, f.wal + ".alias")));
  });

  it("refuses a symlink replacing the WAL path even when it points to the same inode", async () => {
    const f = await fixture();
    expectPartial(await scan(f, async () => {
      await rename(f.wal, f.wal + ".original"); await symlink(f.wal + ".original", f.wal);
      await touchCtime(f.wal + ".original");
    }));
  });

  it("does not treat a disappearing empty WAL as ctime drift", async () => {
    const f = await fixture(); expectPartial(await scan(f, () => unlink(f.wal)));
  });

  it("does not extend the exception to first-open WAL creation", async () => {
    const f = await fixture("zcode", "absent"); expectPartial(await scan(f));
  });

  it("does not accept ctime drift on a nonempty WAL", async () => {
    const f = await fixture("zcode", "nonempty"); expect((await lstat(f.wal)).size).toBeGreaterThan(0);
    expectPartial(await scan(f, () => touchCtime(f.wal)));
  });

  it("does not extend the exception to Hermes", async () => {
    const f = await fixture("hermes"); expectPartial(await scan(f, () => touchCtime(f.wal)));
  });
});
