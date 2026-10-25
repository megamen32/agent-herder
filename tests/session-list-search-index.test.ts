import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ragIndexNoticeRu } from "../src/web-ui/rag-search-view.js";

/**
 * Поиск по сессиям и список сессий говорят прямо: пустой индекс назван
 * пустым, счётчик берётся из отрисованных строк, а подпись переключателя
 * не выглядит обратным действием.
 */

const main = readFileSync(new URL("../src/web-ui/main.tsx", import.meta.url), "utf8");
const rag = readFileSync(new URL("../src/web-ui/rag-search-view.tsx", import.meta.url), "utf8");

describe("статус индекса поиска", () => {
  it("называет пустой индекс прямо", () => {
    const notice = ragIndexNoticeRu({ status: "running", processed: 0, indexed: 0 });
    expect(notice?.text).toContain("Индекс поиска пуст");
    expect(notice?.text).toContain("ищите по списку сессий");
    expect(notice?.text).not.toContain("Обработано 0");
  });

  it("не молчит, когда индексация идёт, но фрагментов ещё нет", () => {
    const notice = ragIndexNoticeRu({ status: "running", processed: 5, indexed: 0, current: "Codex" });
    expect(notice?.text).toContain("Индекс поиска пуст");
    expect(notice?.text).toContain("5");
  });

  it("показывает прогресс, когда фрагменты уже есть", () => {
    const notice = ragIndexNoticeRu({ status: "running", processed: 12, indexed: 40, current: "Codex + ZCode" });
    expect(notice?.text).toContain("Индексируются сессии");
    expect(notice?.text).toContain("40");
    expect(notice?.text).not.toContain("Индекс поиска пуст");
  });

  it("называет пустой готовый индекс и не выдаёт сырую ошибку", () => {
    expect(ragIndexNoticeRu({ status: "complete", indexed: 0 })?.text).toContain("Индекс поиска пуст");
    expect(ragIndexNoticeRu({ status: "complete", indexed: 40 })?.text).toContain("Индекс готов");
    const failure = ragIndexNoticeRu({ status: "error", error: "ECONNREFUSED 127.0.0.1:6333" });
    expect(failure?.text).toContain("остановилась");
    expect(failure?.text).not.toContain("ECONNREFUSED");
  });

  it("не выдумывает статус, которого нет", () => {
    expect(ragIndexNoticeRu(undefined)).toBeUndefined();
    expect(ragIndexNoticeRu({ status: "paused" })).toBeUndefined();
  });
});

describe("панель списка сессий", () => {
  it("берёт счётчик из отрисованных строк, а не из серверного окна", () => {
    expect(main).toContain("sessionListCounts(entries.length,windowSize,total)");
    expect(main).toContain("sessionListCounterRu(counts,searchQuery)");
    expect(main).not.toContain("показано {shownCount} из {total}");
  });

  it("показывает причину пустого списка и кнопку «показать завершённые»", () => {
    expect(main).toContain("sessionListEmptyReason(");
    expect(main).toContain("{empty.title}");
    expect(main).toContain("Показать завершённые сессии");
    expect(main).not.toContain("<div className=\"empty-list\">Нет сессий по этим настройкам.</div>");
  });

  it("подписывает переключатель прямо и объясняет значение по умолчанию", () => {
    expect(main).toContain("SESSION_LIST_SHOW_COMPLETED_LABEL");
    expect(main).toContain("SESSION_LIST_SHOW_COMPLETED_HINT");
    expect(main).toContain("SESSION_LIST_SHOW_COMPLETED_ARIA");
    expect(main).not.toContain('aria-label="Показывать все сессии"');
  });

  it("говорит владельцу, по чему идёт поиск", () => {
    expect(main).toContain("Поиск идёт по загруженному списку");
  });
});

describe("тексты панели", () => {
  it("не оставляет в видимой части сырых служебных счётчиков индекса", () => {
    expect(rag).toContain("Индекс поиска пуст");
    expect(rag).not.toContain("Обработано {settings.run.processed || 0}, фрагментов {settings.run.indexed || 0}.");
    expect(rag).not.toContain("Индексация остановилась: {settings.run.error");
  });
});
