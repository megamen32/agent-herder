import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveAutopilotStateDir } from "./autopilot/state-dir.js";

/** A short SQLite write transaction serializes MCP transports and processes. */
export function coordinatorTransaction<T>(run: (db: DatabaseSync) => T): T {
  const dir = join(resolveAutopilotStateDir(), "coordinator");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dir, "project.sqlite"));
  try {
    db.exec(`PRAGMA busy_timeout=3000;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS citation_receipts(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS memory(project TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workers(project TEXT, harness TEXT, session TEXT, title TEXT, state TEXT, prs TEXT DEFAULT '[]', PRIMARY KEY(project,harness,session));
      CREATE TABLE IF NOT EXISTS reactions(project TEXT,harness TEXT,session TEXT,message TEXT,actor TEXT,reaction TEXT,PRIMARY KEY(project,harness,session,message,actor));
      CREATE TABLE IF NOT EXISTS presence(project TEXT PRIMARY KEY, quietUntil INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS updates(project TEXT,id TEXT,body TEXT,batch TEXT,PRIMARY KEY(project,id));`);
    const result = run(db);
    db.exec("COMMIT");
    return result;
  } finally { db.close(); }
}

export function trackWorker(project: string, harness: string, session: string, title: string) {
  coordinatorTransaction(db => db.prepare("INSERT OR IGNORE INTO workers(project,harness,session,title,state) VALUES(?,?,?,?,'working')")
    .run(project, harness, session, title));
}
