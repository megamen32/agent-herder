/** Local, metadata-only diagnostics for ChatGPT browser/CDP traffic.
 * Never accept arbitrary URL, header, account/chat IDs or message fields.
 * Only final HTTP calls count as upstream; page observations may overlap.
 */
import { randomBytes } from "node:crypto";

export type ChatGptTraceKind = "upstream_http" | "dom_cache_read" | "page_resource_observed";
type Input = {
  kind: ChatGptTraceKind; initiator: string; executor: string;
  operation: string; endpoint: string; http_status?: unknown; latency_ms?: unknown;
  retry_after_s?: unknown; backoff_ms?: unknown; retry_attempt?: unknown;
  cache_hit?: unknown;
};
const KINDS = new Set(["upstream_http", "dom_cache_read", "page_resource_observed"]);
const INITIATORS = new Set(["herder_browser", "page_unknown"]);
const EXECUTORS = new Set(["herder_cdp", "browser_page"]);
const OPERATIONS = new Set(["auth_session", "conversation_list", "conversation_read",
  "snapshot", "cache_lookup", "other"]);
const ENDPOINTS = new Set(["/api/auth/session", "/backend-api/conversations",
  "/backend-api/conversation/{id}", "/backend-api/conversations/{id}", "other"]);
const safe = (v: unknown, values: Set<string>, fallback: string): string =>
  typeof v === "string" && values.has(v) ? v : fallback;
const bounded = (v: unknown, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v))) : 0;
const httpStatus = (v: unknown): number | null =>
  Number.isInteger(v) && Number(v) >= 100 && Number(v) <= 599 ? Number(v) : null;

type Stats = { events: number; upstream_http: number; http_429: number;
  latency_ms_sum: number; cache_hits: number };
type Stored = { when: number; value: Record<string, unknown> };

export class ChatGptRequestTrace {
  static readonly RETENTION_MS = 3_600_000;
  static readonly MAX_EVENTS = 512;
  static readonly MAX_MINUTES = 60;
  static readonly MAX_KEYS_PER_MINUTE = 128;
  static readonly MAX_LOG_EVENTS_PER_MINUTE = 120;
  private readonly events: Stored[] = [];
  private readonly minutes = new Map<number, Map<string, Stats>>();

  constructor(private readonly emit: (value: string) => void =
    value => console.error("[agent-herder] chatgpt_request " + value)) {}

  record(input: Input, now = Date.now()): Record<string, unknown> {
    const kind = safe(input.kind, KINDS, "page_resource_observed");
    const operation = safe(input.operation, OPERATIONS, "other");
    const endpoint = safe(input.endpoint, ENDPOINTS, "other");
    const initiator = safe(input.initiator, INITIATORS, "page_unknown");
    const executor = safe(input.executor, EXECUTORS, "browser_page");
    const status = httpStatus(input.http_status);
    const latency = bounded(input.latency_ms, 3_600_000);
    const event = {
      schema: "chatgpt_req_v1", utc: new Date(now).toISOString(),
      rid: randomBytes(8).toString("hex"), initiator, executor, kind,
      operation, endpoint, http_status: status, latency_ms: latency,
      retry_after_s: typeof input.retry_after_s === "number" && Number.isFinite(input.retry_after_s)
        ? bounded(input.retry_after_s, 86_400) : null,
      backoff_ms: bounded(input.backoff_ms, 86_400_000),
      retry_attempt: bounded(input.retry_attempt, 99),
      cache_hit: input.cache_hit === true,
      upstream_count: kind === "upstream_http" ? 1 : 0,
    };
    this.events.push({ when: now, value: event });
    while (this.events.length > ChatGptRequestTrace.MAX_EVENTS ||
      (this.events.length && this.events[0]!.when < now - ChatGptRequestTrace.RETENTION_MS)) {
      this.events.shift();
    }
    const minute = Math.floor(now / 60_000);
    const previous = [...this.minutes.keys()].at(-1);
    if (previous !== undefined && minute > previous) {
      const buckets = [...this.minutes.get(previous)!.values()];
      this.emit(JSON.stringify({
        schema: "chatgpt_minute_v1", minute_utc: new Date(previous * 60_000).toISOString(),
        events: buckets.reduce((n, x) => n + x.events, 0),
        upstream_http: buckets.reduce((n, x) => n + x.upstream_http, 0),
        http_429: buckets.reduce((n, x) => n + x.http_429, 0),
        cache_hits: buckets.reduce((n, x) => n + x.cache_hits, 0),
      }));
    }
    for (const key of this.minutes.keys()) {
      if (key < minute - ChatGptRequestTrace.MAX_MINUTES + 1 || key > minute) this.minutes.delete(key);
    }
    let bucket = this.minutes.get(minute);
    if (!bucket) { bucket = new Map(); this.minutes.set(minute, bucket); }
    let key = JSON.stringify([kind, operation, endpoint, status]);
    if (!bucket.has(key) && bucket.size >= ChatGptRequestTrace.MAX_KEYS_PER_MINUTE) {
      key = JSON.stringify(["overflow", "other", "other", null]);
    }
    const stats = bucket.get(key) ?? {
      events: 0, upstream_http: 0, http_429: 0, latency_ms_sum: 0, cache_hits: 0,
    };
    stats.events++;
    stats.upstream_http += event.upstream_count;
    stats.http_429 += Number(kind === "upstream_http" && status === 429);
    stats.latency_ms_sum += latency;
    stats.cache_hits += Number(event.cache_hit);
    bucket.set(key, stats);
    // Exact counters continue after event sampling; journald volume stays bounded.
    if ([...bucket.values()].reduce((n, x) => n + x.events, 0) <=
        ChatGptRequestTrace.MAX_LOG_EVENTS_PER_MINUTE) {
      this.emit(JSON.stringify(event)); // Only fields assembled above, no raw request values.
    }
    return event;
  }

  /** Only enumerable safe fields are copied out of an untrusted browser result. */
  ingestBrowserHttp(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const raw of value.slice(0, 8)) {
      if (!raw || typeof raw !== "object") continue;
      const v = raw as Record<string, unknown>;
      this.record({
        kind: "upstream_http", initiator: "herder_browser", executor: "herder_cdp",
        operation: v.operation as string, endpoint: v.endpoint as string,
        http_status: v.http_status, latency_ms: v.latency_ms,
        retry_after_s: v.retry_after_s, backoff_ms: v.backoff_ms,
        retry_attempt: 0, cache_hit: false,
      });
    }
  }

  ingestPageResources(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const raw of value.slice(0, 40)) {
      if (!raw || typeof raw !== "object") continue;
      const v = raw as Record<string, unknown>;
      this.record({
        kind: "page_resource_observed", initiator: "page_unknown", executor: "browser_page",
        operation: v.operation as string, endpoint: v.endpoint as string,
        http_status: v.http_status, latency_ms: v.latency_ms,
      });
    }
  }

  minuteSnapshot(now = Date.now()): Array<Record<string, unknown>> {
    const after = Math.floor(now / 60_000) - ChatGptRequestTrace.MAX_MINUTES + 1;
    return [...this.minutes.entries()].flatMap(([minute, bucket]) =>
      minute < after || minute > Math.floor(now / 60_000) ? [] :
        [...bucket.entries()].map(([key, stats]) => {
          const [kind, operation, endpoint, status] = JSON.parse(key) as [string, string, string, number|null];
          return { minute_utc: new Date(minute * 60_000).toISOString(), kind, operation,
            endpoint, http_status: status, ...stats };
        }));
  }

  retainedCount(now = Date.now()): number {
    return this.events.filter(e => e.when >= now - ChatGptRequestTrace.RETENTION_MS).length;
  }
}
