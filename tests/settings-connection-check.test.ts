import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CENTER_CONTRACT_SCHEMA,
  SettingsConnectionStore,
  grantsLaunch,
  probeConnection,
} from "../src/web/settings-connection.js";
import {
  checkText,
  connectionStateText,
  probeRevokedLaunch,
  revokeEffectText,
} from "../src/web-ui/settings/connections-section.js";

/**
 * The check of the connection of the herder to the center.
 *
 * The check reads the state of the center and nothing else: it starts no
 * executor of the herder and it creates no event in the center. The answers
 * stay apart — the center answered, the center took the credential, the
 * center and the herder speak one contract — and a missing answer is never
 * turned into a success.
 */

type SeenRequest = { method: string; url: string; authorization?: string };

let servers: Server[] = [];
let stateDir = "";

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "herder-connection-check-"));
  servers = [];
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await rm(stateDir, { recursive: true, force: true });
});

type FakeCenterOptions = {
  health?: { status: number; body?: unknown };
  mutes?: { status: number; body?: unknown };
  instructions?: { status: number; body?: unknown };
};

/** A center of the test: it answers the three reads of the check and remembers them. */
async function startCenter(options: FakeCenterOptions = {}): Promise<{ url: string; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    seen.push({ method: request.method ?? "GET", url, authorization: request.headers.authorization });
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.startsWith("/health")) {
      const leg = options.health ?? { status: 401, body: { error: "unauthorized" } };
      send(leg.status, leg.body ?? {});
      return;
    }
    if (url.startsWith("/v1/mutes")) {
      const leg = options.mutes ?? { status: 200, body: { project: "agent-herder", mutes: [] } };
      send(leg.status, leg.body ?? {});
      return;
    }
    if (url.startsWith("/v1/instructions")) {
      const leg = options.instructions ?? { status: 200, body: { schema: CENTER_CONTRACT_SCHEMA } };
      send(leg.status, leg.body ?? {});
      return;
    }
    send(404, { error: "not found" });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { url: `http://127.0.0.1:${address.port}`, seen };
}

describe("the check of the connection of the herder to the center", () => {
  it("confirms the authorization and the compatibility without an executor and without an event", async () => {
    const center = await startCenter();

    const check = await probeConnection({
      centerUrl: center.url,
      purpose: "noticeplace.health-analysis",
      token: "the-secret-token-value",
      project: "agent-herder",
    });

    expect(check.reachable).toBe(true);
    expect(check.authorized).toBe(true);
    expect(check.compatible).toBe(true);
    expect(check.centerSchema).toBe(CENTER_CONTRACT_SCHEMA);
    expect(check.purposeAccepted).toBe(true);
    expect(check.detail).toContain("исполнитель не запускался");

    // The check only reads: it creates nothing in the center and it never
    // touches the route of the launch.
    expect(center.seen.every((request) => request.method === "GET")).toBe(true);
    expect(center.seen.map((request) => request.url)).not.toContain("/v1/events");
    expect(center.seen.map((request) => request.url)).not.toContain("/api/automation/project-launch");
    expect(center.seen.map((request) => request.url)).not.toContain("/api/health/remediation");
  });

  it("keeps the key of the service account out of the answer", async () => {
    const center = await startCenter();
    const check = await probeConnection({
      centerUrl: center.url,
      purpose: "noticeplace.health-analysis",
      token: "the-secret-token-value",
      project: "agent-herder",
    });
    expect(JSON.stringify(check)).not.toContain("the-secret-token-value");
  });

  it("says that the center refused the key instead of promising the authorization", async () => {
    const center = await startCenter({
      health: { status: 401, body: { error: "unauthorized" } },
      mutes: { status: 401, body: { error: "unauthorized" } },
    });

    const check = await probeConnection({
      centerUrl: center.url,
      purpose: "noticeplace.health-analysis",
      token: "the-secret-token-value",
      project: "agent-herder",
    });

    expect(check.reachable).toBe(true);
    // The key was refused: the authorization is not confirmed. The contract
    // of the center is a separate question — the center answers it without a
    // key — so the two answers stay apart and the panel shows both.
    expect(check.authorized).toBe(false);
    expect(check.compatible).toBe(true);
    expect(check.detail).toContain("отказал");
  });

  it("does not promise the compatibility for a contract the herder does not know", async () => {
    const center = await startCenter({
      instructions: { status: 200, body: { schema: "noticeplace.instructions.v9" } },
    });

    const check = await probeConnection({
      centerUrl: center.url,
      purpose: "noticeplace.health-analysis",
      token: "the-secret-token-value",
      project: "agent-herder",
    });

    expect(check.authorized).toBe(true);
    expect(check.compatible).toBe(false);
    expect(check.centerSchema).toBe("noticeplace.instructions.v9");
    expect(check.detail).toContain("контракт центра — noticeplace.instructions.v9");
  });

  it("does not promise the compatibility for a purpose the herder does not accept", async () => {
    const center = await startCenter();

    const check = await probeConnection({
      centerUrl: center.url,
      purpose: "some.other.purpose",
      token: "the-secret-token-value",
      project: "agent-herder",
    });

    expect(check.authorized).toBe(true);
    expect(check.compatible).toBe(false);
    expect(check.purposeAccepted).toBe(false);
    expect(check.detail).toContain("herder не принимает");
  });

  it("says that the center did not answer when it did not answer", async () => {
    const check = await probeConnection({
      centerUrl: "http://127.0.0.1:1",
      purpose: "noticeplace.health-analysis",
      project: "agent-herder",
    });
    expect(check.reachable).toBe(false);
    expect(check.authorized).toBe(false);
    expect(check.compatible).toBe(false);
    expect(check.detail).toContain("не ответил");
  });
});

describe("the record of the connection of the herder to the center", () => {
  it("grants nothing after the revocation and everything before it", async () => {
    const store = new SettingsConnectionStore({ stateDir });
    expect(await store.grantsLaunch()).toBe(false);
    expect(grantsLaunch(null)).toBe(false);

    const connected = await store.connect({
      centerUrl: "https://center.example",
      purpose: "noticeplace.health-analysis",
      permissions: ["read"],
    });
    expect(connected.state).toBe("connected");
    expect(await store.grantsLaunch()).toBe(true);
    expect(grantsLaunch(connected)).toBe(true);

    const revoked = await store.revoke();
    expect(revoked.state).toBe("revoked");
    expect(revoked.revokedAt).toBeTruthy();
    // The record is the authority: a revoked connection grants nothing.
    expect(await store.grantsLaunch()).toBe(false);
    expect(grantsLaunch(revoked)).toBe(false);
  });
});

describe("the panel of the connection", () => {
  it("shows the state of the connection without promising anything", () => {
    expect(connectionStateText(null)).toContain("не настроено");
    expect(connectionStateText({ state: "connected", centerUrl: "https://center.example", purpose: "noticeplace.health-analysis" }))
      .toContain("https://center.example");
    const revoked = connectionStateText({ state: "revoked", revokedAt: "2026-10-23T10:00:00.000Z" });
    expect(revoked).toContain("отозвано");
    // The record does not say that the center lost the permission: the panel
    // says what the probe of the revocation saw.
    expect(revoked).not.toContain("больше не получает разрешение");
  });

  it("keeps the three answers of the check apart", () => {
    const text = checkText({
      reachable: true,
      authorized: true,
      compatible: false,
      detail: "контракт центра не подтверждён.",
    });
    expect(text).toContain("центр ответил");
    expect(text).toContain("авторизация принята");
    expect(text).toContain("совместимость не подтверждена");
  });

  it("tells the truth about the effect of the revocation", () => {
    expect(revokeEffectText({ status: 401, code: "connection_revoked" })).toContain("Отзыв действует");
    const notWired = revokeEffectText({ status: 401, error: "Для анализа инцидента нужен отдельный токен Notice Place." });
    expect(notWired).toContain("ещё получает разрешение");
    expect(notWired).not.toContain("Отзыв действует");
  });

  it("probes the route of the launch without a key that can authorize anything", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const probe = await probeRevokedLaunch((async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ error: "Подключение к центру отозвано.", code: "connection_revoked" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/automation/project-launch");
    // The key of the probe is a constant that can never be the key of the
    // center, and the body names no executor: the route refuses it.
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer herder-panel-revocation-probe");
    expect(String(calls[0]?.init?.body)).not.toContain("harness");
    expect(String(calls[0]?.init?.body)).not.toContain("model");
    expect(probe.status).toBe(401);
    expect(probe.code).toBe("connection_revoked");
  });
});
