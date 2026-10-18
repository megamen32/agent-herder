import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";

const COLLECTION = "agent_herder_sessions_v1";
const VECTOR_SIZE = 2048;
const MODEL = "qwen3-embedding:4b";
const QDRANT = process.env.AGENT_HERDER_QDRANT_URL || "http://127.0.0.1:6333";
const EMBEDDINGS = process.env.AGENT_HERDER_EMBEDDING_URL || "http://192.168.2.75:11440/v1/embeddings";
const STATE_PATH = process.env.AGENT_HERDER_RAG_STATE || join(homedir(), ".local/state/agent-herder/rag.json");
const TOKEN_PATH = process.env.AGENT_HERDER_EMBEDDING_TOKEN_FILE || join(homedir(), ".config/agent-herder/qwen-embedding.env");
const HARNESS_LABELS = { codex: "Codex", zcode: "ZCode", opencode: "OpenCode" } as const;
type Harness = keyof typeof HARNESS_LABELS;
type Options = { enabled: boolean; harnesses: Record<Harness, boolean> };
type Hit = { id: string; score: number; payload: Record<string, unknown> };
type Persisted = {
  options: Options;
  checkpoints: Record<string, number>;
  run?: { status: "running" | "complete" | "error" | "paused"; startedAt: string; updatedAt: string; current?: string; processed: number; indexed: number; error?: string };
};

const emptyOptions = (): Options => ({ enabled: false, harnesses: { codex: true, zcode: true, opencode: true } });
const emptyState = (): Persisted => ({ options: emptyOptions(), checkpoints: {} });
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";

function scrubSecrets(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[redacted]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s,;"']+/gi, "$1[redacted]");
}

function pointId(...parts: string[]): string {
  const bytes = createHash("sha256").update(parts.join("\0")).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function splitText(value: string): string[] {
  const cleaned = scrubSecrets(value).replace(/\u0000/g, " ").trim();
  if (!cleaned) return [];
  const chunks: string[] = [];
  const size = 1800;
  const overlap = 180;
  for (let start = 0; start < cleaned.length; start += size - overlap) {
    const chunk = cleaned.slice(start, start + size).trim();
    if (chunk.length >= 20) chunks.push(chunk);
  }
  return chunks;
}

async function requestJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`${new URL(url).pathname} returned HTTP ${response.status}`);
  return response.json();
}

async function embeddingToken(): Promise<string> {
  const envToken = process.env.AGENT_HERDER_EMBEDDING_TOKEN || process.env.QWEN_EMBEDDING_GATEWAY_TOKEN;
  if (envToken?.trim()) return envToken.trim();
  const env = await readFile(TOKEN_PATH, "utf8");
  const match = env.match(/^\s*(?:export\s+)?QWEN_EMBEDDING_GATEWAY_TOKEN\s*=\s*(['"]?)([^\r\n'"#]+)\1\s*(?:#.*)?$/m);
  if (!match?.[2]?.trim()) throw new Error("embedding gateway token is not configured");
  return match[2].trim();
}

async function embed(inputs: string[]): Promise<number[][]> {
  if (!inputs.length) return [];
  const token = await embeddingToken();
  const data = await requestJson(EMBEDDINGS, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: inputs, dimensions: VECTOR_SIZE }),
  });
  const vectors = Array.isArray(data?.data) ? data.data.map((row: any) => row.embedding) : [];
  if (vectors.length !== inputs.length || vectors.some((vector: unknown) => !Array.isArray(vector) || vector.length !== VECTOR_SIZE || vector.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n)))) {
    throw new Error("embedding gateway returned an unexpected vector shape");
  }
  return vectors as number[][];
}

async function ensureCollection(): Promise<void> {
  const response = await fetch(`${QDRANT}/collections/${COLLECTION}`, { signal: AbortSignal.timeout(5_000) });
  if (response.ok) {
    const current = await response.json();
    if (current?.result?.config?.params?.vectors?.size !== VECTOR_SIZE) throw new Error("Agent Herder Qdrant collection has an incompatible vector size");
    return;
  }
  if (response.status !== 404) throw new Error(`Qdrant returned HTTP ${response.status}`);
  await requestJson(`${QDRANT}/collections/${COLLECTION}`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ vectors: { size: VECTOR_SIZE, distance: "Cosine" } }),
  });
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 32_768) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

async function allFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  return files;
}

function dbOpen(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA query_only=ON; BEGIN");
  return db;
}

function dateText(value: unknown): string {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? new Date(number < 10_000_000_000 ? number * 1000 : number).toISOString() : "";
}

function messageTime(value: Record<string, unknown>, fallback: number): number {
  const raw = object(value.time);
  const stamp = typeof raw.created === "number" ? raw.created : typeof raw.updated === "number" ? raw.updated : typeof value.timestamp === "string" ? Date.parse(value.timestamp) : fallback;
  return Number.isFinite(stamp) ? (stamp < 10_000_000_000 ? stamp * 1000 : stamp) : fallback;
}

export class AgentHerderRag {
  private state?: Persisted;
  private loading?: Promise<Persisted>;
  private run?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private saveChain: Promise<void> = Promise.resolve();

  private async load(): Promise<Persisted> {
    if (this.state) return this.state;
    if (!this.loading) this.loading = (async () => {
      try { this.state = { ...emptyState(), ...object(JSON.parse(await readFile(STATE_PATH, "utf8"))) } as Persisted; }
      catch { this.state = emptyState(); }
      if (this.state.options.enabled) this.startIndex(false);
      return this.state;
    })();
    return this.loading;
  }

  private async save(): Promise<void> {
    const state = await this.load();
    const pending = this.saveChain.then(() => atomicJson(STATE_PATH, state));
    this.saveChain = pending.catch(() => {});
    await pending;
  }

  async getSettings(): Promise<Record<string, unknown>> {
    const state = await this.load();
    return { enabled: state.options.enabled, harnesses: state.options.harnesses, collection: COLLECTION, dimensions: VECTOR_SIZE, model: MODEL, run: state.run ?? { status: "idle", processed: 0, indexed: 0 } };
  }

  async setSettings(value: Record<string, unknown>): Promise<Record<string, unknown>> {
    const state = await this.load();
    const incoming = object(value.harnesses);
    const next: Options = {
      enabled: value.enabled === true,
      harnesses: {
        codex: incoming.codex === undefined ? state.options.harnesses.codex : incoming.codex === true,
        zcode: incoming.zcode === undefined ? state.options.harnesses.zcode : incoming.zcode === true,
        opencode: incoming.opencode === undefined ? state.options.harnesses.opencode : incoming.opencode === true,
      },
    };
    if (next.enabled) {
      await ensureCollection();
      await embed(["Agent Herder Qdrant opt in readiness check"]);
    }
    state.options = next;
    if (!next.enabled) {
      state.run = {
        status: "paused",
        startedAt: state.run?.startedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        processed: state.run?.processed || 0,
        indexed: state.run?.indexed || 0,
      };
    }
    await this.save();
    if (next.enabled) this.startIndex(Object.keys(state.checkpoints).length === 0);
    else if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    return this.getSettings();
  }

  async search(query: string, filters: { harnesses?: Harness[]; from?: string; to?: string; project?: string; limit?: number } = {}, resolveSession?: (harness: Harness, id: string) => Promise<{ title?: string; cwd?: string } | undefined>): Promise<Record<string, unknown>> {
    const state = await this.load();
    if (!state.options.enabled) throw new Error("semantic search is off; enable it in Agent Herder settings");
    const clean = scrubSecrets(query.trim()).slice(0, 1000);
    if (!clean) throw new Error("query is required");
    const [vector] = await embed([clean]);
    const must: unknown[] = [];
    const harnesses = (filters.harnesses ?? []).filter((item) => item in HARNESS_LABELS);
    if (harnesses.length) must.push({ key: "harness", match: { any: harnesses } });
    if (filters.project?.trim()) must.push({ key: "project", match: { value: filters.project.trim().slice(0, 256) } });
    const gte = filters.from ? Date.parse(filters.from) : NaN;
    const lte = filters.to ? Date.parse(filters.to) : NaN;
    if (Number.isFinite(gte) || Number.isFinite(lte)) must.push({ key: "timestamp_ms", range: { ...(Number.isFinite(gte) ? { gte } : {}), ...(Number.isFinite(lte) ? { lte: lte + 86_399_999 } : {}) } });
    const requestedLimit = Math.max(1, Math.min(50, filters.limit ?? 12));
    const data = await requestJson(`${QDRANT}/collections/${COLLECTION}/points/search`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ vector, limit: Math.min(100, requestedLimit * 10), with_payload: true, ...(must.length ? { filter: { must } } : {}) }),
    });
    const seen = new Set<string>();
    const results = (Array.isArray(data?.result) ? data.result : []).flatMap((hit: Hit) => {
      const key = `${hit.payload.harness}:${hit.payload.session_id}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ score: hit.score, ...hit.payload }];
    }).slice(0, requestedLimit);
    if (resolveSession) await Promise.all(results.map(async (hit: Record<string, any>) => {
      if (hit.harness !== "codex" || !String(hit.title || "").startsWith("rollout-")) return;
      const session = await resolveSession(hit.harness, String(hit.session_id)).catch(() => undefined);
      if (session?.title) hit.title = session.title;
      if (!hit.directory && session?.cwd) hit.directory = session.cwd;
    }));
    return { results, run: state.run ?? null };
  }

  private startIndex(reset: boolean): void {
    if (this.run) return;
    this.run = this.indexAll(reset).finally(() => {
      this.run = undefined;
      void this.load().then((state) => {
        if (state.options.enabled && state.run?.status === "complete") {
          this.timer = setTimeout(() => this.startIndex(false), 15 * 60_000);
          this.timer.unref?.();
        }
      });
    });
  }

  async reindex(): Promise<Record<string, unknown>> {
    const state = await this.load();
    if (!state.options.enabled) throw new Error("enable semantic indexing first");
    if (!this.run) this.startIndex(true);
    return this.getSettings();
  }

  private async updateRun(patch: Partial<NonNullable<Persisted["run"]>>): Promise<void> {
    const state = await this.load();
    const current = state.run ?? { status: "running" as const, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), processed: 0, indexed: 0 };
    state.run = { ...current, ...patch, updatedAt: new Date().toISOString() } as NonNullable<Persisted["run"]>;
    await this.save();
  }

  private async indexMessages(harness: Harness, session: { id: string; title?: string; directory?: string; project?: string; timestamp?: number }, messages: Array<{ id: string; role: string; text: string; timestamp?: number }>): Promise<number> {
    const points: Array<{ id: string; text: string; payload: Record<string, unknown> }> = [];
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      for (const [chunk, part] of splitText(message.text).entries()) {
        points.push({
          id: pointId(harness, session.id, message.id, String(chunk)), text: part,
          payload: {
            harness, session_id: session.id, message_id: message.id, role: message.role,
            title: session.title || session.id, directory: session.directory || "", project: session.project || "",
            timestamp_ms: message.timestamp || session.timestamp || 0, timestamp: dateText(message.timestamp || session.timestamp),
            text: part, chunk_index: chunk,
          },
        });
      }
    }
    let indexed = 0;
    for (let offset = 0; offset < points.length; offset += 8) {
      if (!this.state?.options.enabled) break;
      const batch = points.slice(offset, offset + 8);
      const vectors = await embed(batch.map((point) => point.text));
      await requestJson(`${QDRANT}/collections/${COLLECTION}/points?wait=true`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ points: batch.map((point, index) => ({ id: point.id, vector: vectors[index], payload: point.payload })) }),
      });
      indexed += batch.length;
      await this.updateRun({ indexed: (this.state?.run?.indexed ?? 0) + batch.length });
    }
    return indexed;
  }

  private async indexCodex(state: Persisted): Promise<void> {
    const root = join(process.env.CODEX_HOME || homedir() + "/.codex", "sessions");
    const files = (await Promise.all((await allFiles(root)).map(async (path) => ({ path, mtime: (await stat(path).catch(() => undefined))?.mtimeMs || 0 })))).sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    for (const file of files) {
      if (!state.options.enabled) return;
      const path = file.path;
      const info = await stat(path).catch(() => undefined);
      if (!info) continue;
      const messages: Array<{ id: string; role: string; text: string; timestamp?: number }> = [];
      const fileSessionId = basename(path).replace(/\.jsonl$/, "").match(/[0-9a-f-]{36}$/i)?.[0] || basename(path).replace(/\.jsonl$/, "");
      if (info.mtimeMs <= (state.checkpoints[`codex:${fileSessionId}`] || 0)) continue;
      await requestJson(`${QDRANT}/collections/${COLLECTION}/points/delete?wait=true`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filter: { must: [{ key: "harness", match: { value: "codex" } }, { key: "session_id", match: { value: fileSessionId } }] } }) });
      const input = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
      let sessionId = basename(path).replace(/\.jsonl$/, "");
      let title = sessionId;
      let index = 0;
      for await (const line of input) {
        if (!line.trim()) continue;
        let record: any;
        try { record = JSON.parse(line); } catch { continue; }
        const payload = object(record.payload);
        if (record.type === "session_meta") {
          sessionId = text(payload.session_id) || sessionId;
          title = text(payload.title) || title;
        }
        if (record.type !== "response_item" || payload.type !== "message" || !["user", "assistant"].includes(text(payload.role))) continue;
        const content = Array.isArray(payload.content) ? payload.content : [];
        const body = content.map((part: unknown) => text(object(part).text)).filter(Boolean).join("\n");
        if (!body) continue;
        if (title === sessionId && text(payload.role) === "user") title = scrubSecrets(body).replace(/\s+/g, " ").slice(0, 88);
        messages.push({ id: `line-${index++}`, role: text(payload.role), text: body, timestamp: Date.parse(text(record.timestamp)) || info.mtimeMs });
        if (messages.length >= 24) {
          await this.indexMessages("codex", { id: sessionId, title, directory: "", timestamp: info.mtimeMs }, messages);
          messages.length = 0;
        }
      }
      if (messages.length) {
        await this.indexMessages("codex", { id: sessionId, title, directory: "", timestamp: info.mtimeMs }, messages);
      }
      state.checkpoints[`codex:${fileSessionId}`] = info.mtimeMs;
      await this.updateRun({ processed: (this.state?.run?.processed ?? 0) + 1 });
    }
  }

  private async indexSqlite(harness: "zcode" | "opencode", path: string, state: Persisted): Promise<void> {
    const db = dbOpen(path);
    try {
      const sessions = db.prepare("SELECT id,title,directory,time_created,time_updated FROM session ORDER BY time_updated DESC,id").all() as Array<Record<string, unknown>>;
      for (const row of sessions) {
        if (!state.options.enabled) return;
        const id = text(row.id);
        const updated = Number(row.time_updated) || Number(row.time_created) || Date.now();
        if (!id) continue;
        if (updated <= (state.checkpoints[`${harness}:${id}`] || 0)) continue;
        const records = db.prepare("SELECT m.id,m.data AS message_data,m.time_created,m.time_updated,p.data AS part_data FROM message m LEFT JOIN part p ON p.message_id=m.id AND p.session_id=m.session_id WHERE m.session_id=? ORDER BY m.time_created,p.time_created,p.id").all(id) as Array<Record<string, unknown>>;
        const byMessage = new Map<string, { role: string; text: string[]; timestamp: number }>();
        for (const record of records) {
          let message = object(byMessage.get(text(record.id)));
          if (!byMessage.has(text(record.id))) {
            let data: Record<string, unknown> = {};
            try { data = object(JSON.parse(text(record.message_data))); } catch { /* skip malformed native row */ }
            message = { role: text(data.role), text: [], timestamp: Number(record.time_created) || Number(record.time_updated) || updated };
            byMessage.set(text(record.id), message as { role: string; text: string[]; timestamp: number });
          }
          let part: Record<string, unknown> = {};
          try { part = object(JSON.parse(text(record.part_data))); } catch { /* no text part */ }
          if (part.type === "text" && typeof part.text === "string") byMessage.get(text(record.id))!.text.push(part.text);
        }
        const messages = [...byMessage].map(([messageId, value]) => ({ id: messageId, role: value.role, text: value.text.join("\n"), timestamp: value.timestamp }));
        await requestJson(`${QDRANT}/collections/${COLLECTION}/points/delete?wait=true`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filter: { must: [{ key: "harness", match: { value: harness } }, { key: "session_id", match: { value: id } }] } }) });
        await this.indexMessages(harness, { id, title: text(row.title), directory: text(row.directory), project: text(row.directory), timestamp: Number(row.time_created) || updated }, messages);
        state.checkpoints[`${harness}:${id}`] = updated;
        await this.updateRun({ processed: (this.state?.run?.processed ?? 0) + 1 });
      }
    } finally { db.close(); }
  }

  private async indexAll(reset: boolean): Promise<void> {
    const state = await this.load();
    if (!state.options.enabled) return;
    try {
      await ensureCollection();
      if (reset) state.checkpoints = {};
      state.run = { status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), processed: 0, indexed: 0 };
      await this.save();
      const sources: Array<Promise<void>> = [];
      const active = (Object.keys(HARNESS_LABELS) as Harness[]).filter((harness) => state.options.harnesses[harness]);
      if (active.length) await this.updateRun({ current: active.map((harness) => HARNESS_LABELS[harness]).join(" + ") });
      if (state.options.harnesses.codex) sources.push(this.indexCodex(state));
      if (state.options.harnesses.zcode) sources.push(this.indexSqlite("zcode", process.env.ZCODE_DB_PATH || join(homedir(), ".zcode/cli/db/db.sqlite"), state));
      if (state.options.harnesses.opencode) sources.push(this.indexSqlite("opencode", process.env.OPENCODE_DB_PATH || join(homedir(), ".local/share/opencode/opencode.db"), state));
      const outcomes = await Promise.allSettled(sources);
      const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      if (failure) throw failure.reason;
      if (!state.options.enabled) throw new Error("indexing paused because opt-in was turned off");
      state.run = { status: "complete", startedAt: state.run?.startedAt || new Date().toISOString(), updatedAt: new Date().toISOString(), processed: state.run?.processed || 0, indexed: state.run?.indexed || 0 };
      await this.save();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!state.options.enabled) {
        state.run = { status: "paused", startedAt: state.run?.startedAt || new Date().toISOString(), updatedAt: new Date().toISOString(), processed: state.run?.processed || 0, indexed: state.run?.indexed || 0 };
        await this.save();
        return;
      }
      state.run = { status: "error", startedAt: state.run?.startedAt || new Date().toISOString(), updatedAt: new Date().toISOString(), processed: state.run?.processed || 0, indexed: state.run?.indexed || 0, error: message.slice(0, 400) };
      await this.save().catch(() => {});
    }
  }

  async handleHttp(request: IncomingMessage, response: ServerResponse, resolveSession?: (harness: Harness, id: string) => Promise<{ title?: string; cwd?: string } | undefined>): Promise<boolean> {
    const url = new URL(request.url || "/", "http://localhost");
    if (!url.pathname.startsWith("/api/rag/")) return false;
    try {
      if (url.pathname === "/api/rag/settings" && request.method === "GET") return void send(response, 200, await this.getSettings()), true;
      if (url.pathname === "/api/rag/settings" && request.method === "PUT") return void send(response, 200, await this.setSettings(await readBody(request))), true;
      if (url.pathname === "/api/rag/index" && request.method === "POST") return void send(response, 202, await this.reindex()), true;
      if (url.pathname === "/api/rag/index" && request.method === "DELETE") {
        const state = await this.load();
        state.options.enabled = false;
        if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
        const result = await fetch(`${QDRANT}/collections/${COLLECTION}`, { method: "DELETE", signal: AbortSignal.timeout(10_000) });
        if (!result.ok && result.status !== 404) throw new Error(`Qdrant returned HTTP ${result.status}`);
        state.checkpoints = {};
        state.run = { status: "paused", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), processed: 0, indexed: 0 };
        await this.save();
        return void send(response, 200, await this.getSettings()), true;
      }
      if (url.pathname === "/api/rag/search" && request.method === "POST") {
        const body = await readBody(request);
        const harnesses = Array.isArray(body.harnesses) ? body.harnesses.filter((item): item is Harness => typeof item === "string" && item in HARNESS_LABELS) : undefined;
        return void send(response, 200, await this.search(text(body.query), { harnesses, from: text(body.from), to: text(body.to), project: text(body.project), limit: Number(body.limit) || 12 }, resolveSession)), true;
      }
      return void send(response, 404, { error: "not_found" }), true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "search failed";
      const status = /off|enable/i.test(message) ? 409 : /required|too large/i.test(message) ? 400 : 502;
      return void send(response, status, { error: message.slice(0, 400) }), true;
    }
  }
}

let singleton: AgentHerderRag | undefined;
export function agentHerderRag(): AgentHerderRag {
  return singleton ??= new AgentHerderRag();
}
