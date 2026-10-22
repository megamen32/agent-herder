import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadFallbackModelPolicy,
  saveFallbackModelPolicy,
  fallbackModelIssue,
  fallbackModelsSaveIssue,
  FallbackModelsControls,
  moveFallbackModel,
  normalizeFallbackModelMap,
} from "../src/web-ui/fallback-models-controls.js";

afterEach(() => vi.unstubAllGlobals());

describe("OmniRoute fallback model controls", () => {
  it("preserves ordered full model identifiers for both harnesses", () => {
    const markup = renderToStaticMarkup(React.createElement(FallbackModelsControls, {
      fallbackModels: {
        opencode: ["omniroute/test-provider/model-a", "omniroute/test-provider/model-b"],
        zcode: ["omniroute/test-provider/model-c"],
      },
      currentModels: { opencode: "omniroute/test-provider/current-a", zcode: "omniroute/test-provider/current-b" },
      onChange: () => undefined,
    }));
    expect(markup.indexOf("omniroute/test-provider/model-a")).toBeLessThan(markup.indexOf("omniroute/test-provider/model-b"));
    expect(markup).toContain("omniroute/test-provider/model-c");
    expect(markup).toContain("Модель в общей политике");
    expect(markup).toContain("Текущая модель и повторы будут пропущены.");
  });

  it("only allows reordering within the configured list", () => {
    const models = ["one/model", "two/model", "three/model"];
    expect(moveFallbackModel(models, 1, -1)).toEqual(["two/model", "one/model", "three/model"]);
    expect(moveFallbackModel(models, 0, -1)).toBe(models);
    expect(moveFallbackModel(models, 2, 1)).toBe(models);
  });

  it("requires full provider/model identifiers without changing duplicate/current skip semantics", () => {
    expect(fallbackModelIssue("  ")).toMatch(/полный OmniRoute ID/i);
    expect(fallbackModelIssue("model-only")).toMatch(/провайдер\/модель/i);
    expect(fallbackModelIssue("omniroute/test-provider/model")).toBeUndefined();
  });

  it("accepts the two-segment form of a live OmniRoute id", () => {
    expect(fallbackModelIssue("omniroute/minimax-combo-m3.1")).toBeUndefined();
    expect(fallbackModelIssue("omniroute/test-provider/model")).toBeUndefined();
    expect(fallbackModelsSaveIssue({ opencode: ["omniroute/minimax-combo-m3.1"] })).toBeUndefined();
    expect(fallbackModelIssue("model-only")).toMatch(/провайдер\/модель/i);
  });

  it("allows the MiniMax subscription route in the fallback list and refuses a foreign provider", () => {
    expect(fallbackModelIssue("minimax-coding-plan/MiniMax-M3.1-Flash")).toBeUndefined();
    expect(fallbackModelIssue("omniroute/minimax-coding-plan/MiniMax-M3.1-Flash")).toBeUndefined();
    expect(fallbackModelsSaveIssue({ opencode: ["minimax-coding-plan/MiniMax-M3.1-Flash"] })).toBeUndefined();
    expect(fallbackModelIssue("zai/GLM-4.6")).toBeTruthy();
  });

  it("loads fallback choices with the launch policy document version", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      version: 1,
      allowedHarnesses: ["opencode", "zcode"],
      preferredHarness: "opencode",
      models: { opencode: "omniroute/test-provider/current", zcode: "omniroute/test-provider/current-z" },
      fallbackModels: { opencode: ["omniroute/test-provider/next"] },
      projectRoutes: { "/project": { harnesses: ["opencode"] } },
    }), { status: 200, headers: { etag: '"policy-v3"', "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await expect(loadFallbackModelPolicy()).resolves.toMatchObject({
      etag: '"policy-v3"',
      fallbackModels: { opencode: ["omniroute/test-provider/next"] },
      currentModels: { opencode: "omniroute/test-provider/current", zcode: "omniroute/test-provider/current-z" },
      policy: { projectRoutes: { "/project": { harnesses: ["opencode"] } } },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/automation/launch-policy");
  });

  it("saves only the fallback field over the exact policy version", async () => {
    const fetch = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(body), { status: 200, headers: { etag: '"policy-v4"', "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    const policy = {
      version: 1,
      allowedHarnesses: ["opencode", "zcode"],
      preferredHarness: "opencode",
      models: { opencode: "omniroute/test-provider/current", zcode: "omniroute/test-provider/current-z" },
      projectRoutes: { "/project": { harnesses: ["opencode"] } },
    };

    const result = await saveFallbackModelPolicy({
      policy,
      etag: '"policy-v3"',
      fallbackModels: {},
      currentModels: policy.models,
    }, { opencode: ["omniroute/test-provider/next", " OMNIROUTE/TEST-PROVIDER/NEXT "] });

    expect(result.kind).toBe("saved");
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe("/api/automation/launch-policy");
    expect(init?.headers).toMatchObject({ "if-match": '"policy-v3"' });
    expect(JSON.parse(String(init?.body))).toEqual({ ...policy, fallbackModels: { opencode: ["omniroute/test-provider/next"] } });
    if (result.kind === "saved") expect(result.document.etag).toBe('"policy-v4"');
  });

  it("sends an explicit empty map when clearing all fallback models", async () => {
    const fetch = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(body), { status: 200, headers: { etag: '"policy-v5"', "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    const result = await saveFallbackModelPolicy({
      policy: {
        version: 1,
        allowedHarnesses: ["opencode", "zcode"],
        preferredHarness: "opencode",
        models: {},
        fallbackModels: { opencode: ["omniroute/provider/old"] },
      },
      etag: '"policy-v4"',
      fallbackModels: { opencode: ["omniroute/provider/old"] },
      currentModels: {},
    }, {});

    expect(result.kind).toBe("saved");
    const [, init] = fetch.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      version: 1,
      allowedHarnesses: ["opencode", "zcode"],
      preferredHarness: "opencode",
      models: {},
      fallbackModels: {},
    });
  });

  it("preserves duplicate and current-model skip semantics while blocking incomplete model IDs", () => {
    expect(fallbackModelsSaveIssue({ opencode: ["", "omniroute/test-provider/current"] })).toMatch(/полный OmniRoute ID/i);
    expect(fallbackModelsSaveIssue({ opencode: ["omniroute/test-provider/current", "omniroute/test-provider/current"] })).toBeUndefined();
    expect(fallbackModelsSaveIssue({ zcode: Array.from({ length: 9 }, (_, index) => `omniroute/test-provider/${index}`) })).toMatch(/не более 8/);
    expect(normalizeFallbackModelMap({ opencode: [" omniroute/test-provider/a ", "OMNIROUTE/test-provider/A", "omniroute/test-provider/b"] })).toEqual({
      opencode: ["omniroute/test-provider/a", "omniroute/test-provider/b"],
    });
  });

  it("allows eight unique models plus a duplicate and saves the normalized eight", async () => {
    const models = Array.from({ length: 8 }, (_, index) => `omniroute/test-provider/model-${index}`);
    const draft = [...models, ` ${models[0]!.toLocaleUpperCase("en-US")} `];
    expect(fallbackModelsSaveIssue({ zcode: draft })).toBeUndefined();

    const fetch = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => new Response(String(init?.body), {
      status: 200,
      headers: { etag: '"policy-v2"', "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);
    const policy = {
      version: 1,
      allowedHarnesses: ["opencode", "zcode"],
      preferredHarness: "opencode",
      models: { opencode: "omniroute/test-provider/current" },
    };
    const result = await saveFallbackModelPolicy({ policy, etag: '"policy-v1"', fallbackModels: {}, currentModels: {} }, { zcode: draft });

    expect(result.kind).toBe("saved");
    const [, init] = fetch.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ fallbackModels: { zcode: models } });
  });
});
