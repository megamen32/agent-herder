import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildProjectEntries,
  humanListEntry,
  MODEL_CONCEPT_CAPTIONS,
  MODEL_CONCEPT_RELATION,
  projectApplicationState,
  projectCountsLabel,
  projectRuleCounts,
  refreshMomentLabel,
  silentNodes,
  type FleetHostFact,
  type FleetSessionFact,
} from "../src/web-ui/projects-settings.js";
import type { ProjectLaunchRoute } from "../src/web-ui/launch-policy-settings.js";

const page = readFileSync(new URL("../src/web-ui/projects-settings.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/web-ui/projects-screen.css", import.meta.url), "utf8");

/** The block of the page that the owner reads as the help of the screen. */
const explainer = page.slice(
  page.indexOf('<details className="projects-explainer"'),
  page.indexOf('<section className="projects-globals"'),
);

/** The help inside the card: the rules of the models of the project. */
const legend = page.slice(
  page.indexOf('<div className="projects-legend"'),
  page.indexOf("</div>", page.indexOf('<div className="projects-legend"')),
);

const route: ProjectLaunchRoute = {
  harnesses: ["opencode", "zcode"],
  allowedModels: ["*", "minimax*", "omniroute/minimax-*", "minimax-coding-plan/*"],
  deniedModels: ["codex/*", "openai/*", "gpt-*"],
};

describe("the card of a project answers the owner without the internals", () => {
  it("has a button that re-reads the state of the nodes and says when it answered", () => {
    expect(page).toContain("Обновить состояние");
    expect(page).toContain('aria-label={`Обновить состояние проекта ${project}`}');
    expect(page).toContain("onRefresh={() => void refresh()}");
    // The answer of the fleet is re-read, not remembered from the first load.
    expect(page).toContain("/api/fleet/hosts");
    expect(page).toContain("/api/fleet/sessions");
    // The server keeps the answer of the fleet for a minute, so the manual
    // refresh asks it for a fresh read of the nodes.
    expect(page).toContain('"/api/fleet/hosts?refresh=1"');
    expect(page).toContain("await read({ refresh: true });");
    // The button must not fold the card while it refreshes it.
    expect(page).toContain("event.preventDefault(); event.stopPropagation(); onRefresh();");
  });

  it("shows the moment of the answer in the words of the owner", () => {
    expect(refreshMomentLabel("2026-10-23T02:12:00Z")).toBe("Обновлено в 05:12 МСК");
    expect(refreshMomentLabel("")).toBe("");
    expect(refreshMomentLabel("не дата")).toBe("");
    expect(page).toContain("refreshMomentLabel(refreshedAt ?? \"\")");
  });

  it("keeps one wording for the unknown and names the node that did not answer", () => {
    const one = projectApplicationState([{ hostId: "88", label: "Сервер 88", answered: false, applies: false }]);
    expect(`${one.label}: ${one.detail}`).toBe("Неизвестно: не удалось спросить узел 88");
    const two = projectApplicationState([
      { hostId: "44", label: "Сервер 44", answered: false, applies: false },
      { hostId: "88", label: "Сервер 88", answered: false, applies: false },
    ]);
    expect(`${two.label}: ${two.detail}`).toBe("Неизвестно: не удалось спросить узлы 44 и 88");
    // The story of the card does not jump between two explanations.
    expect(page).not.toContain("проект не найден на узлах");
    expect(page).not.toContain("узел не ответил");
    expect(page).not.toContain("данных о флоте нет");
  });

  it("says a plain fact when every node answered and nothing runs the project", () => {
    const state = projectApplicationState([
      { hostId: "100", label: "Сервер 100", answered: true, applies: false },
      { hostId: "88", label: "Сервер 88", answered: true, applies: false },
    ]);
    expect(state.label).toBe("Не запущено");
    expect(state.detail).toBe("ни один узел не показывает этот проект");
    expect(state.tone).toBe("idle");
  });

  it("names the machines that did not answer in one phrase", () => {
    expect(silentNodes([{ hostId: "88", label: "Сервер 88", answered: false, applies: false }])).toBe("узел 88");
    expect(silentNodes([
      { hostId: "44", label: "Сервер 44", answered: false, applies: false },
      { hostId: "88", label: "Сервер 88", answered: false, applies: false },
    ])).toBe("узлы 44 и 88");
    expect(silentNodes([])).toBe("узлы флота");
  });

  it("keeps the help of the screen free of the internals of the development", () => {
    expect(explainer.length).toBeGreaterThan(0);
    expect(legend.length).toBeGreaterThan(0);
    for (const help of [explainer, legend]) {
      for (const leak of [
        "integrations/",
        ".js",
        "enforceRestricted",
        "409",
        "mmcode",
        "minimax-code/",
        "src/",
        "function",
      ]) {
        expect(help).not.toContain(leak);
      }
    }
    // The panel names no file of the guard at all.
    expect(page).not.toContain("integrations/opencode/agent-herder-autopilot.js");
    // The meaning for the owner stays.
    expect(explainer).toContain("Списки моделей — это фильтр проекта.");
    expect(explainer).toContain("Что мешает запуску.");
    expect(explainer).toContain("Herder идёт по списку сверху вниз");
  });

  it("judges no money anywhere on the screen", () => {
    for (const word of ["платн", "подписк", "бесплатн", "дешевле", "дороже"]) {
      expect(page.toLowerCase()).not.toContain(word);
    }
    expect(page).not.toContain("Запретить платные маршруты");
  });

  it("reads the position of an environment as a phrase", () => {
    expect(page).toContain("<strong>{labelFor(harness, runtimes)}</strong>{\" \"}");
    expect(page).toContain("\"не в маршруте\"");
    // The caption of the position sits in one line next to the name.
    expect(styles).toContain(".projects-page .launch-runtime-option > .projects-runtime-option-text {");
    expect(styles).toContain("gap: 6px;");
  });

  it("shows the values of the lists in words", () => {
    expect(humanListEntry("codex/*")).toBe("Каталог среды: Codex *");
    expect(humanListEntry("openai/*")).toBe("Каталог среды: OpenAI *");
    expect(humanListEntry("minimax-coding-plan/*")).toBe("Каталог среды: MiniMax Coding Plan *");
    expect(humanListEntry("omniroute/minimax-*")).toBe("Каталог среды: OmniRoute · MiniMax *");
    expect(humanListEntry("gpt-*")).toBe("GPT *");
    expect(humanListEntry("minimax*")).toBe("MiniMax *");
    expect(humanListEntry("*")).toBe("Любая модель");
    expect(page).toContain("humanListEntry(model)");
  });

  it("gives the five words about a model a short caption and one sentence of relation", () => {
    const captions = Object.values(MODEL_CONCEPT_CAPTIONS);
    expect(captions).toHaveLength(5);
    for (const caption of captions) {
      expect(caption.length).toBeGreaterThan(10);
      expect(caption).toContain("—");
    }
    // One sentence that says how the five follow each other.
    expect(MODEL_CONCEPT_RELATION.split(".").filter((part) => part.trim())).toHaveLength(1);
    expect(MODEL_CONCEPT_RELATION).toContain("Разрешённые модели");
    expect(MODEL_CONCEPT_RELATION).toContain("Запрещённые модели");
    expect(MODEL_CONCEPT_RELATION).toContain("эффективная модель");
    // Every caption stands next to its field on the screen.
    expect(page).toContain("MODEL_CONCEPT_CAPTIONS.route");
    expect(page).toContain("MODEL_CONCEPT_CAPTIONS.common");
    expect(page).toContain("MODEL_CONCEPT_CAPTIONS.allowed");
    expect(page).toContain("MODEL_CONCEPT_CAPTIONS.denied");
    expect(page).toContain("MODEL_CONCEPT_CAPTIONS.effective");
    expect(page).toContain("MODEL_CONCEPT_RELATION");
  });

  it("shows that the card opens and opens by the whole header", () => {
    expect(page).toContain("projects-card-chevron");
    expect(styles).toContain(".projects-card-chevron {");
    const header = page.slice(
      page.indexOf('<summary className="projects-card-summary"'),
      page.indexOf("</summary>"),
    );
    // Every part of the header is inside the summary, so the whole header opens
    // the card and not only the name.
    expect(header).toContain("projects-card-name");
    expect(header).toContain("projects-card-counts");
    expect(header).toContain("projects-state");
    expect(header).toContain("projects-card-path");
  });

  it("counts what the rule holds and nothing else", () => {
    expect(projectRuleCounts(route)).toEqual({ environments: 2, modelRules: 7 });
    expect(projectCountsLabel(projectRuleCounts(route))).toBe("2 среды · 7 правил моделей");
    expect(projectCountsLabel(projectRuleCounts({ harnesses: ["opencode"] }))).toBe("1 среда · 0 правил моделей");
    expect(projectCountsLabel(projectRuleCounts({ harnesses: [], allowedModels: ["*"] }))).toBe("0 сред · 1 правило моделей");
  });

  it("keeps the counter of the card the same between two loads", () => {
    const hosts: FleetHostFact[] = [
      { hostId: "roomhacker-server-100", label: "Сервер 100", state: "ready" },
      { hostId: "roomhacker-server-88", label: "Сервер 88", state: "ready" },
    ];
    const sessions: FleetSessionFact[] = [
      { hostId: "roomhacker-server-100", launchCwd: "/home/roomhacker/PycharmProjects/TelegramAuto", lastActivity: "2026-10-23T02:00:00Z", model: "" },
    ];
    const first = buildProjectEntries([["/home/roomhacker/PycharmProjects/TelegramAuto", route]], hosts, sessions);
    const second = buildProjectEntries([["/home/roomhacker/PycharmProjects/TelegramAuto", route]], [], []);
    expect(first[0]?.modelCount).toBe(7);
    // The counter does not depend on the answer of the fleet.
    expect(second[0]?.modelCount).toBe(first[0]?.modelCount);
    expect(second[0]?.environmentCount).toBe(first[0]?.environmentCount);
  });
});
