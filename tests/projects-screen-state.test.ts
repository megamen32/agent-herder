import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildProjectEntries,
  checkProjectModelRoutes,
  humanModelName,
  humanProviderName,
  modelRouteTitle,
  plural,
  projectApplicationState,
  relativeTime,
  type FleetHostFact,
  type FleetSessionFact,
} from "../src/web-ui/projects-settings.js";
import type { LaunchPolicy, ProjectLaunchRoute } from "../src/web-ui/launch-policy-settings.js";

const page = readFileSync(new URL("../src/web-ui/projects-settings.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/web-ui/projects-screen.css", import.meta.url), "utf8");
const theme = readFileSync(new URL("../src/web-ui/codex-theme.css", import.meta.url), "utf8");

const policy: LaunchPolicy = {
  version: 1,
  allowedHarnesses: ["opencode"],
  preferredHarness: "opencode",
  models: { opencode: "omniroute/minimax-combo-m3.1" },
  projectRoutes: {},
};

const hosts: FleetHostFact[] = [
  { hostId: "roomhacker-server-100", label: "server-100", state: "ready" },
  { hostId: "roomhacker-server-88", label: "server-88", state: "ready" },
  { hostId: "server-44", label: "server-44", state: "offline" },
  { hostId: "roomhacker-server-44", label: "server-44-b", state: "unavailable" },
  { hostId: "mac-mini-2012.lan", label: "mac-mini", state: "ready" },
];

const confirmed = { opencode: ["omniroute/minimax-combo-m3.1"] };

describe("the state of a project across the machines of the fleet", () => {
  it("counts the machines that took the route and the ones that did not answer", () => {
    const nodes = [
      { hostId: "a", label: "A", answered: true, applies: true },
      { hostId: "b", label: "B", answered: true, applies: true },
      { hostId: "c", label: "C", answered: true, applies: true },
      { hostId: "d", label: "D", answered: false, applies: false },
      { hostId: "e", label: "E", answered: false, applies: false },
    ];
    const state = projectApplicationState(nodes);
    expect(state.label).toBe("Применено частично");
    expect(state.detail).toBe("3 из 5 узлов приняли, 2 не ответили");
    expect(state.icon).toBe("◐");
    expect(state.tone).toBe("partial");
  });

  it("reads «Неизвестно: узел не ответил» when no machine answered", () => {
    const state = projectApplicationState([
      { hostId: "a", label: "A", answered: false, applies: false },
      { hostId: "b", label: "B", answered: false, applies: false },
    ]);
    expect(`${state.label}: ${state.detail}`).toBe("Неизвестно: узел не ответил");
    expect(state.icon).toBe("?");
  });

  it("is complete when every machine answered and one of them runs the project", () => {
    const state = projectApplicationState([
      { hostId: "a", label: "A", answered: true, applies: true },
      { hostId: "b", label: "B", answered: true, applies: false },
    ]);
    expect(state.label).toBe("Применено");
    expect(state.detail).toBe("1 узел принял маршрут");
    expect(state.icon).toBe("✓");
  });

  it("says that nothing is known when the fleet says nothing", () => {
    const state = projectApplicationState([]);
    expect(state.label).toBe("Неизвестно");
    expect(state.tone).toBe("unknown");
  });

  it("counts the machines of the real fleet of the panel", () => {
    const sessions: FleetSessionFact[] = [
      { hostId: "roomhacker-server-100", launchCwd: "/home/roomhacker/PycharmProjects/TelegramAuto", lastActivity: "2026-10-22T18:00:00Z", model: "" },
    ];
    const entries = buildProjectEntries(
      [["/home/roomhacker/PycharmProjects/TelegramAuto", { harnesses: ["opencode"] }]],
      hosts,
      sessions,
    );
    const state = projectApplicationState(entries[0]?.nodeStates ?? []);
    expect(state.label).toBe("Применено частично");
    expect(state.detail).toBe("1 из 5 узлов приняли, 2 не ответили");
  });
});

describe("the prediction of a blocked model request", () => {
  const restricted: ProjectLaunchRoute = { harnesses: ["opencode"], models: { opencode: "codex/gpt-6.1-sol" } };

  it("blocks the model of a closed project that the environment does not confirm", () => {
    const checks = checkProjectModelRoutes(
      "/home/roomhacker/PycharmProjects/TelegramAuto",
      { harnesses: ["opencode"], models: { opencode: "minimax-coding-plan/MiniMax-M3.1-Flash" } },
      policy,
      confirmed,
    );
    expect(checks[0]?.state).toBe("blocked");
    expect(checks[0]?.reason).toBe("маршрут не совпал с подтверждённым нативным маршрутом среды");
    expect(checks[0]?.action).toContain("omniroute/minimax-combo-m3.1");
    // The action names the button, and it never blames the lists of the
    // project for a block that comes from the environment.
    expect(checks[0]?.action).toContain("Поставить рабочую модель");
    expect(checks[0]?.action).not.toContain("не отменяют");
  });

  it("blocks a route of a closed provider", () => {
    const checks = checkProjectModelRoutes(
      "/home/roomhacker/PycharmProjects/video_watching",
      restricted,
      policy,
      confirmed,
    );
    expect(checks[0]?.state).toBe("blocked");
    expect(checks[0]?.reason).toContain("codex");
  });

  it("does not block the model that the environment confirms", () => {
    const checks = checkProjectModelRoutes(
      "/home/roomhacker/PycharmProjects/TelegramAuto",
      { harnesses: ["opencode"], models: { opencode: "omniroute/minimax-combo-m3.1" } },
      policy,
      confirmed,
    );
    expect(checks[0]?.state).toBe("ok");
  });

  it("only warns about an unconfirmed model of a project that is not closed", () => {
    const checks = checkProjectModelRoutes(
      "/home/roomhacker/agents-projects/agent-herder",
      { harnesses: ["opencode"], models: { opencode: "minimax-coding-plan/MiniMax-M3.1-Flash" } },
      policy,
      confirmed,
    );
    expect(checks[0]?.state).toBe("unconfirmed");
  });
});

describe("the readable names of the models", () => {
  it("shows the name of the model next to its identifier", () => {
    expect(humanModelName("omniroute/minimax-combo-m3.1")).toBe("MiniMax Combo M3.1");
    expect(humanProviderName("omniroute/minimax-combo-m3.1")).toBe("OmniRoute");
    expect(modelRouteTitle("omniroute/minimax-combo-m3.1")).toBe("OmniRoute · MiniMax Combo M3.1");
    expect(modelRouteTitle("minimax-code/mmcode/MiniMax-M3.1-Flash")).toBe("Minimax Code · mmcode / MiniMax M3.1 Flash");
  });

  it("counts the models in Russian", () => {
    expect(plural(1, "среда", "среды", "сред")).toBe("среда");
    expect(plural(2, "среда", "среды", "сред")).toBe("среды");
    expect(plural(5, "среда", "среды", "сред")).toBe("сред");
    expect(plural(11, "среда", "среды", "сред")).toBe("сред");
  });

  it("says how long ago the last change was", () => {
    const now = Date.parse("2026-10-22T20:00:00Z");
    expect(relativeTime("2026-10-22T19:59:30Z", now)).toBe("только что");
    expect(relativeTime("2026-10-22T19:30:00Z", now)).toBe("30 минут назад");
    expect(relativeTime("2026-10-22T18:00:00Z", now)).toBe("2 часа назад");
    expect(relativeTime("", now)).toBe("время неизвестно");
  });
});

describe("the screen of the projects", () => {
  it("collapses every project into a row that opens on demand", () => {
    expect(page).toContain('<details className="projects-card"');
    expect(page).toContain('<summary className="projects-card-summary">');
    expect(page).toContain("projects-card-time");
    expect(page).toContain("projects-machine-chip");
  });

  it("shows the name, the machine, the counts and the time of the last change in the row", () => {
    expect(page).toContain("plural(environments, \"среда\", \"среды\", \"сред\")");
    expect(page).toContain("plural(models, \"модель\", \"модели\", \"моделей\")");
    expect(page).toContain("<time className=\"projects-card-time\"");
  });

  it("keeps the search, the order and the grouping of the list", () => {
    expect(page).toContain('placeholder="Поиск по названию, пути или машине"');
    expect(page).toContain('["recent", "Недавние"]');
    expect(page).toContain('["machine", "По машине"]');
    expect(page).toContain('["name", "По имени"]');
    expect(page).toContain("groupProjectEntriesByMachine");
    expect(page).toContain("/api/fleet/hosts");
    expect(page).toContain("/api/fleet/sessions");
  });

  it("explains the block once and says what the lists of models do", () => {
    const explainer = "Списки моделей — это фильтр проекта.";
    expect(page.split(explainer)).toHaveLength(2);
    expect(page).toContain("enforceRestrictedModelRequest");
    expect(page).toContain("integrations/opencode/agent-herder-autopilot.js");
    expect(page).toContain("TelegramAuto, video_watching");
  });

  it("says once how the order of the environments is read", () => {
    const help = "Herder идёт по списку сверху вниз";
    expect(page.split(help)).toHaveLength(2);
  });

  it("does not repeat the empty list of the models on every card", () => {
    expect(page).not.toContain("Список пуст");
    expect(page).toContain("Пустой список разрешённых");
    expect(page).toContain("Пустой список запрещённых");
  });

  it("keeps the removal of a route in the menu of the card", () => {
    const menu = page.slice(page.indexOf("projects-card-menu-button"));
    expect(menu).toContain("Удалить маршрут");
    expect(page.split("Удалить маршрут")).toHaveLength(2);
  });

  it("separates the environment and the model of the effective route", () => {
    expect(page).toContain("projects-effective-environment");
    expect(page).toContain("projects-effective-model");
    expect(page).toContain("projects-model-caption");
  });

  it("shows the human name of every model of the lists", () => {
    expect(page).toContain("humanModelName(model)");
    expect(page).toContain("projects-model-entry-name");
  });
});

describe("the mobile navigation of the panel", () => {
  it("keeps the navigation reachable at 390px", () => {
    expect(styles).toContain(".oc-app > .codex-navigation");
    expect(styles).toContain("position: fixed");
    expect(styles).toContain("inset: auto 0 0 0");
  });

  it("overrides the hidden navigation of the theme with a stronger selector", () => {
    expect(theme).toContain(".codex-navigation { display: none; }");
    expect(styles).toContain(".oc-app > .codex-navigation {");
  });

  it("lets the settings screen scroll instead of cutting it off", () => {
    expect(styles).toContain(".herder-settings-page {");
    expect(styles).toContain("overflow: auto");
  });

  it("keeps the action of the projects visible and shows the unsaved changes", () => {
    // The action bar is pinned above the navigation: a sticky row cannot leave
    // the box of its page, and the page is the whole scroll.
    expect(styles).toContain(".projects-save-row {");
    expect(styles).toContain("position: fixed");
    expect(styles).toContain("bottom: calc(60px + env(safe-area-inset-bottom));");
    expect(page).toContain("Есть несохранённые изменения");
  });
});
