import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAUNCH_POLICY,
  incidentModelIssue,
  incidentModelRoute,
  modelCatalogIssue,
  modelValueIssue,
  updateAllowedHarness,
  updatePreferredHarness,
  updateProjectRoute,
  updateProjectRouteModel,
  removeProjectRouteHarness,
  type LaunchPolicy,
} from "../src/web-ui/launch-policy-settings.js";
import { resolveProjectLaunch, validateAutomationLaunchPolicy } from "../src/automation-launch-policy.js";

const component = readFileSync(new URL("../src/web-ui/launch-policy-settings.tsx", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/web-ui/main.tsx", import.meta.url), "utf8");

describe("new session launch policy settings", () => {
  it("points Notice Place incident model choice to its admin and explains Herder's launch role", () => {
    expect(component).toContain('href="https://notify.bezrabotnyi.com/admin/#health-model"');
    expect(component).toContain("Модель для анализа инцидентов Notice Place выбирается в");
    expect(component).toContain("Herder проверяет допустимость запуска и запускает сессию.");
    expect(component).toContain("Поля ниже задают локальный маршрут Herder и не меняют выбор модели в Notice Place.");
    expect(component).toContain("<legend>Локальный маршрут инцидентов Herder</legend>");
    expect(component).not.toContain("Диагностика и исправление инцидентов Noticeplace");
    expect(component).not.toContain("Этот выбор сохраняется отдельно для новых расследований и исправлений.");
  });
  it.each(["", "   "])("clears route override %j and saves the inherited global model through production validation", (empty) => {
    const project = "/project";
    const draft = { ...DEFAULT_LAUNCH_POLICY, projectRoutes: { [project]: {
      harnesses: ["codex", "zcode"], aliases: ["card"], models: { codex: "custom", zcode: "keep" },
    } } };
    const next = updateProjectRoute(draft, project, (route) => updateProjectRouteModel(route, "codex", empty));
    expect(next.projectRoutes?.[project]?.models).toEqual({ zcode: "keep" });
    const saved = validateAutomationLaunchPolicy(JSON.parse(JSON.stringify(next)));
    expect(resolveProjectLaunch(saved, { project: "card" })).toMatchObject({ kind: "launch", model: draft.models.codex });
    expect(draft.projectRoutes[project].models.codex).toBe("custom");
  });

  it("removes the harness override with its route entry and saves without unused-harness rejection", () => {
    const project = "/project";
    const draft = { ...DEFAULT_LAUNCH_POLICY, projectRoutes: { [project]: {
      harnesses: ["codex", "zcode"], aliases: ["card"], models: { codex: "custom", zcode: "keep" },
    } } };
    const next = updateProjectRoute(draft, project, (route) => removeProjectRouteHarness(route, "codex"));
    expect(next.projectRoutes?.[project]).toEqual({ harnesses: ["zcode"], aliases: ["card"], models: { zcode: "keep" } });
    expect(validateAutomationLaunchPolicy(next).projectRoutes?.[project]?.harnesses).toEqual(["zcode"]);
    expect(draft.projectRoutes[project].models.codex).toBe("custom");
  });
  it("starts with the requested explicit draft without changing the persisted policy", () => {
    expect(DEFAULT_LAUNCH_POLICY).toEqual({
      version: 1,
      allowedHarnesses: ["codex", "zcode"],
      preferredHarness: "codex",
      models: {
        // The live policy values are the draft default; an explicit draft never
        // rewrites a configured route model.
        codex: "gpt-6.1-sol",
        zcode: "account:zai-individual-coding-plan/GLM-5.3-Flash$high",
      },
    });
  });

  it("keeps an empty allowlist disabled and remembers the preferred runtime", () => {
    const noCodex = updateAllowedHarness(DEFAULT_LAUNCH_POLICY, "codex", false);
    expect(noCodex).toMatchObject({ allowedHarnesses: ["zcode"], preferredHarness: "zcode" });
    const disabled = updateAllowedHarness(noCodex, "zcode", false);
    expect(disabled.allowedHarnesses).toEqual([]);
    expect(disabled.preferredHarness).toBe("zcode");
  });

  it("does not switch a preferred runtime to one that is not allowed", () => {
    const switched = updatePreferredHarness(DEFAULT_LAUNCH_POLICY, "zcode");
    expect(switched.preferredHarness).toBe("zcode");
    expect(switched.allowedHarnesses).toEqual(DEFAULT_LAUNCH_POLICY.allowedHarnesses);
    expect(switched.models).toEqual(DEFAULT_LAUNCH_POLICY.models);
    expect(updatePreferredHarness(switched, "opencode")).toBe(switched);
  });

  it("loads and saves only through the launch-policy API with an explicit save action", () => {
    expect(component).toContain('requestJson<{ adapters?: Array<{ id: string; name: string; active: boolean }> }>("/api/adapters")');
    expect(component).toContain(".filter((item) => item.active)");
    expect(component).toContain("/api/models?harness=");
    expect(component).toContain("Настройки запуска ещё не сохранены");
    expect(component).toContain("До сохранения автоматический запуск новых сессий запрещён.");
    expect(component).toContain("Автоматический запуск новых сессий отключён.");
    expect(component).toContain('disabled={!valid || saving || loading || Boolean(loadError)}');
    expect(component).not.toContain("/api/sessions");
  });

  it("writes the whole document only over the version it was read from", () => {
    expect(component).toContain('fetch("/api/automation/launch-policy"');
    expect(component).toContain('"/api/automation/launch-policy"');
    expect(component).toContain('method: "PUT"');
    expect(component).toContain("body: JSON.stringify(policy)");
    expect(component).toContain('"if-match": etag');
    expect(component).toContain("response.status === 412");
    // A broken document is not a missing one: only an absent one may be created.
    expect(component).toContain('state === "absent"');
    expect(component).toContain('state === "invalid"');
    expect(component).toContain("Политика запуска повреждена");
  });

  it("keeps the draft and reports a conflict instead of overwriting a newer policy", () => {
    expect(component).toContain("Политика запуска изменилась в другой вкладке");
    expect(component).toContain("Обновить и применить заново");
    expect(component).toContain("mergePolicyChanges");
  });

  it("lets the operator type the incident model and warns about an unknown one", () => {
    const incident = { runtime: "opencode", provider: "omniroute", model: "omniroute/hand-typed-model", reasoning: "default", topic: "health" } as const;
    const policy: LaunchPolicy = { ...DEFAULT_LAUNCH_POLICY, incidentExecution: incident };
    expect(incidentModelRoute(policy)).toBe("omniroute/hand-typed-model");
    // The owner is the authority: a model outside the catalog is saved as it is.
    expect(incidentModelIssue("omniroute/hand-typed-model")).toBeUndefined();
    expect(modelCatalogIssue("opencode", "omniroute/hand-typed-model", ["omniroute/minimax-combo-m3.1"])).toContain("не найдена в каталоге harness");
    expect(modelCatalogIssue("opencode", "omniroute/hand-typed-model", ["omniroute/hand-typed-model"])).toBeUndefined();
    // An empty catalog carries no verdict about the model.
    expect(modelCatalogIssue("opencode", "omniroute/hand-typed-model", [])).toBeUndefined();
  });

  it("allows the MiniMax subscription route and refuses a provider substitution", () => {
    expect(modelValueIssue("minimax-coding-plan/MiniMax-M3.1-Flash")).toBeUndefined();
    expect(modelValueIssue("omniroute/minimax/MiniMax-M3.1-Flash")).toBeUndefined();
    expect(incidentModelIssue("minimax-coding-plan/MiniMax-M3.1-Flash")).toBeUndefined();
    expect(incidentModelIssue("zai/GLM-4.6")).toBeTruthy();
    expect(incidentModelIssue("omniroute/minimax-combo-m3.1")).toBeUndefined();
  });

  it("saves a hand-typed incident model through the production validation", () => {
    const draft = { ...DEFAULT_LAUNCH_POLICY, incidentExecution: { runtime: "opencode", provider: "omniroute", model: "omniroute/hand-typed-model", reasoning: "default", topic: "health" } };
    const saved = validateAutomationLaunchPolicy(JSON.parse(JSON.stringify(draft)));
    expect(saved.incidentExecution?.model).toBe("omniroute/hand-typed-model");
  });

  it("edits the incident model by hand instead of choosing a pinned option", () => {
    expect(component).toContain("list={INCIDENT_MODEL_LIST_ID}");
    expect(component).toContain("<datalist id={INCIDENT_MODEL_LIST_ID}>");
    expect(component).not.toContain("Модель локального маршрута Herder · MiniMax M3.1 через OmniRoute");
    expect(component).toContain("не найдена в каталоге harness");
    expect(component).toContain("будет сохранена как есть");
  });

  it("exposes launch policy as its own desktop and mobile settings entry", () => {
    expect(main).toContain('"autocontinue" | "autopilot" | "launch-policy"');
    expect(main).toContain('aria-label="Новая сессия"');
    expect(main).toContain('>Настройки запуска новых сессий</button>');
    expect(main).toContain('setAutomationSettings("launch-policy")');
    expect(main).toContain("<LaunchPolicySettings onOpenProjects=");
  });
});
