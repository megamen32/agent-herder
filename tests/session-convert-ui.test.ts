import { describe, expect, it, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import {
  convertActionHint,
  convertOutcomeText,
  convertSessionToOpenCode,
  type SessionConvertOutcome,
} from "../src/web-ui/session-work-target.js";

const outcome = (overrides: Partial<SessionConvertOutcome> = {}): SessionConvertOutcome => ({
  ok: true,
  transferred: { messageCount: 40, targetSessionId: "ses_abc", targetPath: "/home/user/.local/share/opencode/opencode.db" },
  visibleInOpenCode: true,
  visibilityNote: "",
  stayed: { sessionId: "s1", harness: "codex", path: "/work/dir" },
  ...overrides,
});

describe("conversion action", () => {
  it("tells the owner what the action changes before it is pressed", () => {
    const hint = convertActionHint();
    expect(hint).toContain("OpenCode");
    expect(hint).toContain("остаётся на месте");
  });

  it("says what was carried over and that the original stayed", () => {
    const text = convertOutcomeText(outcome());
    expect(text).toContain("Перенесено сообщений: 40");
    expect(text).toContain("opencode.db");
    expect(text).toContain("видна в работающем OpenCode");
    expect(text).toContain("осталась на месте");
  });

  it("does not read as a success when the running OpenCode does not show the session", () => {
    const text = convertOutcomeText(outcome({
      visibleInOpenCode: false,
      visibilityNote: "перенос записан в таблицу `session`, а работающий OpenCode читает таблицу `session_v2`",
    }));
    expect(text).toContain("Переведено, но живой OpenCode её не показывает");
    expect(text).toContain("причина: перенос записан в таблицу `session`");
    expect(text).toContain("осталась на месте");
    expect(text).not.toContain("видна в работающем OpenCode");
  });

  it("names the project-local database as the cause when the row landed outside the served one", () => {
    const text = convertOutcomeText(outcome({
      visibleInOpenCode: false,
      visibilityNote: "перенос записан в project-local базу `/work/dir/.opencode/opencode.db` (таблица `sessions`), а работающий OpenCode читает глобальную базу `/home/user/.local/share/opencode/opencode.db`",
    }));
    expect(text).toContain("причина: перенос записан в project-local базу");
    expect(text).toContain("глобальную базу");
    expect(text).not.toContain("видна в работающем OpenCode");
  });

  it("says plainly that the running OpenCode did not answer", () => {
    const text = convertOutcomeText(outcome({
      visibleInOpenCode: false,
      visibilityNote: "работающий OpenCode не ответил (connection refused), поэтому видимость новой сессии не подтверждена",
    }));
    expect(text).toContain("не ответил");
    expect(text).not.toContain("видна в работающем OpenCode");
  });

  it("explains a failed conversion", () => {
    const text = convertOutcomeText(outcome({ ok: false, error: "Не удалось прочитать переписку." }));
    expect(text).toBe("Не удалось прочитать переписку.");
  });
});

describe("conversion request", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("asks the server to convert the session into OpenCode", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      transferred: { messageCount: 12, targetSessionId: "ses_x" },
      visibleInOpenCode: true,
      visibilityNote: "",
      stayed: { sessionId: "s1", harness: "codex" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await convertSessionToOpenCode({ id: "s1", harness: "codex" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toBe("/api/sessions/codex/s1/convert");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ to: "opencode" });
    expect(result.ok).toBe(true);
    expect(result.transferred.messageCount).toBe(12);
  });

  it("keeps the server's own reason when the new session is not visible", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      transferred: { messageCount: 7, targetSessionId: "ses_y" },
      visibleInOpenCode: false,
      visibilityCause: "table-mismatch",
      visibilityNote: "перенос записан в таблицу `session`, а работающий OpenCode читает таблицу `session_v2`",
      stayed: { sessionId: "s1", harness: "codex" },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const result = await convertSessionToOpenCode({ id: "s1", harness: "codex" });
    expect(result.visibleInOpenCode).toBe(false);
    expect(result.visibilityCause).toBe("table-mismatch");
    expect(convertOutcomeText(result)).toContain("причина: перенос записан в таблицу `session`");
  });

  it("carries the server's own explanation when the server refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Перевод в OpenCode доступен только для сессий Codex." }), {
      status: 400, headers: { "content-type": "application/json" },
    })));
    const result = await convertSessionToOpenCode({ id: "s1", harness: "opencode" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("только для сессий Codex");
  });

  it("explains a broken connection in the owner's words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const result = await convertSessionToOpenCode({ id: "s1", harness: "codex" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("network down");
  });
});
