import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LatestQuotaStatusRequest,
  quotaWaitStateLabel,
  quotaWaitStatusPath,
  readQuotaWaitStatus,
  readWaitForQuota,
  writeWaitForQuota,
  type QuotaRecoverySession,
} from "../src/web-ui/quota-recovery-controls.js";

const session: QuotaRecoverySession = { harness: "opencode", id: "native:session id", cwd: "/workspace with spaces" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("quota recovery controls API client", () => {
  it("reads the independently inherited exact-session setting", async () => {
    const fetch = vi.fn(async () => jsonResponse({ waitForQuota: true, waitForQuotaSource: "harness", waitForQuotaOverride: null }));
    vi.stubGlobal("fetch", fetch);

    await expect(readWaitForQuota({ kind: "session", session })).resolves.toEqual({
      waitForQuota: true,
      waitForQuotaSource: "harness",
      waitForQuotaOverride: null,
    });
    const [path, init] = fetch.mock.calls[0]!;
    const url = new URL(String(path), "http://local.test");
    expect(url.pathname).toBe("/api/session-autostart/sessions/opencode/native%3Asession%20id");
    expect(url.searchParams.get("cwd")).toBe(session.cwd);
    expect(init).toMatchObject({ cache: "no-store" });
  });

  it("writes null only to clear the selected session override", async () => {
    const fetch = vi.fn(async () => jsonResponse({ waitForQuota: false, waitForQuotaSource: "global", waitForQuotaOverride: null }));
    vi.stubGlobal("fetch", fetch);

    await writeWaitForQuota({ kind: "session", session }, null);
    const [path, init] = fetch.mock.calls[0]!;
    expect(String(path)).toContain("/api/session-autostart/sessions/opencode/");
    expect(JSON.parse(String(init?.body))).toEqual({ waitForQuota: null, cwd: session.cwd });
  });

  it("keeps exact session identity in the status query and returns only reported fields", async () => {
    const fetch = vi.fn(async () => jsonResponse({ wait: {
      state: "waiting", reason: "Сброс квоты ожидается", resetAt: "2026-10-21T02:00:00.000Z",
      currentModel: "omniroute/test-provider/current", selectedModel: "omniroute/test-provider/next",
      unrelated: "must not be surfaced",
    } }));
    vi.stubGlobal("fetch", fetch);

    const path = quotaWaitStatusPath(session);
    const url = new URL(path, "http://local.test");
    expect(url.pathname).toBe("/api/quota-recovery/waits");
    expect(Object.fromEntries(url.searchParams)).toEqual({ harness: session.harness, sessionId: session.id, cwd: session.cwd });
    await expect(readQuotaWaitStatus(session)).resolves.toEqual({
      state: "waiting",
      reason: "Сброс квоты ожидается",
      resetAt: "2026-10-21T02:00:00.000Z",
      currentModel: "omniroute/test-provider/current",
      selectedModel: "omniroute/test-provider/next",
    });
  });

  it("returns null only for an explicit empty queue response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ waits: [] })));
    await expect(readQuotaWaitStatus(session)).resolves.toBeNull();
  });

  it("aborts session A and ignores its late response after switching to session B", async () => {
    const sessionA = { ...session, id: "session-a" };
    const sessionB = { ...session, id: "session-b" };
    const delayedA = deferred<Response>();
    let signalA: AbortSignal | undefined;
    const fetch = vi.fn((path: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(path), "http://local.test");
      if (url.searchParams.get("sessionId") === sessionA.id) {
        signalA = init?.signal ?? undefined;
        // Deliberately resolve despite abort to model a transport that settles late.
        return delayedA.promise;
      }
      return Promise.resolve(jsonResponse({ wait: { state: "accepted" } }));
    });
    vi.stubGlobal("fetch", fetch);

    const gate = new LatestQuotaStatusRequest();
    let visibleState: string | undefined;
    const load = async (selected: QuotaRecoverySession) => {
      const request = gate.begin();
      const status = await readQuotaWaitStatus(selected, request.signal);
      if (request.isCurrent()) visibleState = status?.state;
    };

    const requestA = load(sessionA);
    const requestB = load(sessionB);
    await requestB;
    expect(signalA?.aborted).toBe(true);
    delayedA.resolve(jsonResponse({ wait: { state: "held" } }));
    await requestA;

    expect(visibleState).toBe("accepted");
  });

  it("shows user-facing Russian labels for all terminal dispatch states", () => {
    expect(quotaWaitStateLabel("dispatching")).toBe("Продолжение отправляется");
    expect(quotaWaitStateLabel("accepted")).toBe("Продолжение принято агентом");
    expect(quotaWaitStateLabel("exhausted")).toBe("Запасные модели исчерпаны");
  });

  it("rejects incomplete effective settings rather than defaulting to enabled or disabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ waitForQuota: true })));
    await expect(readWaitForQuota({ kind: "global" })).rejects.toThrow("Invalid waitForQuota settings response");
  });
});
