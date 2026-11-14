import { isAbsolute } from "node:path";
import type { ListSessionsOptions, RawTranscriptExport } from "./types/common.js";

/** Optional reads are advertised only when the selected legacy adapter has them. */
export interface LegacyReadPort {
  listSessions?(options?: ListSessionsOptions): Promise<unknown>;
  getRawTranscript?(id: string): Promise<RawTranscriptExport | null>;
  listProjects?(): Promise<unknown>;
}
export const LEGACY_READ_METHODS = ["listSessions", "getRawTranscript", "listProjects"] as const;
export function legacyReadMethods(adapter: LegacyReadPort): string[] {
  return LEGACY_READ_METHODS.filter(method => typeof adapter[method] === "function");
}
/** The AHAP frame budget. A native page that cannot fit it must not be framed. */
export const AHAP_FRAME_BUDGET_BYTES = 4 * 1024 * 1024;
/** Identity fields every native session row carries; bulk preview stays optional. */
const AHAP_SESSION_IDENTITY_FIELDS = ["id", "harness", "status", "title", "cwd", "lastActivity", "hostId", "model", "needsPermission"] as const;
const AHAP_SESSION_TEXT_LIMIT = 4096;

function frameBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function projectIdentity(row: unknown): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const source = row as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const field of AHAP_SESSION_IDENTITY_FIELDS) {
    const value = source[field];
    if (value === undefined) continue;
    projected[field] = typeof value === "string" ? value.slice(0, AHAP_SESSION_TEXT_LIMIT) : value;
  }
  return projected;
}

/**
 * A native session page is an observation, not transcript bytes. Keep the
 * requested row count and stay inside the AHAP frame budget: an unbounded
 * enumeration must never fail the whole read, and a row that does not fit is
 * reduced to its identity instead of being invented or dropped silently.
 */
export function boundSessionRows(rows: unknown, options?: ListSessionsOptions): unknown {
  if (!Array.isArray(rows)) return rows;
  const limit = options?.limit;
  const bounded = limit !== undefined && rows.length > limit ? rows.slice(0, limit) : rows;
  if (frameBytes(bounded) <= AHAP_FRAME_BUDGET_BYTES) return bounded;
  const projected = bounded.map(projectIdentity);
  if (frameBytes(projected) <= AHAP_FRAME_BUDGET_BYTES) return projected;
  throw new AhapReadError(-32001, "AHAP session page exceeds the 4 MiB frame limit; request a smaller page. No partial page was returned.");
}
export class AhapReadError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
export function validSessionId(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
}
export async function legacyRead(adapter: LegacyReadPort, method: string, params: Record<string, unknown>): Promise<unknown> {
  if (!legacyReadMethods(adapter).includes(method)) throw new AhapReadError(-32601, "Legacy adapter does not expose this read; inspect initialize capabilities.methods");
  if (method === "listSessions") {
    const options = params.options;
    if (options !== undefined) {
      if (!options || typeof options !== "object" || Array.isArray(options)) throw new AhapReadError(-32602, "listSessions expects {options:{limit?,cwd?}}");
      const value = options as Record<string, unknown>;
      if ((value.limit !== undefined && (!Number.isSafeInteger(value.limit) || Number(value.limit) < 1))
        || (value.cwd !== undefined && (typeof value.cwd !== "string" || !isAbsolute(value.cwd)))) {
        throw new AhapReadError(-32602, "listSessions options require positive integer limit and absolute cwd when supplied");
      }
    }
    return boundSessionRows(await adapter.listSessions!(options as ListSessionsOptions | undefined), options as ListSessionsOptions | undefined);
  }
  if (method === "listProjects") return adapter.listProjects!();
  if (!validSessionId(params.id)) throw new AhapReadError(-32602, "getRawTranscript expects {id: non-empty exact native session ID}");
  const raw = await adapter.getRawTranscript!(params.id);
  if (raw === null) return null;
  return { bytes_base64: Buffer.from(raw.bytes).toString("base64"), complete: raw.complete,
    source: raw.source, timestampCoverage: raw.timestampCoverage,
    ...(raw.limitations === undefined ? {} : { limitations: raw.limitations }) };
}

/** Never echo exception messages: they may contain tokens, URLs or prompt text. */
export function adapterFailureContext(method: string, mutation: boolean) {
  return { outcome: mutation ? "unknown" : "read_failed", ...(mutation ? { retryable: false } : {}),
    method, expected: "Selected legacy adapter must return a response for the requested method",
    correctiveAction: mutation
      ? "Do not repeat this mutation. Read the exact session and native receipt using the original inputId; inspect owner-side adapter diagnostics."
      : "Check the selected instance, owner profile and native session ID; inspect owner-side adapter diagnostics." };
}

export const AHAP_MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** Includes the newline, matching the Rust AHAP frame reader. Never truncate exports. */
export function writeAhapFrame(output: import("node:stream").Writable, value: unknown): void {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame, "utf8") > AHAP_MAX_FRAME_BYTES) {
    throw new AhapReadError(-32001, "AHAP response exceeds 4 MiB frame limit; request a smaller read or use the legacy native export path. No truncated transcript was returned.");
  }
  output.write(frame);
}
