import { describe, expect, it } from "vitest";
import {
  filterAndArrangeSessions,
  isLiveSessionStatus,
  matchesSessionQuery,
  pluralRu,
  sessionListCounts,
  sessionListCounterRu,
  sessionListEmptyReason,
  sessionListFiltersHint,
  summarizeSessionSample,
  type SessionListSettings,
} from "../src/web-ui/session-list.js";
import {
  DEFAULT_SESSION_LIST_SETTINGS,
  SESSION_LIST_SHOW_COMPLETED_ARIA,
  SESSION_LIST_SHOW_COMPLETED_HINT,
  SESSION_LIST_SHOW_COMPLETED_LABEL,
} from "../src/web-ui/session-list-preferences.js";

/**
 * Список сессий должен говорить владельцу правду: сколько строк на экране,
 * сколько найдено поиском и почему список пуст.
 */

const live: SessionListSettings = { cwd: "", project: "", harness: "", sort: "created", showAll: false };

const sessions = [
  { id: "zcode-idle", harness: "zcode", title: "ZCode ждёт задачи", cwd: "/work/z", status: "idle", lastActivity: "2026-10-23T10:00:00Z", hostId: "roomhacker-server-88" },
  { id: "zcode-stopped", harness: "zcode", title: "ZCode завершён", cwd: "/work/z", status: "stopped", lastActivity: "2026-10-22T10:00:00Z", hostId: "roomhacker-server-88" },
  { id: "codex-running", harness: "codex", title: "Codex работает", cwd: "/work/c", status: "running", lastActivity: "2026-10-23T11:00:00Z", hostId: "roomhacker-server-100" },
  { id: "hermes-stopped", harness: "codex", title: "Hermes research", cwd: "/work/c", status: "stopped", lastActivity: "2026-10-20T10:00:00Z", hostId: "roomhacker-server-100" },
];

describe("счётчик списка сессий", () => {
  it("показывает ровно столько строк, сколько нарисовано на экране", () => {
    expect(sessionListCounterRu(sessionListCounts(2176, 150, 2171))).toBe("показано 150 из 2176");
    expect(sessionListCounterRu(sessionListCounts(2176, 450, 2171))).toBe("показано 450 из 2176");
    expect(sessionListCounterRu(sessionListCounts(2176, 600, 2171))).not.toBe(
      sessionListCounterRu(sessionListCounts(2176, 150, 2171)),
    );
  });

  it("не выдаёт размер серверного окна за число показанных строк", () => {
    const counter = sessionListCounterRu(sessionListCounts(2176, 450, 2171));
    expect(counter).toContain("450");
    expect(counter).not.toContain("100");
    expect(counter).not.toContain("2171");
  });

  it("меняется после догрузки сессий с сервера", () => {
    const before = sessionListCounterRu(sessionListCounts(2176, 150, 2171));
    const after = sessionListCounterRu(sessionListCounts(2190, 600, 2171));
    expect(before).toBe("показано 150 из 2176");
    expect(after).toBe("показано 600 из 2190");
  });

  it("говорит, сколько найдено поиском", () => {
    expect(sessionListCounterRu(sessionListCounts(2, 150), "Hermes")).toBe("найдено 2");
    expect(sessionListCounterRu(sessionListCounts(2, 150), "  ")).toBe("показано 2 из 2");
    expect(sessionListCounterRu(sessionListCounts(0, 150), "Hermes")).toBe("ничего не найдено");
  });
});

describe("поиск по списку", () => {
  it("оставляет найденные сессии в списке", () => {
    expect(matchesSessionQuery(sessions[3], "hermes")).toBe(true);
    const found = sessions.filter((session) => matchesSessionQuery(session, "Hermes"));
    expect(found.map((session) => session.id)).toEqual(["hermes-stopped"]);
  });
});

describe("живые и завершённые сессии", () => {
  it("считает живой сессию, которая ждёт задачи", () => {
    expect(isLiveSessionStatus("running")).toBe(true);
    expect(isLiveSessionStatus("needs_input")).toBe(true);
    expect(isLiveSessionStatus("idle")).toBe(true);
    expect(isLiveSessionStatus("stopped")).toBe(false);
    expect(isLiveSessionStatus("error")).toBe(false);
    expect(isLiveSessionStatus(undefined)).toBe(false);
  });

  it("показывает живую сессию без переключателя, а завершённую — только с ним", () => {
    const onlyLive = filterAndArrangeSessions(sessions, { ...live }, new Set()).map((entry) => entry.session.id);
    expect(onlyLive).toContain("zcode-idle");
    expect(onlyLive).not.toContain("zcode-stopped");

    const withCompleted = filterAndArrangeSessions(sessions, { ...live, showAll: true }, new Set()).map((entry) => entry.session.id);
    expect(withCompleted).toContain("zcode-stopped");
  });
});

describe("пустой список объясняет причину", () => {
  const sample = summarizeSessionSample(sessions);

  it("называет отсутствие живых сессий выбранной среды", () => {
    const withoutLiveZcode = summarizeSessionSample(sessions.filter((session) => session.id !== "zcode-idle"));
    const reason = sessionListEmptyReason({ query: "", settings: { ...live, harness: "zcode" }, sample: withoutLiveZcode });
    expect(reason.title).toBe("Живых сессий zcode сейчас нет.");
    expect(reason.showCompleted).toBe(true);
    expect(reason.hint).toContain("Показывать завершённые");
  });

  it("не путает отсутствие живых сессий с отсутствием сессий среды", () => {
    const reason = sessionListEmptyReason({ query: "", settings: { ...live, harness: "zcode" }, sample });
    expect(reason.title).not.toContain("Живых сессий zcode сейчас нет");
  });

  it("объясняет пустой результат поиска", () => {
    const reason = sessionListEmptyReason({ query: "нет-такого", settings: { ...live }, sample: summarizeSessionSample(sessions, "нет-такого") });
    expect(reason.title).toContain("ничего не найдено");
    expect(reason.hint).toContain("загруженному списку");
  });

  it("объясняет, что совпадения есть, но их скрывают фильтры", () => {
    const reason = sessionListEmptyReason({
      query: "Hermes",
      settings: { ...live, harness: "zcode" },
      sample: summarizeSessionSample(sessions, "Hermes"),
    });
    expect(reason.title).toContain("совпадений: 1");
    expect(reason.title).toContain("фильтров");
  });

  it("перечисляет включённые фильтры по-русски", () => {
    const hint = sessionListFiltersHint({ ...live, harness: "zcode", hostId: "roomhacker-server-88" }, "Сервер 88");
    expect(hint).toContain("агент zcode");
    expect(hint).toContain("машина Сервер 88");
    expect(hint).toContain("только живые сессии");
  });
});

describe("подпись переключателя", () => {
  it("читается прямо и объясняет значение по умолчанию", () => {
    expect(SESSION_LIST_SHOW_COMPLETED_LABEL).toBe("Показывать завершённые");
    expect(SESSION_LIST_SHOW_COMPLETED_ARIA).toBe("Показывать завершённые сессии");
    expect(SESSION_LIST_SHOW_COMPLETED_HINT).toContain("живые");
    expect(SESSION_LIST_SHOW_COMPLETED_HINT).toContain("завершённые");
    expect(SESSION_LIST_SHOW_COMPLETED_LABEL).not.toMatch(/только живые/i);
    expect(DEFAULT_SESSION_LIST_SETTINGS.showAll).toBe(false);
  });
});

describe("тексты сообщений", () => {
  it("не выдают служебных значений и читаются по-русски", () => {
    const reason = sessionListEmptyReason({ query: "Hermes", settings: { ...live, harness: "zcode" }, sample: summarizeSessionSample(sessions, "Hermes") });
    const texts = [
      reason.title,
      reason.hint ?? "",
      sessionListCounterRu(sessionListCounts(2176, 150, 2171)),
      sessionListCounterRu(sessionListCounts(2, 150), "Hermes"),
      SESSION_LIST_SHOW_COMPLETED_HINT,
    ].join(" ");
    expect(texts).not.toMatch(/undefined|NaN|\[object|null/);
    expect(texts).not.toMatch(/shownCount|entries\.|windowSize/);
  });

  it("склоняют число сессий по-русски", () => {
    expect(pluralRu(1, "сессия", "сессии", "сессий")).toBe("сессия");
    expect(pluralRu(2, "сессия", "сессии", "сессий")).toBe("сессии");
    expect(pluralRu(5, "сессия", "сессии", "сессий")).toBe("сессий");
    expect(pluralRu(11, "сессия", "сессии", "сессий")).toBe("сессий");
    expect(pluralRu(21, "сессия", "сессии", "сессий")).toBe("сессия");
  });
});
