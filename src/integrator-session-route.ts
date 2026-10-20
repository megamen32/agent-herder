import type { IncomingMessage, ServerResponse } from "node:http";
import { hostname } from "node:os";
import type { HarnessAdapter } from "./types/index.js";
import { createRawTranscriptPageReader, readIntegratorTranscriptPage, type NativeTranscriptPageReader } from "./integrator-transcript.js";

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
  const reader = createRawTranscriptPageReader({ scope, getRawTranscript: (id) => adapter.getRawTranscript!(id) });
  while (readers.size >= MAX_READERS_PER_ADAPTER) readers.delete(readers.keys().next().value!);
  readers.set(key, reader);
  return reader;
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
  if (!adapter.getRawTranscript) { sendJson(response, 501, { error: "Native adapter does not expose a supported complete transcript export" }); return true; }
  const session = await adapter.getSession(sessionId);
  if (!session || session.id !== sessionId || session.harness !== harness) { sendJson(response, 404, { error: "Exact native session not found" }); return true; }
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (rawLimit !== null && !/^\d+$/u.test(rawLimit))) {
    sendJson(response, 400, { error: "limit must be an integer from 1 to 100" }); return true;
  }
  const cursor = url.searchParams.has("cursor") ? url.searchParams.get("cursor")! : undefined;
  try {
    const page = await readIntegratorTranscriptPage({
      scope: { hostId: hostname(), harness, nativeSessionId: sessionId },
      ...(cursor === undefined ? {} : { cursor }),
      limit,
      reader: readerFor(adapter, harness, sessionId),
    });
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
