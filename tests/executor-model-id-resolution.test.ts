import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  OPENCODE_MODEL_CATALOG_SOURCE,
  OpenCodeAdapter,
  resolveOpenCodeDispatchableModel,
  type OpenCodeCatalogModel,
} from "../src/adapters/opencode.js";

/**
 * The live catalog shape of the deployed OpenCode instance: the key OpenCode
 * accepts is the catalog key, the gateway id behind it is the `modelID`.
 */
const CATALOG: OpenCodeCatalogModel[] = [
  { providerId: "omniroute", id: "minimax/MiniMax-M3.1-Flash", modelId: "minimax-combo-m3.1" },
  { providerId: "omniroute", id: "minimax/MiniMax-M3", modelId: "minimax-combo-m3" },
  { providerId: "omniroute", id: "glm-5.3-flash-minimax-m3.1", modelId: "glm-5.3-flash-minimax-m3.1" },
  { providerId: "opencode", id: "gpt-5.3-codex", modelId: "gpt-5.3-codex" },
];

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

interface RecordedRequest {
  method: string;
  path: string;
  body: string;
}

/** A stand-in for the live OpenCode server: the model catalog and the two write endpoints. */
async function startOpenCodeStub(): Promise<{ baseUrl: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const path = request.url ?? "";
      requests.push({ method: request.method ?? "", path, body });
      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (request.method === "GET" && path === "/api/model") {
        return send(200, { data: CATALOG.map((entry) => ({ providerID: entry.providerId, id: entry.id, modelID: entry.modelId })) });
      }
      if (request.method === "POST" && path === "/api/session") {
        const parsed = body ? JSON.parse(body) as { title?: string; location?: { directory?: string } } : {};
        return send(200, { id: "ses_stub", title: parsed.title, location: { directory: parsed.location?.directory ?? "/tmp" } });
      }
      if (request.method === "POST" && /^\/api\/session\/[^/]+\/model$/u.test(path)) return send(200, { id: "ses_stub" });
      return send(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

/** The read-only OmniRoute catalog the route-proof gate reads. */
const OMNIROUTE_RESPONSES: Record<string, unknown> = {
  "http://127.0.0.1:20128/v1/models": {
    data: [
      { id: "minimax-combo-m3.1", owned_by: "combo", root: "minimax-combo-m3.1", parent: null },
      { id: "mmcode/MiniMax-M3.1-Flash", owned_by: "minimax-code", root: "mmcode/MiniMax-M3.1-Flash" },
    ],
  },
  "http://127.0.0.1:20128/api/model-combo-mappings": { total: 0, mappings: [] },
  "http://127.0.0.1:20128/api/models/alias": { aliases: {} },
  "http://127.0.0.1:20128/api/combos": {
    total: 1,
    combos: [{ id: "combo-1", name: "minimax-combo-m3.1", models: [{ providerId: "minimax-code", model: "mmcode/MiniMax-M3.1-Flash" }] }],
  },
};

const omniRouteFetcher: typeof fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
  const payload = OMNIROUTE_RESPONSES[url];
  if (!payload) throw new Error(`unexpected OmniRoute read: ${url}`);
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
};

describe("executor model id resolution", () => {
  it("translates a native route id into the catalog key OpenCode dispatches", () => {
    const resolution = resolveOpenCodeDispatchableModel(CATALOG, "omniroute/minimax-combo-m3.1");
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.kind).toBe("native-route");
    expect(resolution.dispatchable).toBe("omniroute/minimax/MiniMax-M3.1-Flash");
    expect(resolution.nativeRoute).toBe("omniroute/minimax-combo-m3.1");
    expect(resolution.candidates).toEqual(["minimax/MiniMax-M3.1-Flash"]);
  });

  it("passes a catalog key through unchanged", () => {
    const resolution = resolveOpenCodeDispatchableModel(CATALOG, "omniroute/minimax/MiniMax-M3.1-Flash");
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.kind).toBe("catalog-key");
    expect(resolution.dispatchable).toBe("omniroute/minimax/MiniMax-M3.1-Flash");
    expect(resolution.candidates).toEqual(["minimax/MiniMax-M3.1-Flash"]);
  });

  it("passes a route whose native id is also its catalog key through unchanged", () => {
    const resolution = resolveOpenCodeDispatchableModel(CATALOG, "omniroute/glm-5.3-flash-minimax-m3.1");
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.kind).toBe("catalog-key");
    expect(resolution.dispatchable).toBe("omniroute/glm-5.3-flash-minimax-m3.1");
  });

  it("fails closed with a bounded reason when no catalog entry serves the native id", () => {
    const resolution = resolveOpenCodeDispatchableModel(CATALOG, "omniroute/minimax-combo-m9.9");
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toContain("omniroute/minimax-combo-m9.9");
    expect(resolution.reason).toContain("minimax-combo-m9.9");
    expect(resolution.reason).toContain(OPENCODE_MODEL_CATALOG_SOURCE);
    expect(resolution.reason.length).toBeLessThan(400);
  });

  it("picks deterministically and names every candidate when several keys share a native id", () => {
    const ambiguous: OpenCodeCatalogModel[] = [
      ...CATALOG,
      { providerId: "omniroute", id: "aaa/First-Key", modelId: "minimax-combo-m3.1" },
    ];
    const resolution = resolveOpenCodeDispatchableModel(ambiguous, "omniroute/minimax-combo-m3.1");
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.candidates).toEqual(["aaa/First-Key", "minimax/MiniMax-M3.1-Flash"]);
    expect(resolution.dispatchable).toBe("omniroute/aaa/First-Key");
  });

  it("starts a session with the catalog key when the caller names the route form", async () => {
    const stub = await startOpenCodeStub();
    const adapter = new OpenCodeAdapter({ baseUrl: stub.baseUrl, password: "test", protocol: "v2" });
    await adapter.createSession({ name: "executor", cwd: "/tmp", model: "omniroute/minimax-combo-m3.1" });
    const create = stub.requests.find((request) => request.method === "POST" && request.path === "/api/session");
    expect(create).toBeDefined();
    expect(JSON.parse(create!.body).model).toEqual({ providerID: "omniroute", id: "minimax/MiniMax-M3.1-Flash" });
  });

  it("switches a session to the catalog key when the caller names the route form", async () => {
    const stub = await startOpenCodeStub();
    const adapter = new OpenCodeAdapter({ baseUrl: stub.baseUrl, password: "test", protocol: "v2" });
    const result = await adapter.changeModel("ses_stub", "omniroute/minimax-combo-m3.1");
    expect(result.ok).toBe(true);
    const switchRequest = stub.requests.find((request) => request.method === "POST" && request.path.endsWith("/model"));
    expect(switchRequest).toBeDefined();
    expect(JSON.parse(switchRequest!.body).model).toEqual({ providerID: "omniroute", id: "minimax/MiniMax-M3.1-Flash" });
  });

  it("fails closed without reaching OpenCode when the native id is unknown", async () => {
    const stub = await startOpenCodeStub();
    const adapter = new OpenCodeAdapter({ baseUrl: stub.baseUrl, password: "test", protocol: "v2" });
    const result = await adapter.changeModel("ses_stub", "omniroute/minimax-combo-m9.9");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("omniroute/minimax-combo-m9.9");
    expect(result.error).toContain(OPENCODE_MODEL_CATALOG_SOURCE);
    expect(stub.requests.some((request) => request.method === "POST" && request.path.endsWith("/model"))).toBe(false);
  });

  it("passes the id through unchanged when the catalog cannot be read", async () => {
    const requests: RecordedRequest[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requests.push({ method: request.method ?? "", path: request.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not found" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const adapter = new OpenCodeAdapter({ baseUrl: `http://127.0.0.1:${port}`, password: "test", protocol: "v2" });
    await adapter.changeModel("ses_stub", "omniroute/minimax-combo-m3.1");
    const switchRequest = requests.find((request) => request.method === "POST" && request.path.endsWith("/model"));
    expect(switchRequest).toBeDefined();
    expect(JSON.parse(switchRequest!.body).model).toEqual({ providerID: "omniroute", id: "minimax-combo-m3.1" });
  });

  it("keeps the route-proof gate on the native route", async () => {
    const stub = await startOpenCodeStub();
    const adapter = new OpenCodeAdapter({ baseUrl: stub.baseUrl, password: "test", protocol: "v2" });
    const proof = await adapter.resolveModelProviderLeaves("omniroute/minimax-combo-m3.1", {
      omniRouteBaseUrl: "http://127.0.0.1:20128",
      omniRouteApiKey: "test",
      fetcher: omniRouteFetcher,
    });
    expect(proof?.nativeHarness).toBe("opencode");
    expect(proof?.nativeModelId).toBe("omniroute/minimax-combo-m3.1");
    expect(proof?.resolvedProviderLeaves).toEqual([{ providerId: "minimax-code", modelId: "mmcode/MiniMax-M3.1-Flash" }]);
    // The gate verifies the native route only. The translated catalog key is
    // never what the gate is asked to prove.
    const translated = await adapter.resolveModelProviderLeaves("omniroute/minimax/MiniMax-M3.1-Flash", {
      omniRouteBaseUrl: "http://127.0.0.1:20128",
      omniRouteApiKey: "test",
      fetcher: omniRouteFetcher,
    });
    expect(translated).toBeNull();
  });
});
