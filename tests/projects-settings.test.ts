import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mergePolicyChanges, sameProjectRoute, type LaunchPolicy } from "../src/web-ui/launch-policy-settings.js";
import { mergeProjectRoutes } from "../src/web-ui/projects-settings.js";

const page = readFileSync(new URL("../src/web-ui/projects-settings.tsx", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../src/web-ui/codex-navigation.tsx", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/web-ui/main.tsx", import.meta.url), "utf8");

const policy = (overrides: Partial<LaunchPolicy> = {}): LaunchPolicy => ({
  version: 1,
  allowedHarnesses: ["codex", "opencode"],
  preferredHarness: "codex",
  models: { codex: "gpt-6.1-sol", opencode: "minimax-coding-plan/MiniMax-M3.1-Flash" },
  projectRoutes: {
    "/workspace/one": { harnesses: ["codex", "opencode"], aliases: ["one"] },
    "/workspace/two": { harnesses: ["opencode"] },
  },
  ...overrides,
});

describe("Projects navigation", () => {
  it("is a first-class tab next to the other sections", () => {
    expect(navigation).toContain('label: "Проекты"');
    expect(navigation).toContain("onProjects: () => void;");
    expect(navigation).toContain('active: "chat" | "jobs" | "statistics" | "machines" | "search" | "projects"');
    expect(main).toContain('showProjects ? "projects"');
    expect(main).toContain("onProjects={() =>");
    expect(main).toContain("<ProjectsSettings ");
  });

  it("is reachable from the mobile chat menu as well", () => {
    const menu = main.slice(main.indexOf('<span className="chat-menu-section">Разделы</span>'));
    expect(menu).toContain(">Проекты</button>");
    expect(menu).toContain("setShowProjects(true)");
  });
});

describe("Projects page form", () => {
  it("edits the harness order, the route model and the card identifiers", () => {
    expect(page).toContain("Порядок сред");
    expect(page).toContain("Модель маршрута");
    expect(page).toContain("Идентификаторы карточек");
    expect(page).toContain("moveProjectRouteHarness");
    expect(page).toContain("removeProjectRouteHarness");
    expect(page).toContain("updateProjectRouteModel");
  });

  it("explains the allowed harnesses and how to set the model of a route", () => {
    expect(page).toContain("РАЗРЕШЁННЫЕ СРЕДЫ");
    expect(page).toContain("В маршрут проекта попадают только эти среды");
    expect(page).toContain("omniroute/minimax/MiniMax-M3.1-Flash");
    expect(page).toContain("Пустое поле берёт общую модель среды");
  });

  it("leaves the incident model of Notice Place alone", () => {
    expect(page).toContain('href="https://notify.bezrabotnyi.com/admin/#health-model"');
    expect(page).toContain("Эта страница её не меняет.");
    expect(page).not.toContain("incidentExecution");
  });

  it("names every control for a screen reader", () => {
    expect(page).toContain('aria-label="Абсолютный путь проекта для маршрута"');
    expect(page).toContain("aria-label={`Модель маршрута для ${project} и среды ${labelFor(harness, runtimes)}`}");
    expect(page).toContain("aria-label={`Идентификаторы карточек проекта ${project}`}");
    expect(page).toContain("aria-label={`Поднять ${labelFor(harness, runtimes)} выше в маршруте ${project}`}");
    expect(page).toContain("aria-label={`Опустить ${labelFor(harness, runtimes)} ниже в маршруте ${project}`}");
    expect(page).toContain("aria-label={`Убрать ${labelFor(harness, runtimes)} из маршрута ${project}`}");
    expect(page).toContain("aria-label={`Добавить среду в маршрут проекта ${project}`}");
    expect(page).toContain('aria-label="Сохранить маршруты проектов"');
    expect(page).toContain('aria-label="Добавить маршрут проекта"');
  });
});

describe("project route merge after a conflict", () => {
  it("carries over only the edited project and leaves the other one alone", () => {
    const base = policy();
    const draft = policy({
      projectRoutes: {
        "/workspace/one": { harnesses: ["opencode", "codex"], aliases: ["one"] },
        "/workspace/two": { harnesses: ["opencode"] },
      },
    });
    const fresh = policy({
      projectRoutes: {
        "/workspace/one": { harnesses: ["codex", "opencode"], aliases: ["one"] },
        "/workspace/two": { harnesses: ["opencode", "codex"] },
      },
    });

    const result = mergeProjectRoutes({ base, fresh, draft, kept: {} });
    expect(result.conflicts).toEqual([]);
    expect(result.merged.projectRoutes?.["/workspace/one"]).toEqual({ harnesses: ["opencode", "codex"], aliases: ["one"] });
    // The other project changed on the server and was never touched here.
    expect(result.merged.projectRoutes?.["/workspace/two"]).toEqual({ harnesses: ["opencode", "codex"] });
  });

  it("keeps the draft of a project that changed on the server instead of overwriting it", () => {
    const base = policy();
    const draft = policy({
      projectRoutes: {
        "/workspace/one": { harnesses: ["opencode", "codex"], aliases: ["one"] },
        "/workspace/two": { harnesses: ["opencode"] },
      },
    });
    const fresh = policy({
      projectRoutes: {
        "/workspace/one": { harnesses: ["codex"], aliases: ["one"] },
        "/workspace/two": { harnesses: ["opencode"] },
      },
    });

    const result = mergeProjectRoutes({ base, fresh, draft, kept: {} });
    expect(result.conflicts).toEqual(["/workspace/one"]);
    // The server value of the changed project survives the merge.
    expect(result.merged.projectRoutes?.["/workspace/one"]).toEqual({ harnesses: ["codex"], aliases: ["one"] });
    // The draft of the changed project stays in the form for the operator.
    expect(result.kept?.["/workspace/one"]).toEqual({ harnesses: ["opencode", "codex"], aliases: ["one"] });
  });

  it("does not re-apply a project that already lost a conflict until it is edited again", () => {
    const base = policy();
    const draft = policy({
      projectRoutes: {
        "/workspace/one": { harnesses: ["opencode", "codex"], aliases: ["one"] },
        "/workspace/two": { harnesses: ["opencode"] },
      },
    });
    const fresh = policy({
      projectRoutes: {
        "/workspace/one": { harnesses: ["codex"], aliases: ["one"] },
        "/workspace/two": { harnesses: ["opencode"] },
      },
    });

    const first = mergeProjectRoutes({ base, fresh, draft, kept: {} });
    const second = mergeProjectRoutes({ base, fresh, draft, kept: first.kept ?? {} });
    expect(second.conflicts).toEqual(["/workspace/one"]);
    expect(second.merged.projectRoutes?.["/workspace/one"]).toEqual({ harnesses: ["codex"], aliases: ["one"] });

    // An explicit re-edit of the same project is applied again.
    const redone = policy({
      projectRoutes: {
        "/workspace/one": { harnesses: ["opencode", "codex", "zcode"], aliases: ["one"] },
        "/workspace/two": { harnesses: ["opencode"] },
      },
    });
    const third = mergeProjectRoutes({ base, fresh, draft: redone, kept: first.kept ?? {} });
    expect(third.conflicts).toEqual(["/workspace/one"]);
    expect(third.merged.projectRoutes?.["/workspace/one"]).toEqual({ harnesses: ["codex"], aliases: ["one"] });
  });

  it("renders only the path-specific banner for a project conflict", () => {
    const specificBanner = page.slice(page.indexOf("{draft.conflicts.length > 0"), page.indexOf("{saveError &&"));
    expect(page).toContain("{draft.conflict && draft.conflicts.length === 0 &&");
    expect(specificBanner).toContain("draft.conflicts.join");
    expect(specificBanner).not.toContain("Политика запуска изменилась в другой вкладке");
  });

  it("keeps the global settings of the newer document in the settings merge", () => {
    const base = policy();
    const draft = policy({ preferredHarness: "opencode" });
    const fresh = policy({ preferredHarness: "codex", models: { ...base.models, codex: "gpt-6.1-sol-x" } });

    const merged = mergePolicyChanges(fresh, draft, ["preferredHarness"]);
    expect(merged.preferredHarness).toBe("opencode");
    // The concurrent model change of the same project survives.
    expect(merged.models.codex).toBe("gpt-6.1-sol-x");
    expect(merged.projectRoutes).toEqual(fresh.projectRoutes);
  });
});

describe("project route comparison", () => {
  it("sees the model, the order and the card identifiers", () => {
    const route = { harnesses: ["opencode", "codex"], models: { opencode: "m" }, aliases: ["a"] };
    expect(sameProjectRoute(route, { harnesses: ["opencode", "codex"], models: { opencode: "m" }, aliases: ["a"] })).toBe(true);
    expect(sameProjectRoute(route, { harnesses: ["codex", "opencode"], models: { opencode: "m" }, aliases: ["a"] })).toBe(false);
    expect(sameProjectRoute(route, { harnesses: ["opencode", "codex"], models: { opencode: "other" }, aliases: ["a"] })).toBe(false);
    expect(sameProjectRoute(route, { harnesses: ["opencode", "codex"], models: { opencode: "m" }, aliases: ["b"] })).toBe(false);
    expect(sameProjectRoute(route, undefined)).toBe(false);
    expect(sameProjectRoute(undefined, undefined)).toBe(true);
  });
});
