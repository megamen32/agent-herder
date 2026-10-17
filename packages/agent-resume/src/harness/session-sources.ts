import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { SessionCandidate } from "./marker-search.js";

/**
 * Where candidate sessions come from.
 *
 * Each harness keeps its own store; the core knows how to read them so that
 * marker search answers for every supported harness from one implementation.
 */
export interface SessionSource {
  readonly agent: string;
  list(options: { cwd?: string | null; limit: number; marker?: string | null }): Promise<SessionCandidate[]>;
}

/** Codex threads: its own SQLite state, with the rollout transcript for bodies. */
export function codexSessionSource(options: { home?: string; stateDb?: string; indexFile?: string } = {}): SessionSource {
  const home = options.home ?? homedir();
  const dbPath = options.stateDb ?? join(home, ".codex/state_5.sqlite");
  const indexPath = options.indexFile ?? join(home, ".codex/session_index.jsonl");
  return {
    agent: "codex",
    async list({ cwd, limit, marker }: { cwd?: string | null; limit: number; marker?: string | null }) {
      const candidates: SessionCandidate[] = [];
      if (existsSync(dbPath)) {
        const rows = await readCodexThreads(dbPath, cwd);
        for (const row of rows) {
          const searchable = marker && row.rolloutPath ? await scanRolloutForMarker(row.rolloutPath, marker) : [];
          candidates.push({
            agent: "codex",
            sessionId: row.id,
            cwd: row.cwd ?? null,
            title: row.title ?? row.preview ?? null,
            updated: row.updatedAtMs ?? null,
            source: "codex-state",
            searchableText: searchable,
            extra: { model: row.model ?? null, rollout_path: row.rolloutPath ?? null },
          });
          if (candidates.length >= 200) break;
        }
      }
      if (!existsSync(dbPath) || candidates.length === 0) {
        // The index has titles but no bodies, so a marker cannot match here.
        for (const record of await readSessionIndex(indexPath)) {
          if (cwd && record.cwd && record.cwd !== cwd) continue;
          candidates.push({
            agent: "codex",
            sessionId: record.id,
            cwd: record.cwd ?? null,
            title: record.title ?? null,
            updated: record.updatedAt ?? null,
            source: "codex-index",
            searchableText: [],
          });
          if (candidates.length >= 200) break;
        }
      }
      return candidates.slice(0, limit);
    },
  };
}

interface CodexThreadRow {
  id: string;
  cwd?: string | null;
  title?: string | null;
  preview?: string | null;
  updatedAtMs?: number | null;
  rolloutPath?: string | null;
  model?: string | null;
}

async function readCodexThreads(dbPath: string, cwd: string | null | undefined): Promise<CodexThreadRow[]> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const available = new Set((database.prepare("pragma table_info(threads)").all() as Array<{ name: string }>).map((column) => column.name));
      if (!available.has("id")) return [];
      const select = (name: string, fallback = "NULL") => (available.has(name) ? name : `${fallback} AS ${name}`);
      const statement = database.prepare(
        `select ${select("id")}, ${select("cwd")}, ${select("title")}, ${select("preview")}, ${select("updated_at_ms")}, ${select("rollout_path")}, ${select("model")}` +
        ` from threads where ${available.has("archived") ? "archived=0" : "1=1"} order by ${available.has("updated_at_ms") ? "updated_at_ms desc" : "rowid desc"} limit 500`,
      );
      const rows = statement.all() as Array<Record<string, unknown>>;
      return rows
        .filter((row) => !cwd || !row.cwd || row.cwd === cwd)
        .map((row) => ({
          id: String(row.id ?? ""),
          cwd: (row.cwd as string | null) ?? null,
          title: (row.title as string | null) ?? null,
          preview: (row.preview as string | null) ?? null,
          updatedAtMs: typeof row.updated_at_ms === "number" ? row.updated_at_ms : null,
          rolloutPath: (row.rollout_path as string | null) ?? null,
          model: (row.model as string | null) ?? null,
        }))
        .filter((row) => row.id.length > 0);
    } finally {
      database.close();
    }
  } catch {
    // A missing or locked Codex store must not break session search.
    return [];
  }
}

async function readSessionIndex(indexPath: string): Promise<Array<{ id: string; title?: string | null; cwd?: string | null; updatedAt?: number | null }>> {
  if (!existsSync(indexPath)) return [];
  const records: Array<{ id: string; title?: string | null; cwd?: string | null; updatedAt?: number | null }> = [];
  try {
    const text = await readFile(indexPath, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        const id = String(record.id ?? record.thread_id ?? "");
        if (!id) continue;
        records.push({
          id,
          title: (record.title as string | null) ?? null,
          cwd: (record.cwd as string | null) ?? null,
          updatedAt: typeof record.updated_at === "number" ? record.updated_at : null,
        });
      } catch { /* a damaged index line is skipped */ }
    }
  } catch { /* unreadable index yields no candidates */ }
  return records;
}

/** Stream a rollout transcript and collect the assistant lines that carry the marker. */
async function scanRolloutForMarker(path: string, marker: string, limit = 2): Promise<string[]> {
  const hits: string[] = [];
  try {
    const stream = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes(marker)) continue;
      try {
        const item = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> };
        const text = String(item.payload?.text ?? item.payload?.content ?? "");
        if (text.includes(marker)) hits.push(text.slice(0, 500));
      } catch { /* the marker can sit in an opaque line */ }
      if (hits.length >= limit) break;
    }
    lines.close();
    stream.destroy();
  } catch { /* an unreadable transcript simply cannot match */ }
  return hits;
}

/** Claude transcripts: one JSONL per session under a hyphenated project directory. */
export function claudeSessionSource(options: { home?: string; projectsRoot?: string } = {}): SessionSource {
  const home = options.home ?? homedir();
  const projectsRoot = options.projectsRoot ?? join(home, ".claude/projects");
  return {
    agent: "claude",
    async list({ cwd, limit, marker }: { cwd?: string | null; limit: number; marker?: string | null }) {
      const roots = cwd ? [join(projectsRoot, cwd.replaceAll("/", "-"))] : [];
      if (roots.length === 0) return [];
      const candidates: SessionCandidate[] = [];
      for (const root of roots) {
        if (!existsSync(root)) continue;
        const { readdirSync, statSync } = await import("node:fs");
        let entries: string[] = [];
        try {
          entries = readdirSync(root).filter((name) => name.endsWith(".jsonl"));
        } catch { continue; }
        const ordered = entries
          .map((name) => {
            try { return { name, mtimeMs: statSync(join(root, name)).mtimeMs }; } catch { return null; }
          })
          .filter((value): value is { name: string; mtimeMs: number } => value !== null)
          .sort((left, right) => right.mtimeMs - left.mtimeMs)
          .slice(0, 200);
        for (const entry of ordered) {
          const path = join(root, entry.name);
          const searchable = marker ? await scanClaudeForMarker(path, marker) : [];
          const first = searchable[0] ?? await readFirstUserLine(path);
          candidates.push({
            agent: "claude",
            sessionId: entry.name.replace(/\.jsonl$/, ""),
            cwd,
            title: first?.slice(0, 120) ?? null,
            updated: entry.mtimeMs,
            source: "claude-transcript",
            searchableText: searchable,
          });
          if (candidates.length >= limit) break;
        }
      }
      return candidates;
    },
  };
}

async function scanClaudeForMarker(path: string, marker: string, limit = 2): Promise<string[]> {
  const hits: string[] = [];
  try {
    const stream = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes(marker)) continue;
      try {
        const item = JSON.parse(line) as { message?: { role?: string; content?: unknown } };
        const message = item.message ?? {};
        if (message.role !== "assistant") continue;
        const texts: string[] = [];
        if (typeof message.content === "string") texts.push(message.content);
        else if (Array.isArray(message.content)) {
          for (const part of message.content as Array<{ type?: string; text?: string }>) {
            if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
          }
        }
        for (const text of texts) if (text.includes(marker)) hits.push(text.slice(0, 500));
      } catch { /* damaged transcript line */ }
      if (hits.length >= limit) break;
    }
    lines.close();
    stream.destroy();
  } catch { /* unreadable transcript cannot match */ }
  return hits;
}

async function readFirstUserLine(path: string): Promise<string | null> {
  try {
    const stream = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      try {
        const item = JSON.parse(line) as { message?: { role?: string; content?: unknown } };
        if (item.message?.role !== "user") continue;
        const content = item.message.content;
        if (typeof content === "string") { lines.close(); stream.destroy(); return content.slice(0, 500); }
        if (Array.isArray(content)) {
          const text = (content as Array<{ type?: string; text?: string }>).find((part) => part?.type === "text")?.text;
          if (text) { lines.close(); stream.destroy(); return text.slice(0, 500); }
        }
      } catch { /* keep scanning */ }
    }
    lines.close();
    stream.destroy();
  } catch { /* unreadable transcript has no title */ }
  return null;
}