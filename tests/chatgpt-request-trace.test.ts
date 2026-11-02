import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { ChatGptRequestTrace } from "../src/adapters/chatgpt-request-trace.js";
import { CHATGPT_LIST_API_SCRIPT, chatgptMessagesApiScript } from "../src/adapters/browser-chat-api-scripts.js";
import { CHATGPT_MAC_SNAPSHOT } from "../src/adapters/chatgpt-mac-cdp-driver.js";

const CHAT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SECRET = "PRIVATE_TOKEN_CANNOT_APPEAR";

function fixture(status = 429, sessionStatus = 200, retryAfter: string | null = "120") {
  let now = 1_000;
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  class Clock extends Date { static override now() { return now; } }
  const context = vm.createContext({
    location: { origin: "https://chatgpt.com" }, Date: Clock, TextEncoder,
    crypto: webcrypto,
    fetch: async (url: string, opts: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: opts?.headers });
      if (url === "/api/auth/session") return {
        ok: sessionStatus === 200, status: sessionStatus, headers: { get: () => null },
        json: async () => ({ accessToken: SECRET, account: { id: "PRIVATE_ACCOUNT_ID" } }),
      };
      return {
        ok: status === 200, status,
        headers: { get: (key: string) => key.toLowerCase() === "retry-after" ? retryAfter : null },
        json: async () => ({ items: [], conversation_id: CHAT_ID, messages: [] }),
      };
    },
  });
  return {
    run: (source: string): Promise<Record<string, unknown>> => vm.runInContext("(" + source + ")()", context),
    calls, advance: (ms: number) => { now += ms; },
  };
}

describe("ChatGPT source attribution without external traffic", () => {
  it("records the actual HTTP status and Retry-After, not credentials or URL queries", async () => {
    const f = fixture();
    const result = await f.run(CHATGPT_LIST_API_SCRIPT);
    expect(result.error).toBe("list_http_429");
    expect(f.calls).toHaveLength(2);
    const trace = result.trace as Array<Record<string, unknown>>;
    expect(trace.map(x => x.operation)).toEqual(["auth_session", "conversation_list"]);
    expect(trace[1]!.http_status).toBe(429);
    expect(trace[1]!.retry_after_s).toBe(120);
    expect(trace[1]!.backoff_ms).toBe(120000); // deployed Retry-After=120 contract
    const logs: string[] = [];
    const t = new ChatGptRequestTrace(s => logs.push(s));
    t.ingestBrowserHttp(trace);
    expect(t.minuteSnapshot().reduce((n, r) => n + Number(r.upstream_http), 0)).toBe(2);
    const text = logs.join("");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("PRIVATE_ACCOUNT_ID");
    expect(text).not.toContain("offset=0");
    expect(text).toContain('"http_status":429');
    expect(text).toContain('"retry_after_s":120');
    expect(f.calls[1]!.headers).toHaveProperty("authorization");
    expect(Object.keys(f.calls[1]!.headers || {})).not.toContain("X-Correlation-ID");
  });

  it("never implies a backoff that the browser did not actually set", async () => {
    const f = fixture(429);
    // The auth endpoint returns 200, while the conversation endpoint returns 429.
    const data = await f.run(CHATGPT_LIST_API_SCRIPT);
    const trace = data.trace as Array<Record<string, unknown>>;
    expect(trace[0]?.operation).toBe("auth_session");
    expect(trace[0]?.backoff_ms).toBe(0);
    expect(trace[1]?.backoff_ms).toBe(120000); // deployed Retry-After=120 contract
  });

  it.each([
    ["list", "120", 120000], ["list", null, 60000], ["list", "9999", 300000],
    ["history", "120", 120000], ["history", null, 60000], ["history", "9999", 300000],
  ] as const)("logs and enforces the deployed %s cooldown for Retry-After %s", async (operation, retryAfter, expectedMs) => {
    const f = fixture(429, 200, retryAfter);
    const script = operation === "list" ? CHATGPT_LIST_API_SCRIPT : chatgptMessagesApiScript(CHAT_ID);
    const result = await f.run(script);
    const trace = result.trace as Array<Record<string, unknown>>;
    expect(trace[0]!.backoff_ms).toBe(0);
    expect(trace[1]!.backoff_ms).toBe(expectedMs);
    expect(f.calls).toHaveLength(2);
    f.advance(expectedMs - 1);
    expect((await f.run(script)).error).toBe("read_cooldown");
    expect(f.calls).toHaveLength(2);
    f.advance(1);
    await f.run(script);
    expect(f.calls).toHaveLength(4);
  });

  it("attributes auth/session 429 as HTTP without claiming an unapplied cooldown", async () => {
    const f = fixture(200, 429);
    const data = await f.run(CHATGPT_LIST_API_SCRIPT);
    expect(data.error).toBe("session_unavailable");
    expect(f.calls).toHaveLength(1);
    const trace = data.trace as Array<Record<string, unknown>>;
    expect(trace).toHaveLength(1);
    expect(trace[0]?.http_status).toBe(429);
    expect(trace[0]?.backoff_ms).toBe(0);
  });

  it("history 429 and cooldown do not create an extra HTTP request", async () => {
    const f = fixture();
    const result = await f.run(chatgptMessagesApiScript(CHAT_ID));
    expect(result.error).toBe("history_http_429");
    expect((result.trace as Array<Record<string, unknown>>)[1]!.endpoint)
      .toBe("/backend-api/conversations/{id}");
    const before = f.calls.length;
    f.advance(10_000);
    expect((await f.run(CHATGPT_LIST_API_SCRIPT)).error).toBe("read_cooldown");
    expect(f.calls).toHaveLength(before);
  });

  it("keeps DOM, delegated page observations, and real upstream counters separate", () => {
    const output: string[] = [];
    const trace = new ChatGptRequestTrace(s => output.push(s));
    const at = Date.now();
    trace.record({ kind: "dom_cache_read", initiator: "herder_browser", executor: "herder_cdp",
      operation: "cache_lookup", endpoint: "other", cache_hit: true }, at);
    trace.ingestPageResources([{operation: "conversation_read",
      endpoint: "/backend-api/conversations/{id}", http_status: 429,
      latency_ms: 3, headers: SECRET, url: "/chat/SECRET"}]);
    expect(trace.minuteSnapshot().reduce((n, r) => n + Number(r.upstream_http), 0)).toBe(0);
    expect(output.join("")).not.toContain(SECRET);
    expect(trace.minuteSnapshot(at).reduce((n, r) => n + Number(r.cache_hits), 0)).toBe(1);
    trace.record({kind: "upstream_http", initiator: SECRET, executor: SECRET,
      operation: SECRET, endpoint: "https://evil/?token="+SECRET}, at);
    expect(output.join("")).not.toContain(SECRET);
  });

  it("caps event memory and evicts minute buckets after 60 minutes", () => {
    const messages: string[] = [];
    const t = new ChatGptRequestTrace(s => messages.push(s));
    for (let i = 0; i < 520; i++) t.record({
      kind: "upstream_http", initiator: "herder_browser", executor: "herder_cdp",
      operation: "conversation_list", endpoint: "/backend-api/conversations", http_status: 200
    }, 100_000);
    expect(t.retainedCount(100_000)).toBe(512);
    expect(messages).toHaveLength(ChatGptRequestTrace.MAX_LOG_EVENTS_PER_MINUTE);
    expect(t.retainedCount(100_000 + 3_600_001)).toBe(0);
    expect(t.minuteSnapshot(100_000 + 3_600_001)).toEqual([]);
  });

  it("emits one minute aggregate without a polling timer or another network request", () => {
    const logs: string[] = [];
    const trace = new ChatGptRequestTrace(s => logs.push(s));
    const event = { kind: "upstream_http" as const, initiator: "herder_browser",
      executor: "herder_cdp", operation: "auth_session", endpoint: "/api/auth/session",
      http_status: 429 };
    trace.record(event, 120000);
    trace.record(event, 120001);
    trace.record(event, 180001);
    const rollups = logs.map(v => JSON.parse(v)).filter(x => x.schema === "chatgpt_minute_v1");
    expect(rollups).toHaveLength(1);
    expect(rollups[0].events).toBe(2);
    expect(rollups[0].upstream_http).toBe(2);
    expect(rollups[0].http_429).toBe(2);
  });

  it("passively observes ResourceTiming without exposing paths or sending fetches", () => {
    let entries: Array<Record<string, unknown>> = [];
    const context = vm.createContext({
      location: { origin: "https://chatgpt.com", pathname: "/c/" + CHAT_ID },
      document: { querySelectorAll: () => [], querySelector: () => null },
      performance: { getEntriesByType: () => entries },
      URL,
    });
    const run = () => vm.runInContext("(" + CHATGPT_MAC_SNAPSHOT + ")()", context);
    expect(run().pageResources).toEqual([]);
    entries = [{ name: "https://chatgpt.com/backend-api/conversations/"+CHAT_ID+"?oauth_state=OAUTH_STATE_PRIVATE&code=OAUTH_CODE_PRIVATE&access_token="+SECRET,
      startTime: 1, duration: 47, responseStatus: 429, initiatorType: "fetch" }];
    const observations = run().pageResources as Array<Record<string, unknown>>;
    expect(observations).toHaveLength(1);
    expect(observations[0]).toEqual({
      endpoint: "/backend-api/conversations/{id}",
      operation: "conversation_read", http_status: 429, latency_ms: 47,
    });
    expect(JSON.stringify(observations)).not.toContain(SECRET);
    expect(JSON.stringify(observations)).not.toContain("OAUTH_CODE_PRIVATE");
    expect(JSON.stringify(observations)).not.toContain("OAUTH_STATE_PRIVATE");
  });
});
