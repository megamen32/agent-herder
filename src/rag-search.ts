import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { backgroundIndexingSettings, type BackgroundIndexingSettings } from "./indexing-settings.js";

const COLLECTION = "agent_herder_sessions_v1";
const VECTOR_SIZE = 2048;
const MODEL = "qwen3-embedding:4b";
const QDRANT = process.env.AGENT_HERDER_QDRANT_URL || "http://127.0.0.1:6333";
const EMBEDDINGS = process.env.AGENT_HERDER_EMBEDDING_URL || "http://192.168.2.75:11440/v1/embeddings";
const STATE_PATH = process.env.AGENT_HERDER_RAG_STATE || join(homedir(), ".local/state/agent-herder/rag.json");
const TOKEN_PATH = process.env.AGENT_HERDER_EMBEDDING_TOKEN_FILE || join(homedir(), ".config/agent-herder/qwen-embedding.env");
const HARNESS_LABELS = { codex: "Codex", zcode: "ZCode", opencode: "OpenCode" } as const;
type Harness = keyof typeof HARNESS_LABELS;
type SearchFilters = { harnesses?: Harness[]; from?: string; to?: string; project?: string; limit?: number; mode?: "hybrid" | "exact" | "semantic" };
type Options = { enabled: boolean; harnesses: Record<Harness, boolean> };
type Hit = { id: string; score: number; payload: Record<string, unknown> };
type SearchProgress =
  | { type: "phase"; stage: "exact" | "semantic" }
  | { type: "results"; source: "exact" | "semantic"; results: Array<Record<string, unknown>>; elapsedMs: number }
  | { type: "complete"; exactMs?: number; semanticMs?: number; totalMs: number }
  | { type: "error"; message: string };
type Persisted = {
  options: Options;
  checkpoints: Record<string, number>;
  run?: { status: "running" | "complete" | "error" | "paused"; startedAt: string; updatedAt: string; current?: string; processed: number; indexed: number; error?: string };
};

const emptyOptions = (): Options => ({ enabled: false, harnesses: { codex: true, zcode: true, opencode: true } });
const emptyState = (): Persisted => ({ options: emptyOptions(), checkpoints: {} });
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const searchMode = (value: unknown): SearchFilters["mode"] => value === "exact" || value === "semantic" ? value : "hybrid";

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
  const response = await fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000) });
  if (!response.ok) {
    const detail = scrubSecrets((await response.text().catch(() => "")).replace(/\s+/g, " ").trim()).slice(0, 300);
    throw new Error(`${new URL(url).pathname} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
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

async function embed(inputs: string[], signal?: AbortSignal): Promise<number[][]> {
  if (!inputs.length) return [];
  const token = await embeddingToken();
  const data = await requestJson(EMBEDDINGS, {
    ...(signal ? { signal } : {}),
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

async function ensureCollection(signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${QDRANT}/collections/${COLLECTION}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000) });
  if (response.ok) {
    const current = await response.json();
    if (current?.result?.config?.params?.vectors?.size !== VECTOR_SIZE) throw new Error("Agent Herder Qdrant collection has an incompatible vector size");
    return;
  }
  if (response.status !== 404) throw new Error(`Qdrant returned HTTP ${response.status}`);
  await requestJson(`${QDRANT}/collections/${COLLECTION}`, {
    ...(signal ? { signal } : {}),
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

async function allFiles(root: string, check: () => void = () => {}): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length) {
    check();
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
  private indexAbort?: AbortController;
  constructor(private readonly indexing: BackgroundIndexingSettings = backgroundIndexingSettings()) {
    indexing.subscribe(async enabled => {
      if (!enabled) {
        this.indexAbort?.abort();
        if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
        await this.run;
      } else if (this.state?.options.enabled) this.startIndex(false);
    });
  }
  private assertIndexing(): void {
    this.indexAbort?.signal.throwIfAborted();
    if (!this.indexing.get().enabled || this.state?.options.enabled === false) throw new Error("background indexing paused");
  }
  private async indexRequest(url: string, init: RequestInit): Promise<any> {
    this.assertIndexing();
    return requestJson(url, { ...init, signal: this.indexAbort?.signal });
  }
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
    const backgroundIndexing = this.indexing.get().enabled;
    return { enabled: state.options.enabled, backgroundIndexing, harnesses: state.options.harnesses, collection: COLLECTION, dimensions: VECTOR_SIZE, model: MODEL, run: !backgroundIndexing ? { ...state.run, status: "paused", processed: state.run?.processed ?? 0, indexed: state.run?.indexed ?? 0 } : state.run ?? { status: "idle", processed: 0, indexed: 0 } };
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
    if (next.enabled && this.indexing.get().enabled) {
      await ensureCollection();
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

  async searchProgressively(
    query: string,
    filters: SearchFilters = {},
    onProgress: (progress: SearchProgress) => void | Promise<void> = () => {},
    resolveSession?: (harness: Harness, id: string) => Promise<{ title?: string; cwd?: string } | undefined>,
    listCodexSessions?: () => Promise<Array<{ id: string; title?: string; cwd?: string; lastMessage?: string }>>,
  ): Promise<Record<string, unknown>> {
    const state = await this.load();
    if (!state.options.enabled) throw new Error("semantic search is off; enable it in Agent Herder settings");
    const clean = scrubSecrets(query.trim()).slice(0, 1000);
    if (!clean) throw new Error("query is required");
    const must: unknown[] = [];
    const harnesses = (filters.harnesses ?? []).filter((item) => item in HARNESS_LABELS);
    if (harnesses.length) must.push({ key: "harness", match: { any: harnesses } });
    if (filters.project?.trim()) must.push({ key: "project", match: { value: filters.project.trim().slice(0, 256) } });
    const gte = filters.from ? Date.parse(filters.from) : NaN;
    const lte = filters.to ? Date.parse(filters.to) : NaN;
    if (Number.isFinite(gte) || Number.isFinite(lte)) must.push({ key: "timestamp_ms", range: { ...(Number.isFinite(gte) ? { gte } : {}), ...(Number.isFinite(lte) ? { lte: lte + 86_399_999 } : {}) } });
    const requestedLimit = Math.max(1, Math.min(50, filters.limit ?? 12));

    const startedAt = Date.now();
    if (filters.mode !== "semantic") await onProgress({ type: "phase", stage: "exact" });
    const exactStartedAt = Date.now();
    let searchError: string | undefined;
    let exactData: any;
    try {
      if (filters.mode !== "semantic") {
      exactData = await requestJson(`${QDRANT}/collections/${COLLECTION}/points/scroll`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          limit: Math.min(200, Math.max(50, requestedLimit * 10)),
          with_payload: true,
          filter: { must: [...must, { key: "text", match: { text: clean } }] },
        }),
      });
      }
    } catch (error) {
      searchError = error instanceof Error ? error.message : String(error);
    }
    const seen = new Set<string>();
    const exactResults = (Array.isArray(exactData?.result?.points) ? exactData.result.points : []).flatMap((hit: Hit) => {
      const payload = object(hit.payload);
      const harness = text(payload.harness);
      const sessionId = text(payload.session_id);
      if (!harness || !sessionId || seen.has(`${harness}:${sessionId}`)) return [];
      seen.add(`${harness}:${sessionId}`);
      return [{ score: 1, ...payload, source: "exact" }];
    }).slice(0, requestedLimit);
    if (resolveSession) await Promise.all(exactResults.map(async (hit: Record<string, any>) => {
      if (hit.harness !== "codex" || !String(hit.title || "").startsWith("rollout-")) return;
      const session = await resolveSession(hit.harness, String(hit.session_id)).catch(() => undefined);
      if (session?.title) hit.title = session.title;
      if (!hit.directory && session?.cwd) hit.directory = session.cwd;
    }));
    const exactMs = Date.now() - exactStartedAt;
    if (filters.mode !== "semantic") await onProgress({ type: "results", source: "exact", results: exactResults, elapsedMs: exactMs });

    if (filters.mode !== "exact") await onProgress({ type: "phase", stage: "semantic" });
    const semanticStartedAt = Date.now();
    let data: any;
    try {
      if (filters.mode !== "exact") {
      const [vector] = await embed([clean]);
      data = await requestJson(`${QDRANT}/collections/${COLLECTION}/points/search`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ vector, limit: Math.min(100, requestedLimit * 10), with_payload: true, ...(must.length ? { filter: { must } } : {}) }),
      });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      searchError = searchError ? `${searchError}; ${detail}` : detail;
    }
    const semanticSeen = new Set<string>();
    const semanticResults = (Array.isArray(data?.result) ? data.result : []).flatMap((hit: Hit) => {
      const payload = object(hit.payload);
      const key = `${payload.harness}:${payload.session_id}`;
      if (!payload.harness || !payload.session_id || semanticSeen.has(key)) return [];
      semanticSeen.add(key);
      return [{ score: hit.score, ...payload, source: "semantic" }];
    }).slice(0, requestedLimit);
    if (resolveSession) await Promise.all(semanticResults.map(async (hit: Record<string, any>) => {
      if (hit.harness !== "codex" || !String(hit.title || "").startsWith("rollout-")) return;
      const session = await resolveSession(hit.harness, String(hit.session_id)).catch(() => undefined);
      if (session?.title) hit.title = session.title;
      if (!hit.directory && session?.cwd) hit.directory = session.cwd;
    }));
    const semanticMs = Date.now() - semanticStartedAt;
    if (filters.mode !== "exact") await onProgress({ type: "results", source: "semantic", results: semanticResults, elapsedMs: semanticMs });
    if (searchError) await onProgress({ type: "error", message: searchError.slice(0, 400) });
    const timings = { ...(filters.mode !== "semantic" ? { exactMs } : {}), ...(filters.mode !== "exact" ? { semanticMs } : {}), totalMs: Date.now() - startedAt };
    await onProgress({ type: "complete", ...timings });
    const result: Record<string, unknown> = { results: [...exactResults, ...semanticResults], mode: filters.mode ?? "hybrid", coverage: { scope: "local-index", fleetComplete: false, note: "Only opted-in history indexed on this Herder host is searched; missing results do not prove a session does not exist on other hosts." }, run: state.run ?? null, timings };
    if (searchError) {
      result.searchError = searchError;
      if (listCodexSessions && (!harnesses.length || harnesses.includes("codex"))) {
        try {
          const terms = clean.toLocaleLowerCase().split(/\s+/).filter((term) => term.length >= 2);
          const candidates = (await listCodexSessions()).map((session) => {
            const haystack = `${session.id} ${session.title || ""} ${session.cwd || ""} ${session.lastMessage || ""}`.toLocaleLowerCase();
            return { ...session, matchCount: terms.filter((term) => haystack.includes(term)).length };
          }).filter((session) => session.matchCount > 0)
            .sort((a, b) => b.matchCount - a.matchCount || a.id.localeCompare(b.id))
            .slice(0, Math.min(20, requestedLimit));
          result.fallback = { source: "codex-session-list", candidates };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          result.fallback = { source: "codex-session-list", error: detail.slice(0, 300), candidates: [] };
        }
      }
    }
    return result;
  }

  async search(query: string, filters: SearchFilters = {}, resolveSession?: (harness: Harness, id: string) => Promise<{ title?: string; cwd?: string } | undefined>, listCodexSessions?: () => Promise<Array<{ id: string; title?: string; cwd?: string; lastMessage?: string }>>): Promise<Record<string, unknown>> {
    return this.searchProgressively(query, filters, () => {}, resolveSession, listCodexSessions);
  }

  private startIndex(reset: boolean): void {
    if (this.run || !this.indexing.get().enabled) return;
    this.indexAbort = new AbortController();
    this.run = this.indexAll(reset).finally(() => {
      this.run = undefined;
      void this.load().then((state) => {
        if (this.indexing.get().enabled && state.options.enabled && state.run?.status === "complete") {
          this.timer = setTimeout(() => this.startIndex(false), 15 * 60_000);
          this.timer.unref?.();
        }
      });
    });
  }

  async reindex(): Promise<Record<string, unknown>> {
    if (!this.indexing.get().enabled) throw new Error("background indexing paused; saved history remains searchable");
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
    const batchSize = 16;
    for (let offset = 0; offset < points.length; offset += batchSize) {
      this.assertIndexing();
      const batch = points.slice(offset, offset + batchSize);
      const vectors = await embed(batch.map((point) => point.text), this.indexAbort?.signal);
      await this.indexRequest(`${QDRANT}/collections/${COLLECTION}/points?wait=true`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ points: batch.map((point, index) => ({ id: point.id, vector: vectors[index], payload: point.payload })) }),
      });
      indexed += batch.length;
      await this.updateRun({ indexed: (this.state?.run?.indexed ?? 0) + batch.length });
    }
    return indexed;
  }

  private async indexCodex(state: Persisted): Promise<void> {
    this.assertIndexing();
    const root = join(process.env.CODEX_HOME || homedir() + "/.codex", "sessions");
    const files = (await Promise.all((await allFiles(root, () => this.assertIndexing())).map(async (path) => ({ path, mtime: (await stat(path).catch(() => undefined))?.mtimeMs || 0 })))).sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
    for (const file of files) {
      this.assertIndexing();
      const path = file.path;
      const info = await stat(path).catch(() => undefined);
      if (!info) continue;
      const messages: Array<{ id: string; role: string; text: string; timestamp?: number }> = [];
      const fileSessionId = basename(path).replace(/\.jsonl$/, "").match(/[0-9a-f-]{36}$/i)?.[0] || basename(path).replace(/\.jsonl$/, "");
      const checkpointKey = `codex-native-v2:${fileSessionId}`;
      if (info.mtimeMs <= (state.checkpoints[checkpointKey] || 0)) continue;
      let nativeSessionId = fileSessionId;
      let legacySessionId: string | undefined;
      const metadataStream = createReadStream(path, { encoding: "utf8" });
      const metadataInput = createInterface({ input: metadataStream, crlfDelay: Infinity });
      try {
        for await (const line of metadataInput) {
          this.assertIndexing();
          let record: any;
          try { record = JSON.parse(line); } catch { continue; }
          if (record.type !== "session_meta") continue;
          nativeSessionId = text(record.payload?.id) || text(record.payload?.session_id) || fileSessionId;
          legacySessionId = text(record.payload?.session_id) || undefined;
          break;
        }
      } finally { metadataInput.close(); metadataStream.destroy(); }
      const aliases = [...new Set([fileSessionId, nativeSessionId, legacySessionId, basename(path).replace(/\.jsonl$/, "")].filter((id): id is string => Boolean(id)))];
      // Older versions indexed current Codex rollouts under their full filename.
      // Invalidate their checkpoint and remove both aliases before native-id upsert.
      await this.indexRequest(`${QDRANT}/collections/${COLLECTION}/points/delete?wait=true`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filter: { must: [{ key: "harness", match: { value: "codex" } }, { key: "session_id", match: { any: aliases } }] } }) });
      const stream = createReadStream(path, { encoding: "utf8" });
      const input = createInterface({ input: stream, crlfDelay: Infinity });
      let sessionId = fileSessionId;
      let sessionDirectory = "";
      let title = sessionId;
      let index = 0;
      try { for await (const line of input) {
        this.assertIndexing();
        if (!line.trim()) continue;
        let record: any;
        try { record = JSON.parse(line); } catch { continue; }
        const payload = object(record.payload);
        if (record.type === "session_meta") {
          sessionId = text(payload.id) || text(payload.session_id) || sessionId;
          sessionDirectory = text(payload.cwd);
          title = text(payload.title) || title;
        }
        if (record.type !== "response_item" || payload.type !== "message" || !["user", "assistant"].includes(text(payload.role))) continue;
        const content = Array.isArray(payload.content) ? payload.content : [];
        const body = content.map((part: unknown) => text(object(part).text)).filter(Boolean).join("\n");
        if (!body) continue;
        if (title === sessionId && text(payload.role) === "user") title = scrubSecrets(body).replace(/\s+/g, " ").slice(0, 88);
        messages.push({ id: `line-${index++}`, role: text(payload.role), text: body, timestamp: Date.parse(text(record.timestamp)) || info.mtimeMs });
        if (messages.length >= 24) {
          await this.indexMessages("codex", { id: sessionId, title, directory: sessionDirectory, project: sessionDirectory, timestamp: info.mtimeMs }, messages);
          messages.length = 0;
        }
      }
      } finally { input.close(); stream.destroy(); }
      if (messages.length) {
        await this.indexMessages("codex", { id: sessionId, title, directory: sessionDirectory, project: sessionDirectory, timestamp: info.mtimeMs }, messages);
      }
      this.assertIndexing();
      state.checkpoints[checkpointKey] = info.mtimeMs;
      await this.updateRun({ processed: (this.state?.run?.processed ?? 0) + 1 });
    }
  }

  private async indexSqlite(harness: "zcode" | "opencode", path: string, state: Persisted): Promise<void> {
    this.assertIndexing();
    const db = dbOpen(path);
    try {
      const sessions = db.prepare("SELECT id,title,directory,time_created,time_updated FROM session ORDER BY time_updated DESC,id").all() as Array<Record<string, unknown>>;
      for (const row of sessions) {
        this.assertIndexing();
        const id = text(row.id);
        const updated = Number(row.time_updated) || Number(row.time_created) || Date.now();
        if (!id) continue;
        if (updated <= (state.checkpoints[`${harness}:${id}`] || 0)) continue;
        const messageRows = db.prepare(`
          SELECT m.id, json_extract(m.data, '$.role') AS role, m.time_created, m.time_updated
          FROM message m
          WHERE m.session_id=?
            AND CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') IN ('user','assistant') ELSE 0 END
          ORDER BY m.time_created,m.id
        `).iterate(id) as Iterable<Record<string, unknown>>;
        const partRows = db.prepare(`
          SELECT json_extract(data, '$.text') AS part_text
          FROM part INDEXED BY part_message_id_id_idx
          WHERE message_id=? AND session_id=?
            AND CASE WHEN substr(data,1,64) GLOB '{"type":"text"*'
              THEN CASE WHEN json_valid(data) THEN typeof(json_extract(data, '$.text'))='text' ELSE 0 END
              ELSE 0 END
          ORDER BY time_created,id
        `);
        await this.indexRequest(`${QDRANT}/collections/${COLLECTION}/points/delete?wait=true`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filter: { must: [{ key: "harness", match: { value: harness } }, { key: "session_id", match: { value: id } }] } }) });
        const session = { id, title: text(row.title), directory: text(row.directory), project: text(row.directory), timestamp: Number(row.time_created) || updated };
        let messages: Array<{ id: string; role: string; text: string; timestamp: number }> = [];
        let current: { id: string; role: string; text: string[]; timestamp: number } | undefined;
        let visitedParts = 0;
        const flush = async (): Promise<void> => {
          if (!messages.length) return;
          await this.indexMessages(harness, session, messages);
          messages = [];
        };
        const finishMessage = (): void => {
          if (!current) return;
          const body = current.text.join("\n");
          if (body) messages.push({ id: current.id, role: current.role, text: body, timestamp: current.timestamp });
          current = undefined;
        };
        for (const record of messageRows) {
          this.assertIndexing();
          const messageId = text(record.id);
          current = { id: messageId, role: text(record.role), text: [], timestamp: Number(record.time_created) || Number(record.time_updated) || updated };
          for (const part of partRows.iterate(messageId, id) as Iterable<Record<string, unknown>>) {
            this.assertIndexing();
            if (++visitedParts % 128 === 0) await yieldEventLoop();
            current.text.push(text(part.part_text));
          }
          finishMessage();
          if (messages.length >= 24) await flush();
        }
        await flush();
        this.assertIndexing();
        state.checkpoints[`${harness}:${id}`] = updated;
        await this.updateRun({ processed: (this.state?.run?.processed ?? 0) + 1 });
      }
    } finally { db.close(); }
  }

  private async indexAll(reset: boolean): Promise<void> {
    const state = await this.load();
    if (!state.options.enabled || !this.indexing.get().enabled) return;
    try {
      this.assertIndexing();
      await ensureCollection(this.indexAbort?.signal);
      this.assertIndexing();
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
      this.assertIndexing();
      state.run = { status: "complete", startedAt: state.run?.startedAt || new Date().toISOString(), updatedAt: new Date().toISOString(), processed: state.run?.processed || 0, indexed: state.run?.indexed || 0 };
      await this.save();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!state.options.enabled || !this.indexing.get().enabled || this.indexAbort?.signal.aborted) {
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
        return void send(response, 200, await this.search(text(body.query), { harnesses, from: text(body.from), to: text(body.to), project: text(body.project), limit: Number(body.limit) || 12, mode: searchMode(body.mode) }, resolveSession)), true;
      }
      if (url.pathname === "/api/rag/search/stream" && request.method === "POST") {
        const body = await readBody(request);
        const harnesses = Array.isArray(body.harnesses) ? body.harnesses.filter((item): item is Harness => typeof item === "string" && item in HARNESS_LABELS) : undefined;
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        response.flushHeaders();
        const emit = (progress: SearchProgress): void => {
          if (!response.destroyed) response.write(`data: ${JSON.stringify(progress)}\n\n`);
        };
        try {
          await this.searchProgressively(text(body.query), { harnesses, from: text(body.from), to: text(body.to), project: text(body.project), limit: Number(body.limit) || 12, mode: searchMode(body.mode) }, emit, resolveSession);
        } catch (error) {
          const message = error instanceof Error ? error.message : "search failed";
          emit({ type: "error", message: message.slice(0, 400) });
        }
        response.end();
        return true;
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
