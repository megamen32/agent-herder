import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SessionLabelNotice,
  sessionLabelSaveOutcome,
} from "../src/web-ui/session-metadata.js";

const component = readFileSync(new URL("../src/web-ui/session-metadata.tsx", import.meta.url), "utf8");

const MINIMAX_RENAME_ERROR =
  "У среды 'minimax-code' нет нативного канала переименования: имя сессии осталось прежним.";

describe("the panel tells the truth about a saved session label", () => {
  it("shows the native name when the harness renamed the session", () => {
    const outcome = sessionLabelSaveOutcome(
      { ok: true, title: "Проект | Цель | Этап", renamed: true, nativeTitle: "Проект | Цель | Этап" },
      200,
    );
    expect(outcome.failed).toBe(false);
    expect(outcome.message).toBe("Сохранено. Название сессии: «Проект | Цель | Этап».");
  });

  it("falls back to the requested title when the native name is not returned", () => {
    const outcome = sessionLabelSaveOutcome({ ok: true, title: "Проект | Цель | Этап", renamed: true }, 200);
    expect(outcome.failed).toBe(false);
    expect(outcome.message).toBe("Сохранено. Название сессии: «Проект | Цель | Этап».");
  });

  it("treats a stored label with an unchanged name as a calm success, not as a failure", () => {
    const outcome = sessionLabelSaveOutcome(
      { ok: true, title: "Проект | Цель | Этап", renamed: false, renameError: MINIMAX_RENAME_ERROR },
      200,
    );
    expect(outcome.failed).toBe(false);
    expect(outcome.message).toBe(`Метка сохранена. Имя сессии не изменилось — ${MINIMAX_RENAME_ERROR}`);
  });

  it("renders the unchanged name with the neutral style and without any error style", () => {
    const outcome = sessionLabelSaveOutcome(
      { ok: true, title: "Проект | Цель | Этап", renamed: false, renameError: MINIMAX_RENAME_ERROR },
      200,
    );
    const html = renderToStaticMarkup(createElement(SessionLabelNotice, { message: outcome.message, failed: outcome.failed }));
    expect(html).toContain("Метка сохранена. Имя сессии не изменилось —");
    // React escapes the apostrophes of the reason in the markup.
    expect(html).toContain("У среды &#x27;minimax-code&#x27; нет нативного канала переименования: имя сессии осталось прежним.");
    expect(html).toContain("settings-hint");
    expect(html).not.toContain("autopilot-error");
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });

  it("keeps the error style for a real refusal", () => {
    const outcome = sessionLabelSaveOutcome({ ok: false, error: "Сессия принадлежит другой машине" }, 409);
    expect(outcome.failed).toBe(true);
    expect(outcome.message).toBe("Сессия принадлежит другой машине");
    const html = renderToStaticMarkup(createElement(SessionLabelNotice, { message: outcome.message, failed: outcome.failed }));
    expect(html).toContain("autopilot-error");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("settings-hint");
  });

  it("keeps the previous error text when the server says nothing about the failure", () => {
    const outcome = sessionLabelSaveOutcome({}, 400);
    expect(outcome.failed).toBe(true);
    expect(outcome.message).toBe("Нативное переименование не удалось (400).");
  });

  it("tells the outcomes apart by the field renamed, not by the presence of an error", () => {
    expect(component).toContain("answer.renamed === true");
    expect(component).toContain("Метка сохранена. Имя сессии не изменилось");
    expect(component).toContain("Сохранено. Название сессии");
    expect(component).toContain('className={failed ? "autopilot-error" : "settings-hint"}');
  });
});
