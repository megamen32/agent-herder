import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOOKS_ENDPOINT,
  HOOKS_PROHIBITIONS_ENDPOINT,
  hooksConfirmText,
  hooksErrorText,
  hooksLastFiredText,
  hooksLastRefusalText,
  hooksLeverText,
  hooksReadErrorText,
  hooksStateLabel,
  hooksStopConfirmText,
  hooksStopLabel,
  hooksToggleIntent,
  hooksToggleLabel,
  loadHooks,
  saveHooksProhibitions,
  type HooksView,
} from "../src/web-ui/hooks-section.js";

afterEach(() => vi.unstubAllGlobals());

const known: HooksView = {
  ok: true,
  known: true,
  prohibitionsEnabled: true,
  disabledHooks: [],
  changedBy: "владелец",
  changedAt: "2026-10-23T00:00:00.000Z",
  hooks: [
    { kind: "Stop", humanName: "Хук остановки (Stop)", canProhibit: true, state: "включены" },
    { kind: "SessionStart", humanName: "Хук старта сессии (SessionStart)", canProhibit: false, state: "не запрещает" },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("the section of the hooks: the state of the lever", () => {
  it("says plainly that the prohibitions are on", () => {
    expect(hooksLeverText(known)).toContain("Запреты хуков включены");
    expect(hooksToggleIntent(known)).toBe("disable");
    expect(hooksToggleLabel(known)).toBe("Выключить запреты хуков");
  });

  it("says plainly that the prohibitions are off", () => {
    const view: HooksView = { ...known, prohibitionsEnabled: false };
    expect(hooksLeverText(view)).toContain("Запреты хуков выключены");
    expect(hooksToggleIntent(view)).toBe("enable");
    expect(hooksToggleLabel(view)).toBe("Включить запреты хуков");
  });

  it("never guesses when the state cannot be read", () => {
    const view: HooksView = { ...known, known: false };
    expect(hooksLeverText(view)).toContain("неизвестно");
    expect(hooksToggleIntent(view)).toBeNull();
    expect(hooksToggleLabel(view)).toBe("Обновить состояние");
  });

  it("shows the state of one hook and its last firing and refusal", () => {
    const hook = { kind: "Stop" as const, canProhibit: true, state: "выключены" };
    expect(hooksStateLabel(hook)).toBe("выключены");
    expect(hooksStateLabel({ kind: "SessionStart", canProhibit: false, state: "не запрещает" })).toBe("не запрещает");
    expect(hooksLastFiredText(hook)).toBe("ещё не срабатывал");
    expect(hooksLastFiredText({ ...hook, lastFiredAt: "2026-10-23T00:00:00.000Z" })).toBe("2026-10-23T00:00:00.000Z");
    expect(hooksLastRefusalText(hook)).toBe("отказов не было");
    expect(hooksLastRefusalText({
      ...hook,
      lastRefusal: { at: "2026-10-23T00:00:00.000Z", reason: "отказал в вызове", sessionId: "codex:7" },
    })).toContain("отказал в вызове");
  });
});

describe("the section of the hooks: the confirmation", () => {
  it("names exactly what the switch changes and what it does not", () => {
    expect(hooksConfirmText("disable")).toBe(
      "Выключить запреты хуков? Хуки перестанут отказывать в вызове инструментов и останавливать ход; запрет автоматики и аварийная пауза не затрагиваются.",
    );
    expect(hooksConfirmText("enable")).toContain("запрет автоматики и аварийная пауза не затрагиваются");
  });

  it("names the hook of the stop alone", () => {
    expect(hooksStopConfirmText(true)).toContain("только у хука Stop");
    expect(hooksStopConfirmText(false)).toContain("только у хука Stop");
    expect(hooksStopLabel({ ...known, disabledHooks: ["Stop"] })).toBe("Включить запреты у Stop-хука");
    expect(hooksStopLabel(known)).toBe("Выключить запреты у Stop-хука");
  });
});

describe("the section of the hooks: the failure in the words of the owner", () => {
  it("says what happened and what to do about it", () => {
    const refused = hooksErrorText("unauthorized", 401);
    expect(refused.reason).toContain("Запреты хуков не изменены");
    expect(refused.hint).toContain("войдите в кабинет владельца");

    const conflict = hooksErrorText("Состояние запретов хуков изменилось в другой вкладке.", 412);
    expect(conflict.hint).toContain("обновите раздел");

    const wrong = hooksErrorText("Такого хука нет.", 400);
    expect(wrong.hint).toContain("проверьте");

    const offline = hooksErrorText("fetch failed");
    expect(offline.hint).toContain("herder запущен");
  });

  it("says that the state is unknown when the read fails", () => {
    const failure = hooksReadErrorText("fetch failed");
    expect(failure.reason).toContain("Не удалось прочитать состояние");
    expect(failure.hint).toContain("хуки ничего не запрещают");
  });
});

describe("the section of the hooks: the client", () => {
  it("reads the state of the hooks", async () => {
    const fetch = vi.fn(async () => jsonResponse(known));
    vi.stubGlobal("fetch", fetch);
    await expect(loadHooks()).resolves.toMatchObject({ known: true, prohibitionsEnabled: true });
    const [path, init] = fetch.mock.calls[0]!;
    expect(String(path)).toBe(HOOKS_ENDPOINT);
    expect(init).toMatchObject({ cache: "no-store" });
  });

  it("moves the lever as an explicit action of the owner", async () => {
    const fetch = vi.fn(async () => jsonResponse({ ...known, prohibitionsEnabled: false }));
    vi.stubGlobal("fetch", fetch);
    await saveHooksProhibitions({ prohibitionsEnabled: false, reason: "мешают" }, "\"etag\"");
    const [path, init] = fetch.mock.calls[0]!;
    expect(String(path)).toBe(HOOKS_PROHIBITIONS_ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "if-match": "\"etag\"" });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.source).toBe("owner");
    expect(body.prohibitionsEnabled).toBe(false);
    expect(body.reason).toBe("мешают");
  });

  it("names the failure of the server in the answer of the client", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: "Такого хука нет." }, 400));
    vi.stubGlobal("fetch", fetch);
    await expect(saveHooksProhibitions({ reason: "мешают" })).rejects.toThrow("Такого хука нет.");
  });
});
