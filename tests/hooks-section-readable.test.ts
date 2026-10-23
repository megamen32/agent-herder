import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  HooksPanel,
  hooksClockText,
  hooksFiredText,
  hooksPlainText,
  hooksProhibitionText,
  hooksRefreshText,
  hooksStopStatusText,
  hooksStopTone,
  hooksToggleTone,
  hooksWhenText,
  type HooksView,
} from "../src/web-ui/hooks-section.js";

const source = readFileSync(new URL("../src/web-ui/hooks-section.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/web-ui/hooks-section.css", import.meta.url), "utf8");

const view: HooksView = {
  ok: true,
  known: true,
  prohibitionsEnabled: true,
  disabledHooks: [],
  changedBy: "owner",
  changedAt: "2026-10-23T00:35:09.474Z",
  reason: "Владелец попросил снять запреты: гард opencode отказывал в рабочих сессиях.",
  hooks: [
    {
      kind: "Stop",
      humanName: "Хук остановки (Stop)",
      purpose: "Смотрит, нужно ли продолжить ход сессии, и может оставить сессию без остановки.",
      scope: "ход сессии",
      canProhibit: true,
      prohibition: "не даёт сессии остановиться и продолжает ход",
      state: "включены",
    },
    {
      kind: "PreToolUse",
      humanName: "Хук перед вызовом инструмента (PreToolUse)",
      purpose: "Проверяет вызов инструмента до его выполнения и может отказать в нём.",
      scope: "вызов инструмента",
      canProhibit: true,
      prohibition: "отказывает в вызове инструмента",
      state: "включены",
      lastFiredAt: "2026-10-23T00:25:20.562Z",
      lastRefusal: {
        at: "2026-10-22T23:52:50.015Z",
        reason: "вызов инструмента получил конфликт по путям",
        sessionId: "mvs_81d8120ae9ef4ccf8df7367ebe2e37f6",
      },
    },
    {
      kind: "SessionStart",
      humanName: "Хук старта сессии (SessionStart)",
      purpose: "Передаёт сессии её контекст и входящие сообщения при старте.",
      scope: "старт сессии",
      canProhibit: false,
      prohibition: "ничего не запрещает",
      state: "не запрещает",
    },
  ],
  audit: [{ at: "2026-10-23T00:35:09.474Z", actor: "owner", reason: "выключение запретов хуков владельцем из панели" }],
};

const render = (props: Partial<Parameters<typeof HooksPanel>[0]> = {}): string =>
  renderToStaticMarkup(createElement(HooksPanel, { view, ...props }));

describe("the tab of the hooks: the table is read whole", () => {
  it("does not let the chat panel of an open session lie on top of the table", () => {
    // The remote chat of an open session takes the third column of the screen
    // and the table of the hooks went under it. The tab of the hooks now owns
    // the screen, the same way the panel already hides the local chat here.
    expect(css).toMatch(/\.herder-settings-page:has\(\.herder-hooks\)\s+\.remote-chat-pane\s*\{[^}]*display:\s*none/);
    expect(source).toContain('className="herder-settings-block herder-hooks"');
  });

  it("keeps the header of the table above the rows and loses no column sideways", () => {
    expect(css).toMatch(/\.herder-hooks-table th\s*\{[^}]*position:\s*sticky/);
    expect(css).toContain(".herder-hooks-table-wrap");
    expect(source).toContain('className="herder-settings-table herder-hooks-table"');
  });
});

describe("the tab of the hooks: the column says what it is about", () => {
  it("names the prohibition instead of saying «включены» alone", () => {
    const html = render();
    expect(html).toContain("Что может запрещать");
    expect(html).toContain("Запреты включены");
    expect(html).toContain("Запреты не действуют");
    expect(html).not.toMatch(/>включены</);
    expect(html).not.toMatch(/>выключены</);
  });

  it("names the state of one hook in the words of the owner", () => {
    expect(hooksProhibitionText({ kind: "Stop", canProhibit: true, state: "включены" })).toBe("Запреты включены");
    expect(hooksProhibitionText({ kind: "Stop", canProhibit: true, state: "выключены" })).toBe("Запреты выключены");
    expect(hooksProhibitionText({ kind: "Stop", canProhibit: true, state: "неизвестно" })).toBe("Неизвестно");
    expect(hooksProhibitionText({ kind: "SessionStart", canProhibit: false, state: "не запрещает" })).toBe("Запреты не действуют");
  });
});

describe("the tab of the hooks: the Stop hook has its own state", () => {
  it("says whether the session may stop", () => {
    expect(hooksStopStatusText(view)).toBe("Остановка сессии: запрещена");
    expect(hooksStopStatusText({ ...view, disabledHooks: ["Stop"] })).toBe("Остановка сессии: разрешена");
    expect(hooksStopStatusText({ ...view, prohibitionsEnabled: false })).toBe("Остановка сессии: разрешена");
    expect(hooksStopStatusText({ ...view, known: false })).toBe("Остановка сессии: неизвестно");
    expect(render()).toContain("Остановка сессии: запрещена");
  });
});

describe("the tab of the hooks: the refresh gives a sign", () => {
  it("tells the owner when the state was read", () => {
    expect(hooksRefreshText(new Date("2026-10-23T02:12:00Z"))).toBe("Обновлено в 05:12 МСК");
    expect(hooksClockText(new Date("2026-10-23T02:12:00Z"))).toBe("05:12 МСК");
    expect(render({ refreshedAt: hooksRefreshText(new Date("2026-10-23T02:12:00Z")) })).toContain("Обновлено в 05:12 МСК");
  });

  it("really re-reads the state before it signs the time", () => {
    expect(source).toContain("void reload().then((read) => { if (read) setRefreshedAt(hooksRefreshText()); })");
    expect(source).toContain("onRefresh");
  });
});

describe("the tab of the hooks: the times are human", () => {
  it("shows the same format as the section of the tasks", () => {
    expect(hooksWhenText("2026-10-23T00:25:20.562Z")).toBe("23.10.2026, 03:25 МСК");
    expect(hooksFiredText({ kind: "Stop", canProhibit: true, state: "включены", lastFiredAt: "2026-10-23T00:25:20.562Z" }))
      .toBe("23.10.2026, 03:25 МСК");
    expect(hooksFiredText({ kind: "Stop", canProhibit: true, state: "включены" })).toBe("ещё не срабатывал");
    const html = render();
    expect(html).toContain("23.10.2026, 03:25 МСК");
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});

describe("the tab of the hooks: one meaning — one look", () => {
  it("makes the dangerous action look more dangerous than the safe one", () => {
    expect(hooksToggleTone(view)).toBe("danger");
    expect(hooksStopTone(view)).toBe("danger");
    expect(hooksToggleTone({ ...view, prohibitionsEnabled: false })).toBe("plain");
    expect(hooksStopTone({ ...view, disabledHooks: ["Stop"] })).toBe("plain");

    const dangerous = render().match(/herder-settings-button-danger/g) ?? [];
    expect(dangerous).toHaveLength(2);
    const safe = render({ view: { ...view, prohibitionsEnabled: false, disabledHooks: ["Stop"] } })
      .match(/herder-settings-button-danger/g) ?? [];
    expect(safe).toHaveLength(0);
  });
});

describe("the tab of the hooks: only the words of the owner", () => {
  it("shows no raw date, no code of the implementation and no service name", () => {
    const html = render();
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(html).not.toMatch(/sha256/i);
    expect(html).not.toContain("direct_peer_unavailable");
    expect(html).not.toContain("Изменил: owner");
    expect(html).toContain("Изменил: владелец");
  });

  it("keeps the identifier of the session out of the visible part", () => {
    const html = render();
    expect(html).toMatch(/<details[^>]*>[\s\S]*mvs_81d8120ae9ef4ccf8df7367ebe2e37f6[\s\S]*<\/details>/);
    expect(html).toContain("Подробности отказа");
  });

  it("turns the codes of the implementation into words", () => {
    expect(hooksPlainText("ревизия sha256:abc123")).toBe("ревизия хэш документа");
    expect(hooksPlainText("узел direct_peer_unavailable")).toBe("узел не отвечает");
    expect(hooksPlainText("изменено 2026-10-23T00:35:09.474Z")).toBe("изменено 23.10.2026, 03:35 МСК");
  });
});
