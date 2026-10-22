import { describe, expect, it } from "vitest";

import {
  resolveOpenCodeDispatchableModel,
  type OpenCodeCatalogModel,
} from "../src/adapters/opencode.js";
import {
  MODEL_STATUS_WORDS,
  MODEL_VERDICT_LABELS,
  PAID_ROUTE_PATTERNS,
  explainModelListError,
  hasRestrictedProviderToken,
  isPaidRoute,
  modelVerdict,
  unusedListEntries,
  workingModelId,
} from "../src/web-ui/model-status.js";
import { setRouteModel } from "../src/web-ui/projects-settings.js";
import type { ProjectLaunchRoute } from "../src/web-ui/launch-policy-settings.js";

/**
 * The status of a model for the owner.
 *
 * The panel tells three things apart: what the environment sends, what the
 * lists of the project allow, and what the rule of the owner closes.
 */

/**
 * The live catalog of the deployed OpenCode, in the shape the adapter reads.
 *
 * The entries are the ones of the running instance: the key OpenCode accepts
 * (`id`) and the gateway id behind it (`modelId`).
 */
const LIVE_CATALOG: OpenCodeCatalogModel[] = [
  { providerId: "omniroute", id: "minimax/MiniMax-M3.1-Flash", modelId: "minimax-combo-m3.1" },
  { providerId: "omniroute", id: "minimax/MiniMax-M3", modelId: "minimax-combo-m3" },
  { providerId: "omniroute", id: "cx/gpt-6.1-sol", modelId: "cx/gpt-6.1-sol" },
  { providerId: "minimax-coding-plan", id: "MiniMax-M3.1-Flash", modelId: "MiniMax-M3.1-Flash" },
  { providerId: "zai-coding-plan", id: "glm-5.3-flash", modelId: "glm-5.3-flash" },
  { providerId: "opencode", id: "gpt-6.1-sol", modelId: "gpt-6.1-sol" },
  { providerId: "opencode", id: "flint-40b-free", modelId: "flint-40b-free" },
];

/** What `/api/models` hands to the panel: both spellings of every entry. */
const PANEL_MODELS = [...new Set(LIVE_CATALOG.flatMap((entry) => [
  `${entry.providerId}/${entry.id}`,
  `${entry.providerId}/${entry.modelId}`,
]))];

const OPENCODE_ENVIRONMENT = [
  "omniroute/minimax-combo-m3.1",
  "omniroute/minimax/MiniMax-M3.1-Flash",
  "minimax-coding-plan/MiniMax-M3.1-Flash",
  "opencode/gpt-6.1-sol",
];

describe("what the environment says about a model", () => {
  it("calls a confirmed model working", () => {
    const verdict = modelVerdict({
      harness: "opencode",
      model: "omniroute/minimax-combo-m3.1",
      confirmed: OPENCODE_ENVIRONMENT,
    });
    expect(verdict.kind).toBe("works");
    expect(verdict.label).toBe(MODEL_VERDICT_LABELS.works);
    expect(verdict.tone).toBe("ok");
    expect(verdict.action).toBe("");
  });

  it("calls an id of the environment that it does not know unconfirmed", () => {
    const verdict = modelVerdict({
      harness: "opencode",
      model: "omniroute/minimax-combo-m9.9",
      confirmed: OPENCODE_ENVIRONMENT,
    });
    expect(verdict.kind).toBe("unconfirmed");
    expect(verdict.label).toBe("Среда не подтверждает этот id");
    expect(verdict.tone).toBe("warn");
    // The action names the button and the id that goes with it.
    expect(verdict.action).toContain("Поставить рабочую модель");
    expect(verdict.action).toContain("omniroute/minimax-combo-m3.1");
  });

  it("does not blame a model when the environment confirmed nothing at all", () => {
    const verdict = modelVerdict({
      harness: "opencode",
      model: "omniroute/minimax-combo-m3.1",
      confirmed: [],
    });
    expect(verdict.kind).toBe("noModels");
    expect(verdict.label).toBe("Среда не подтвердила ни одной модели");
    expect(verdict.tone).toBe("unknown");
  });

  it("calls a plan of the OpenCode environment a paid route and names the working one", () => {
    const verdict = modelVerdict({
      harness: "opencode",
      model: "minimax-coding-plan/MiniMax-M3.1-Flash",
      confirmed: OPENCODE_ENVIRONMENT,
      workingModel: "omniroute/minimax-combo-m3.1",
    });
    expect(verdict.kind).toBe("paid");
    expect(verdict.label).toBe("Платный маршрут — среда его не отправляет");
    expect(verdict.worksInstead).toBe("omniroute/minimax-combo-m3.1");
    expect(verdict.paid).toBe(true);
  });

  it("knows the plans of the environment", () => {
    expect(isPaidRoute("minimax-coding-plan/MiniMax-M3.1-Flash")).toBe(true);
    expect(isPaidRoute("zai-coding-plan/glm-5.3")).toBe(true);
    expect(isPaidRoute("account:zai-individual-coding-plan/GLM-5.3-Flash$high")).toBe(true);
    expect(isPaidRoute("builtin:zai-coding-plan/GLM-5.3-Flash")).toBe(true);
    expect(isPaidRoute("omniroute/minimax-combo-m3.1")).toBe(false);
    expect(isPaidRoute("opencode/gpt-6.1-sol")).toBe(false);
  });
});

describe("what the rule of the owner says about a model", () => {
  it("closes codex, claude and anthropic in a closed project", () => {
    expect(hasRestrictedProviderToken("codex/gpt-6.1-sol")).toBe(true);
    expect(hasRestrictedProviderToken("opencode/claude-opus-5-5")).toBe(true);
    expect(hasRestrictedProviderToken("anthropic/claude-opus-5-5")).toBe(true);
    expect(hasRestrictedProviderToken("omniroute/minimax-combo-m3.1")).toBe(false);

    const verdict = modelVerdict({
      harness: "opencode",
      model: "codex/gpt-6.1-sol",
      confirmed: OPENCODE_ENVIRONMENT,
      restricted: true,
    });
    expect(verdict.kind).toBe("closed");
    expect(verdict.label).toBe("Закрыт правилом владельца");
    expect(verdict.tone).toBe("error");
    expect(verdict.reason).toContain("codex");
  });
});

describe("what the lists of the project say about a model", () => {
  it("sees a model of the denied list", () => {
    const verdict = modelVerdict({
      harness: "opencode",
      model: "omniroute/minimax-combo-m3.1",
      confirmed: OPENCODE_ENVIRONMENT,
      deniedModels: ["omniroute/minimax-*"],
    });
    expect(verdict.kind).toBe("denied");
    expect(verdict.label).toBe("Запрещена в списке проекта");
    expect(verdict.tone).toBe("error");
  });

  it("sees a model that the allowed list does not name", () => {
    const verdict = modelVerdict({
      harness: "opencode",
      model: "omniroute/minimax-combo-m3.1",
      confirmed: OPENCODE_ENVIRONMENT,
      allowedModels: ["opencode/gpt-6.1-sol"],
    });
    expect(verdict.kind).toBe("notAllowed");
    expect(verdict.label).toBe("Нет в списке разрешённых проекта");
    expect(verdict.tone).toBe("error");
  });

  it("lets a model through when the allowed list names it", () => {
    const verdict = modelVerdict({
      harness: "opencode",
      model: "omniroute/minimax-combo-m3.1",
      confirmed: OPENCODE_ENVIRONMENT,
      allowedModels: ["*"],
    });
    expect(verdict.kind).toBe("works");
  });

  it("finds the entries of the list that match no model of the environment", () => {
    expect(unusedListEntries(["все модели"], OPENCODE_ENVIRONMENT)).toEqual(["все модели"]);
    expect(unusedListEntries(["*"], OPENCODE_ENVIRONMENT)).toEqual([]);
    expect(unusedListEntries(["omniroute/minimax-combo-m3.1"], OPENCODE_ENVIRONMENT)).toEqual([]);
    expect(unusedListEntries(["omniroute/minimax-*"], OPENCODE_ENVIRONMENT)).toEqual([]);
    expect(unusedListEntries(["account:*"], OPENCODE_ENVIRONMENT)).toEqual(["account:*"]);
  });
});

describe("the working model of a harness", () => {
  it("takes the route of the product when the environment confirms it", () => {
    expect(workingModelId("opencode", { confirmed: OPENCODE_ENVIRONMENT })).toBe("omniroute/minimax-combo-m3.1");
  });

  it("takes the common model of the harness when the product has no route for it", () => {
    expect(workingModelId("zcode", {
      policyModels: { zcode: "account:zai-individual-coding-plan/GLM-5.3-Flash$high" },
      confirmed: ["account:zai-individual-coding-plan/GLM-5.3-Flash$high"],
    })).toBe("account:zai-individual-coding-plan/GLM-5.3-Flash$high");
  });

  it("offers nothing when the environment confirms nothing", () => {
    expect(workingModelId("opencode", { confirmed: [] })).toBe("");
  });
});

describe("the one-click actions of the panel", () => {
  it("writes the model into the route of that harness only", () => {
    const route: ProjectLaunchRoute = {
      harnesses: ["opencode", "zcode"],
      models: { zcode: "account:zai-individual-coding-plan/GLM-5.3-Flash$high" },
    };
    const next = setRouteModel(route, "opencode", "omniroute/minimax-combo-m3.1");
    expect(next.models?.opencode).toBe("omniroute/minimax-combo-m3.1");
    // The model of the other harness stays as it was.
    expect(next.models?.zcode).toBe("account:zai-individual-coding-plan/GLM-5.3-Flash$high");
    expect(next.harnesses).toEqual(["opencode", "zcode"]);
  });

  it("names the patterns of the paid routes it writes into the denied list", () => {
    expect(PAID_ROUTE_PATTERNS).toContain("minimax-coding-plan/*");
    expect(PAID_ROUTE_PATTERNS).toContain("account:*");
    expect(PAID_ROUTE_PATTERNS).toContain("builtin:*");
  });
});

describe("the errors of the server about the lists of models", () => {
  it("explains every known message in Russian and says what to do", () => {
    expect(explainModelListError("Project route '/p' allowedModels must be an array"))
      .toContain("«Разрешённые модели»");
    expect(explainModelListError("Project route '/p' allowedModels must not hold more than 64 models"))
      .toContain("64");
    expect(explainModelListError("Project route '/p' allowedModels entries must be nonempty model IDs"))
      .toContain("пустая строка");
    expect(explainModelListError("Project route '/p' deniedModels entries must be at most 256 characters"))
      .toContain("256");
    expect(explainModelListError("Project route '/p' allowedModels entries must not contain control characters"))
      .toContain("служебные символы");
    expect(explainModelListError("Project route '/p' repeats model 'a' in allowedModels"))
      .toContain("«a»");
    expect(explainModelListError("Project route '/p' lists model 'a' as allowed and as denied at the same time. Remove it from one of the lists."))
      .toContain("Уберите её из одного списка");
  });

  it("keeps an unknown message as it is", () => {
    expect(explainModelListError("something else entirely")).toBe("something else entirely");
  });
});

describe("the short status of a model in the list of the suggestions", () => {
  it("is one word", () => {
    expect(MODEL_STATUS_WORDS.works).toBe("Работает");
    expect(MODEL_STATUS_WORDS.unconfirmed).toBe("Не подтверждена");
    expect(MODEL_STATUS_WORDS.paid).toBe("Платная");
    expect(MODEL_STATUS_WORDS.closed).toBe("Закрыта правилом");
  });
});

describe("the panel and the adapter agree about the live catalog of OpenCode", () => {
  it("never calls a model unknown when the adapter can dispatch it", () => {
    for (const id of PANEL_MODELS) {
      const resolution = resolveOpenCodeDispatchableModel(LIVE_CATALOG, id);
      const verdict = modelVerdict({ harness: "opencode", model: id, confirmed: PANEL_MODELS });
      expect(resolution.ok, `${id} must be dispatchable`).toBe(true);
      expect(verdict.kind, `${id} must not be called unknown`).not.toBe("unconfirmed");
    }
  });

  it("calls an id of no catalog unknown", () => {
    const resolution = resolveOpenCodeDispatchableModel(LIVE_CATALOG, "omniroute/minimax-combo-m9.9");
    expect(resolution.ok).toBe(false);
    const verdict = modelVerdict({
      harness: "opencode",
      model: "omniroute/minimax-combo-m9.9",
      confirmed: PANEL_MODELS,
    });
    expect(verdict.kind).toBe("unconfirmed");
  });

  it("says that a plan of the environment is a plan, even when the catalog has its key", () => {
    // The catalog of the environment holds the key of the plan, so the adapter
    // can dispatch it. The plan is still not a route of Herder: it has its own
    // subscription and its own quota, so the panel names it as a plan instead
    // of promising that it rides.
    const resolution = resolveOpenCodeDispatchableModel(LIVE_CATALOG, "minimax-coding-plan/MiniMax-M3.1-Flash");
    expect(resolution.ok).toBe(true);
    const verdict = modelVerdict({
      harness: "opencode",
      model: "minimax-coding-plan/MiniMax-M3.1-Flash",
      confirmed: PANEL_MODELS,
      workingModel: "omniroute/minimax-combo-m3.1",
    });
    expect(verdict.kind).toBe("paid");
    expect(verdict.worksInstead).toBe("omniroute/minimax-combo-m3.1");
  });
});
