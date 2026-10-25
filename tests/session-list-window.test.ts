import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import { createWebServer } from "../src/web/server.js";
import { orderSessionListForPanel, isLiveListedSession, listedActivityTime } from "../src/session-listing.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";

/**
 * The list of the sessions answers a window and the counter of the whole list.
 *
 * The whole list of the mesh is megabytes of JSON: a browser that parses it
 * on the first paint does not come alive. The panel asks for a window, and
 * the answer says how many sessions the mesh has in total, so the owner sees
 * that the list is longer than the window and can load more.
 *
 * The server bounds the answer even when the caller names no window: the
 * history of the mesh is megabytes of JSON, and a screen of the panel must
 * not become slow because another screen asked for the history. The counter
 * of the whole list travels with the answer, so a caller that counts the
 * sessions of the mesh still counts them all.
 */

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function fakeAdapter(count: number, padding = ""): HarnessAdapter {
  const sessions: AgentSession[] = Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    harness: "claude",
    status: "stopped",
    title: `Session ${index}`,
    cwd: `/tmp/project-${index}`,
    lastActivity: new Date().toISOString(),
    needsPermission: false,
    ...(padding ? { meta: { padding } } as Partial<AgentSession> : {}),
  }));
  return {
    type: "claude",
    name: "Fake Claude",
    async init() {},
    async listSessions() { return [...sessions]; },
    async getSession(id) { return sessions.find((session) => session.id === id) ?? null; },
    async sendMessage() { return { ok: true }; },
    async stopSession() { return { ok: false, error: "cannot stop" }; },
    async respondPermission() { return { ok: false, error: "permission backend unavailable" }; },
    async setPermissions() { return { ok: true }; },
  };
}

/** The server of the test with the given number of sessions. */
async function startServer(count: number, padding = ""): Promise<string> {
  const server = createWebServer({
    adapters: new Map([["claude", fakeAdapter(count, padding)]]),
    converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } },
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  const base = `http://127.0.0.1:${address.port}`;
  // The first read establishes the snapshot of the sessions, so the quick
  // read below answers from the snapshot and not from an empty one.
  await fetch(`${base}/api/sessions`);
  return base;
}

describe("the list of the sessions is a window with a counter", () => {
  it("answers the window the panel asks for and the counter of the whole list", async () => {
    const base = await startServer(25);
    const response = await fetch(`${base}/api/sessions?quick=1&limit=10`);
    expect(response.status).toBe(200);
    const body = await response.json() as { sessions: unknown[]; total?: number; limit?: number; truncated?: boolean };
    expect(body.sessions.length).toBe(10);
    expect(body.total).toBe(25);
    expect(body.limit).toBe(10);
    expect(body.truncated).toBe(true);
  });

  it("answers a bounded window and the counter of the whole list when the caller names no window", async () => {
    const base = await startServer(150);
    const response = await fetch(`${base}/api/sessions?quick=1`);
    const body = await response.json() as { sessions: unknown[]; total?: number; limit?: number; truncated?: boolean };
    // The server bounds the answer: a caller that names no window gets the
    // default window, not the whole history of the mesh. The counter of the
    // whole list travels with the answer, so a contour that counts the
    // sessions of the mesh must not lose half of them silently.
    expect(body.sessions.length).toBe(100);
    expect(body.total).toBe(150);
    expect(body.limit).toBe(100);
    expect(body.truncated).toBe(true);
  });

  it("bounds the window and never answers more than the bound", async () => {
    const base = await startServer(25);
    const response = await fetch(`${base}/api/sessions?quick=1&limit=100000`);
    const body = await response.json() as { sessions: unknown[]; total?: number };
    expect(body.sessions.length).toBe(25);
    // The counter names the whole list, not the window.
    expect(body.total).toBe(25);
  });

  it("keeps the answer inside the byte budget even with heavy sessions", async () => {
    const base = await startServer(40, "x".repeat(10_000));
    const response = await fetch(`${base}/api/sessions?quick=1&limit=40`);
    const text = await response.text();
    // The budget of the answer is 300 KiB; the envelope of the answer is
    // counted apart from the sessions.
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(300 * 1024 + 4096);
    const body = JSON.parse(text) as { sessions: unknown[]; total?: number };
    expect(body.sessions.length).toBeLessThan(40);
    expect(body.total).toBe(40);
  });

  it("answers the default window when the window is not a number", async () => {
    const base = await startServer(25);
    const response = await fetch(`${base}/api/sessions?quick=1&limit=many`);
    const body = await response.json() as { sessions: unknown[]; total?: number; limit?: number; truncated?: boolean };
    // A window that is not a number is not a window to ask for everything
    // with: the default window answers, and the counter keeps the truth.
    expect(body.sessions.length).toBe(25);
    expect(body.total).toBe(25);
    expect(body.limit).toBe(100);
    expect(body.truncated).toBe(false);
  });

  it("keeps the answer inside the byte budget even when the caller names no window", async () => {
    const base = await startServer(40, "x".repeat(10_000));
    const response = await fetch(`${base}/api/sessions?quick=1`);
    const text = await response.text();
    // The budget of the answer is 300 KiB; the envelope of the answer is
    // counted apart from the sessions.
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(300 * 1024 + 4096);
    const body = JSON.parse(text) as { sessions: unknown[]; total?: number; truncated?: boolean };
    expect(body.sessions.length).toBeLessThan(40);
    expect(body.total).toBe(40);
    expect(body.truncated).toBe(true);
  });

  it("never caches the shell of the panel", async () => {
    const base = await startServer(5);
    const response = await fetch(`${base}/`);
    // The shell names the bundle of the current release. A cached shell keeps
    // an old bundle alive in the browser, and an old bundle asks for the
    // whole history of the mesh.
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});

/**
 * Порядок списка сессий для панели.
 *
 * Окно ответа — это префикс списка, ограниченный байт-бюджетом. Если порядок
 * списка совпадает с порядком регистрации адаптеров, то среда, зарегистрированная
 * последней, в окно не попадает никогда: её сессии просто не существуют для
 * панели. Порядок должен нести то, что человек делает сейчас, и не должен
 * вытеснять целую среду, потому что другая была занятнее.
 */
describe("порядок списка для панели", () => {
  it("живые сессии идут первыми", () => {
    const cold = { id: "cold", harness: "codex", status: "idle", lastActivity: "2026-10-25T02:00:00.000Z" };
    const live = { id: "live", harness: "minimax-code", status: "running", lastActivity: "2026-10-25T01:00:00.000Z" };
    const colder = { id: "colder", harness: "zcode", status: "stopped", lastActivity: "2026-10-24T02:00:00.000Z" };
    const ordered = orderSessionListForPanel([cold, live, colder]);
    expect(ordered[0]?.id).toBe("live");
    expect(ordered.map((session) => session.id)).toContain("cold");
    expect(ordered.map((session) => session.id)).toContain("colder");
  });

  it("живые сессии идут по свежести, а не по порядку в списке", () => {
    const older = { id: "older", harness: "minimax-code", status: "running", lastActivity: "2026-10-25T01:00:00.000Z" };
    const newer = { id: "newer", harness: "minimax-code", status: "needs_input", lastActivity: "2026-10-25T03:00:00.000Z" };
    expect(orderSessionListForPanel([older, newer]).map((session) => session.id)).toEqual(["newer", "older"]);
  });

  it("среды берутся по кругу: сначала самая свежая сессия каждой среды, потом вторая", () => {
    const sessions = [
      { id: "codex-1", harness: "codex", status: "idle", lastActivity: "2026-10-25T01:00:00.000Z" },
      { id: "codex-2", harness: "codex", status: "idle", lastActivity: "2026-10-25T00:30:00.000Z" },
      { id: "minimax-1", harness: "minimax-code", status: "idle", lastActivity: "2026-10-25T02:00:00.000Z" },
      { id: "minimax-2", harness: "minimax-code", status: "idle", lastActivity: "2026-10-25T00:15:00.000Z" },
    ];
    const ordered = orderSessionListForPanel(sessions).map((session) => session.id);
    expect(ordered).toEqual(["minimax-1", "codex-1", "minimax-2", "codex-2"]);
  });

  it("занятая среда не вытесняет остальные из окна", () => {
    const busy = Array.from({ length: 20 }, (_, index) => ({
      id: `minimax-${index}`,
      harness: "minimax-code",
      status: "idle",
      lastActivity: new Date(Date.UTC(2026, 9, 25, 2, 0, 0) - index * 1000).toISOString(),
    }));
    const codex = { id: "codex-1", harness: "codex", status: "idle", lastActivity: "2026-10-20T00:00:00.000Z" };
    const ordered = orderSessionListForPanel([...busy, codex]).map((session) => session.id);
    // Первым кругом идёт самая свежая сессия каждой среды, поэтому Codex
    // попадает в окно, хотя MiniMax Code пишет в двадцать раз чаще.
    expect(ordered.slice(0, 2)).toEqual(["minimax-0", "codex-1"]);
  });

  it("порядок устойчив: равные времена сохраняют порядок в списке", () => {
    const first = { id: "first", harness: "codex", status: "idle", lastActivity: "2026-10-25T02:00:00.000Z" };
    const second = { id: "second", harness: "codex", status: "idle", lastActivity: "2026-10-25T02:00:00.000Z" };
    const third = { id: "third", harness: "codex", status: "idle", lastActivity: "2026-10-25T02:00:00.000Z" };
    expect(orderSessionListForPanel([first, second, third]).map((session) => session.id)).toEqual(["first", "second", "third"]);
    expect(orderSessionListForPanel([third, first, second]).map((session) => session.id)).toEqual(["third", "first", "second"]);
  });

  it("сессия без читаемого времени уходит в конец своей среды, а не выдумывает время", () => {
    const withoutTime = { id: "without-time", harness: "codex", status: "idle" };
    const brokenTime = { id: "broken-time", harness: "codex", status: "idle", lastActivity: "не дата" };
    const withTime = { id: "with-time", harness: "codex", status: "idle", lastActivity: "2026-10-25T02:00:00.000Z" };
    const ordered = orderSessionListForPanel([withoutTime, brokenTime, withTime]);
    expect(ordered.map((session) => session.id)).toEqual(["with-time", "without-time", "broken-time"]);
    expect(listedActivityTime(brokenTime)).toBe(0);
  });

  it("исходный массив не меняется", () => {
    const sessions = [
      { id: "a", harness: "codex", status: "idle", lastActivity: "2026-10-25T02:00:00.000Z" },
      { id: "b", harness: "minimax-code", status: "running", lastActivity: "2026-10-25T01:00:00.000Z" },
    ];
    orderSessionListForPanel(sessions);
    expect(sessions.map((session) => session.id)).toEqual(["a", "b"]);
  });

  it("живой считается только доказанный статус, а не любой непустой", () => {
    expect(isLiveListedSession({ status: "running" })).toBe(true);
    expect(isLiveListedSession({ status: "needs_input" })).toBe(true);
    expect(isLiveListedSession({ status: "idle" })).toBe(false);
    expect(isLiveListedSession({ status: "stopped" })).toBe(false);
    expect(isLiveListedSession({})).toBe(false);
  });
});

/**
 * Окно списка сессий не должно прятать целую среду.
 *
 * Окно ответа — это префикс списка, ограниченный байт-бюджетом в 300 КБ. Порядок
 * списка по умолчанию совпадал с порядком регистрации адаптеров, поэтому среда,
 * зарегистрированная последней, в окно не попадала никогда: ни в списке, ни в
 * поиске панели, который фильтрует то же окно. Живая сессия MiniMax Code должна
 * быть видна в панели даже тогда, когда первая зарегистрированная среда уже
 * заполнила собой бюджет ответа.
 */
describe("окно списка сессий не прячет среду, зарегистрированную последней", () => {
  /** Тяжёлые сессии первой среды: они заполняют байт-бюджет окна. */
  function heavyAdapter(count: number): HarnessAdapter {
    const padding = "x".repeat(8 * 1024);
    const sessions: AgentSession[] = Array.from({ length: count }, (_, index) => ({
      id: `heavy-${index}`,
      harness: "claude",
      status: "stopped",
      title: `Heavy ${index}`,
      cwd: `/tmp/heavy-${index}`,
      hostId: "roomhacker-server-100",
      lastActivity: "2026-10-20T00:00:00.000Z",
      needsPermission: false,
      meta: { padding } as Partial<AgentSession>["meta"],
    }));
    return {
      type: "claude",
      name: "Heavy Claude",
      async init() {},
      async listSessions() { return [...sessions]; },
      async getSession(id) { return sessions.find((session) => session.id === id) ?? null; },
      async sendMessage() { return { ok: true }; },
      async stopSession() { return { ok: false, error: "cannot stop" }; },
      async respondPermission() { return { ok: false, error: "permission backend unavailable" }; },
      async setPermissions() { return { ok: true }; },
    };
  }

  /** Сессии MiniMax Code: одна живая и одна свежая. */
  function minimaxAdapter(): HarnessAdapter {
    const sessions: AgentSession[] = [
      {
        id: "mvs_live",
        harness: "minimax-code",
        status: "running",
        title: "Живая сессия MiniMax Code",
        cwd: "/tmp/minimax",
        hostId: "roomhacker-server-100",
        lastActivity: "2026-10-25T01:00:00.000Z",
        needsPermission: false,
        meta: { activityEvidence: "native_runtime_turn_lease" },
      },
      {
        id: "mvs_fresh",
        harness: "minimax-code",
        status: "idle",
        title: "Свежая сессия MiniMax Code",
        cwd: "/tmp/minimax",
        hostId: "roomhacker-server-100",
        lastActivity: "2026-10-25T02:00:00.000Z",
        needsPermission: false,
      },
    ];
    return {
      type: "minimax-code",
      name: "MiniMax Code",
      async init() {},
      async listSessions() { return [...sessions]; },
      async getSession(id) { return sessions.find((session) => session.id === id) ?? null; },
      async sendMessage() { return { ok: true }; },
      async stopSession() { return { ok: false, error: "cannot stop" }; },
      async respondPermission() { return { ok: false, error: "permission backend unavailable" }; },
      async setPermissions() { return { ok: true }; },
    };
  }

  async function startPanelServer(): Promise<string> {
    // Порядок регистрации повторяет боевой: тяжёлая среда идёт первой,
    // MiniMax Code — последней.
    const server = createWebServer({
      adapters: new Map<string, HarnessAdapter>([
        ["claude", heavyAdapter(60)],
        ["minimax-code", minimaxAdapter()],
      ]),
      converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    await fetch(`${base}/api/sessions`);
    return base;
  }

  type ListBody = { sessions: Array<{ id: string; harness: string; status: string }>; total?: number; truncated?: boolean };

  it("живая сессия MiniMax Code попадает в окно, даже когда бюджет выбран тяжёлой средой", async () => {
    const base = await startPanelServer();
    const response = await fetch(`${base}/api/sessions?quick=1&limit=500`);
    expect(response.status).toBe(200);
    const body = await response.json() as ListBody;
    const ids = body.sessions.map((session) => session.id);
    // Без порядка окно исчерпывалось внутри первой среды.
    expect(ids).toContain("mvs_live");
    expect(ids).toContain("mvs_fresh");
    expect(body.sessions.filter((session) => session.harness === "minimax-code").length).toBe(2);
    // Счётчик всего списка не изменился: окно — это окно, а не другой список.
    expect(body.total).toBe(62);
  });

  it("живая сессия идёт в окне первой, а счётчик списка остаётся честным", async () => {
    const base = await startPanelServer();
    const body = await (await fetch(`${base}/api/sessions?quick=1&limit=500`)).json() as ListBody;
    expect(body.sessions[0]?.id).toBe("mvs_live");
    expect(body.sessions[0]?.status).toBe("running");
  });

  it("поиск панели по загруженному окну находит ту же сессию, что и список", async () => {
    const base = await startPanelServer();
    const all = await (await fetch(`${base}/api/sessions?quick=1&limit=500`)).json() as ListBody;
    // Поиск панели фильтрует загруженное окно: так он и должен находить.
    const found = all.sessions.filter((session) => session.harness === "minimax-code").map((session) => session.id);
    expect(found.sort()).toEqual(["mvs_fresh", "mvs_live"]);
  });

  it("фильтр по среде на сервере отдаёт те же сессии, что и общий список", async () => {
    const base = await startPanelServer();
    const all = await (await fetch(`${base}/api/sessions?quick=1&limit=500`)).json() as ListBody;
    const filtered = await (await fetch(`${base}/api/sessions?quick=1&harness=minimax-code&limit=500`)).json() as ListBody;
    const inAll = all.sessions.filter((session) => session.harness === "minimax-code").map((session) => session.id);
    const inFiltered = filtered.sessions.map((session) => session.id);
    // Серверный фильтр сужает список, поэтому ответ не уже общего окна.
    for (const id of inAll) expect(inFiltered).toContain(id);
  });
});
