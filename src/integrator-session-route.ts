import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname } from "node:os";
import type { HarnessAdapter } from "./types/index.js";
import { createRawTranscriptPageReader, readIntegratorTranscriptPage, type NativeTranscriptPageReader, type TranscriptSessionScope } from "./integrator-transcript.js";
import { createZcodeTranscriptReader } from "./zcode-transcript-reader.js";
import { createZaiTranscriptReader } from "./zai-transcript-reader.js";
import { createChatgptTranscriptReader } from "./chatgpt-transcript-reader.js";
import { createOpencodeTranscriptReader } from "./opencode-transcript-reader.js";

const MAX_READERS_PER_ADAPTER = 64;
const readersByAdapter = new WeakMap<HarnessAdapter, Map<string, NativeTranscriptPageReader>>();

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function exactParam(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded.length <= 1024 && !/[\x00-\x1f\x7f]/u.test(decoded) ? decoded : null;
  } catch { return null; }
}

function readerFor(adapter: HarnessAdapter, harness: string, sessionId: string): NativeTranscriptPageReader {
  const scope = { hostId: hostname(), harness, nativeSessionId: sessionId };
  let readers = readersByAdapter.get(adapter);
  if (!readers) { readers = new Map(); readersByAdapter.set(adapter, readers); }
  const key = JSON.stringify([scope.hostId, scope.harness, scope.nativeSessionId]);
  const existing = readers.get(key);
  if (existing) {
    readers.delete(key);
    readers.set(key, existing);
    return existing;
  }
  if (!adapter.getRawTranscript) throw new Error("This native adapter does not expose a complete transcript export");
  const getRawTranscript = (id: string) => adapter.getRawTranscript!(id);
  const reader = harness === "zcode" ? createZcodeTranscriptReader({ scope, getRawTranscript })
    : harness === "opencode" ? createOpencodeTranscriptReader({ scope, getRawTranscript })
    : harness === "chatgpt" ? createChatgptTranscriptReader({ scope, getRawTranscript })
    : harness === "zai" ? createZaiTranscriptReader({ scope, getRawTranscript })
    : createRawTranscriptPageReader({ scope, getRawTranscript });
  while (readers.size >= MAX_READERS_PER_ADAPTER) readers.delete(readers.keys().next().value!);
  readers.set(key, reader);
  return reader;
}

async function readLatestCodexPage(adapter: HarnessAdapter, scope: TranscriptSessionScope, limit: number, cursor?: string) {
  const page = await adapter.getCodexHistoryPage!(scope.nativeSessionId, limit, cursor);
  if (!page) throw new Error("Codex history is unavailable");
  const rows = "events" in page ? page.events : page.data;
  const nextCursor = page.nextCursor ?? null;
  if (!Array.isArray(rows) || rows.length > limit || (nextCursor !== null && (
    typeof nextCursor !== "string" || !nextCursor || nextCursor.length > 4096 || nextCursor === cursor || !rows.length))) {
    throw new Error("Invalid Codex history page");
  }
  const envelope = { scope, order: "latest", nextCursor, complete: nextCursor === null };
  if ("events" in page) return { ...envelope, events: page.events, source: "codex-rollout" };
  if (page.data.some(row => !row || typeof row.turnId !== "string" || !row.turnId ||
    typeof row.item?.id !== "string" || !row.item.id || typeof row.item.type !== "string" || !row.item.type)) {
    throw new Error("Invalid native Codex history item");
  }
  // The chat exposes only the public reasoning summary recorded by Codex.
  const items = page.data.map(row => row.item.type === "reasoning"
    ? { ...row, item: { type: row.item.type, id: row.item.id, summary: row.item.summary } }
    : row);
  return { ...envelope, items, source: "codex-app-server" };
}

/** Handle the process-local paged history endpoint for an exact existing native session. */
export async function handleIntegratorSessionTranscript(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  adapters: Map<string, HarnessAdapter>,
): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/transcript$/u);
  if (!match || request.method !== "GET") return false;
  const harness = exactParam(match[1]);
  const sessionId = exactParam(match[2]);
  if (!harness || !sessionId) { sendJson(response, 400, { error: "Invalid exact session path" }); return true; }
  const adapter = adapters.get(harness);
  if (!adapter || adapter.type !== harness) { sendJson(response, 404, { error: "Native session adapter not found" }); return true; }
  const order = url.searchParams.get("order");
  if (order !== null && (order !== "latest" || harness !== "codex")) {
    sendJson(response, 400, { error: "Unsupported transcript order" }); return true;
  }
  const latest = order === "latest";
  if (latest && !adapter.getCodexHistoryPage) { sendJson(response, 501, { error: "Codex history paging unavailable" }); return true; }
  if (!latest && !adapter.getRawTranscript) { sendJson(response, 501, { error: "Native adapter does not expose a supported complete transcript export" }); return true; }
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? (latest ? 100 : 50) : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (rawLimit !== null && !/^\d+$/u.test(rawLimit))) {
    sendJson(response, 400, { error: "limit must be an integer from 1 to 100" }); return true;
  }
  const cursor = url.searchParams.has("cursor") ? url.searchParams.get("cursor")! : undefined;
  if (latest && cursor !== undefined && (!cursor || cursor.length > 4096)) {
    sendJson(response, 400, { error: "Invalid history cursor" }); return true;
  }
  const scope = { hostId: hostname(), harness, nativeSessionId: sessionId };
  try {
    const session = latest ? await adapter.getSession(sessionId, { includeMetrics: false }) : await adapter.getSession(sessionId);
    if (!session || session.id !== sessionId || session.harness !== harness) { sendJson(response, 404, { error: "Exact native session not found" }); return true; }
    const page = latest
      ? await readLatestCodexPage(adapter, scope, limit, cursor)
      : await readIntegratorTranscriptPage({scope, cursor, limit, reader: readerFor(adapter, harness, sessionId)});
    sendJson(response, 200, {
      session: { id: session.id, harness: session.harness, status: session.status, lastActivity: session.lastActivity },
      transcript: page,
      steerEndpoint: `/api/sessions/${encodeURIComponent(harness)}/${encodeURIComponent(sessionId)}/message`,
    });
  } catch (error) {
    sendJson(response, 422, { error: error instanceof Error ? error.message : "Transcript export unavailable" });
  }
  return true;
}
