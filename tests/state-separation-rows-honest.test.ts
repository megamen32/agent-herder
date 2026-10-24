import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  NETWORK_PAUSE_KEY,
  STATE_SEPARATION_ENDPOINT,
  STATE_SEPARATION_STALE_MS,
  StateSeparationTable,
  loadStateSeparation,
  networkPauseRowText,
  separationDimension,
  stateSeparationReadAtText,
  stateSeparationRows,
  type SeparationDimension,
  type SeparatedStateView,
} from "../src/web-ui/state-separation-rows.js";

afterEach(() => vi.unstubAllGlobals());

const source = readFileSync(new URL("../src/web-ui/state-separation-rows.tsx", import.meta.url), "utf8");

/** The dimension of the pause, as the route of the separated states answers it. */
const pause = (over: Partial<SeparationDimension> = {}): SeparationDimension => ({
  key: NETWORK_PAUSE_KEY,
  title: "Сетевая аварийная пауза Notice Place",
  state: "active",
  active: true,
  known: true,
  source: "systemctl is-active noticeplace-ai-pause.service",
  owner: "оператор узла",
  reason: "Аварийная пауза Notice Place действует",
  facts: { unit: "noticeplace-ai-pause.service", unitState: "active" },
  ...over,
});

/** The separated view of the five states, as the route answers it. */
const view = (dimensions: SeparationDimension[]): SeparatedStateView => ({
  ok: true,
  keys: ["session_stop", "prohibitions", "hooks", "quota_policy", NETWORK_PAUSE_KEY],
  dimensions,
  activeCount: dimensions.filter((dimension) => dimension.active === true).length,
  unknown: dimensions.filter((dimension) => dimension.known !== true).map((dimension) => dimension.key),
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The rows of the block, as the panel builds them. */
const rowsOf = (separation: SeparatedStateView | null, separationFailed = false) =>
  stateSeparationRows({
    held: null,
    heldFailed: false,
    quota: null,
    quotaFailed: false,
    hooksKnown: true,
    hooksEnabled: false,
    prohibitionsEnabled: false,
    separation,
    separationFailed,
  });

/** The table of the block, rendered as the owner sees it. */
const renderTable = (separation: SeparatedStateView | null, separationFailed = false, readAt: Date | null = null, now = new Date("2026-10-23T02:12:00Z")) =>
  renderToStaticMarkup(
    createElement(StateSeparationTable, { rows: rowsOf(separation, separationFailed), readAt, now }),
  );

const tbodyOf = (html: string): string => html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";

describe("the fifth row: the fact of the pause, not a promise of a route", () => {
  it("asks the route that separates the states", async () => {
    const body = view([pause()]);
    const fetch = vi.fn(async () => jsonResponse(body));
    vi.stubGlobal("fetch", fetch);
    const loaded = await loadStateSeparation();
    const [path, init] = fetch.mock.calls[0]!;
    expect(String(path)).toBe("/api/state-separation");
    expect(STATE_SEPARATION_ENDPOINT).toBe("/api/state-separation");
    expect(init).toMatchObject({ cache: "no-store" });
    expect(separationDimension(loaded, NETWORK_PAUSE_KEY)?.state).toBe("active");
  });

  it("shows the fact the route gives: the pause acts", () => {
    expect(networkPauseRowText({ view: view([pause()]) })).toBe("аварийная пауза действует");
  });

  it("shows the fact the route gives: the pause does not act", () => {
    expect(networkPauseRowText({
      view: view([pause({ state: "inactive", active: false, reason: "Аварийная пауза Notice Place не действует" })]),
    })).toBe("аварийная пауза не действует");
  });

  it("never turns an unknown state into an off one", () => {
    const unknown = networkPauseRowText({
      view: view([pause({ state: "unknown", active: false, known: false, reason: "Состояние юнита не прочитано" })]),
    });
    expect(unknown).toBe("состояние неизвестно");
    expect(unknown).not.toContain("не действует");
    expect(unknown).not.toContain("выключен");
  });

  it("says that the state was not read when the route cannot be reached", () => {
    const failed = networkPauseRowText({ view: null, failed: true });
    expect(failed).toBe("состояние не прочитано");
    expect(failed).not.toContain("нужен маршрут");
  });

  it("says that the state is unknown when the route knows no such state", () => {
    expect(networkPauseRowText({ view: view([]) })).toBe("состояние неизвестно");
  });

  it("never claims that the route is missing", () => {
    const texts = [
      networkPauseRowText({ view: view([pause()]) }),
      networkPauseRowText({ view: view([pause({ state: "inactive", active: false })]) }),
      networkPauseRowText({ view: view([pause({ state: "unknown", known: false })]) }),
      networkPauseRowText({ view: null, failed: true }),
      networkPauseRowText({ view: view([]) }),
    ];
    for (const text of texts) {
      expect(text).not.toContain("нужен маршрут");
      expect(text).not.toContain("/api/state-separation");
    }
    // The old lie must not come back to the source of the block.
    expect(source).not.toContain("нужен маршрут разделения состояний");
  });

  it("names the failure of the server in the answer of the client", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "Такого состояния нет." }, 404)));
    await expect(loadStateSeparation()).rejects.toThrow("Такого состояния нет.");
  });
});

describe("the block keeps five separate rows", () => {
  it("draws five rows, each one on its own source", () => {
    const rows = rowsOf(view([pause()]));
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.label)).toEqual([
      "Остановка сессии",
      "Запреты хуков",
      "Хуки Agent Herder",
      "Квотный гард",
      "Аварийная пауза уведомлений",
    ]);
  });

  it("renders five rows in the table", () => {
    const html = renderTable(view([pause()]));
    expect(tbodyOf(html).match(/<tr>/g) ?? []).toHaveLength(5);
    for (const label of ["Остановка сессии", "Запреты хуков", "Хуки Agent Herder", "Квотный гард", "Аварийная пауза уведомлений"]) {
      expect(html).toContain(label);
    }
  });

  it("puts the fact of the pause into the fifth row", () => {
    const html = renderTable(view([pause()]));
    const fifth = tbodyOf(html).match(/<tr>[\s\S]*?<\/tr>/g)?.at(-1) ?? "";
    expect(fifth).toContain("Аварийная пауза уведомлений");
    expect(fifth).toContain("аварийная пауза действует");
    expect(html).not.toContain("нужен маршрут");
  });

  it("keeps the pause apart from the other rows", () => {
    const rows = rowsOf(view([pause()]));
    const fifth = rows.at(-1);
    expect(fifth?.value).toBe("аварийная пауза действует");
    expect(rows[0]?.value).toBe("состояние читается…");
    expect(rows[1]?.value).toBe("запреты выключены");
    expect(rows[2]?.value).toBe("хуки Agent Herder выключены");
    expect(rows[3]?.value).toBe("состояние читается…");
  });
});

describe("the mark of the reading does not lie", () => {
  it("says when the states were read", () => {
    const readAt = new Date("2026-10-23T02:12:00Z");
    expect(stateSeparationReadAtText(readAt, new Date("2026-10-23T02:12:30Z"))).toBe("Состояния прочитаны в 05:12 МСК");
    expect(stateSeparationReadAtText(null)).toBe("");
  });

  it("marks old data as stale", () => {
    const readAt = new Date("2026-10-23T02:12:00Z");
    const old = new Date(readAt.getTime() + STATE_SEPARATION_STALE_MS + 1);
    expect(stateSeparationReadAtText(readAt, old)).toContain("данные устарели");
    expect(stateSeparationReadAtText(readAt, old)).toContain("05:12 МСК");
  });

  it("does not call fresh data stale", () => {
    const readAt = new Date("2026-10-23T02:12:00Z");
    const fresh = new Date(readAt.getTime() + STATE_SEPARATION_STALE_MS);
    expect(stateSeparationReadAtText(readAt, fresh)).not.toContain("устарели");
  });

  it("shows the mark in the block and keeps the human time", () => {
    const readAt = new Date("2026-10-23T02:12:00Z");
    const html = renderTable(view([pause()]), false, readAt, new Date(readAt.getTime() + STATE_SEPARATION_STALE_MS + 1));
    expect(html).toContain("Состояния прочитаны в 05:12 МСК");
    expect(html).toContain("данные устарели");
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("re-reads the states and marks the moment of the reading", () => {
    // The mark must follow the reading, not the mounting of the block.
    expect(source).toContain("if (read) setReadAt(new Date());");
    expect(source).toContain("setReadAt(new Date())");
  });
});
