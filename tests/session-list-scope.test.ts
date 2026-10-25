import { describe, expect, it } from "vitest";
import {
  mergeScopeAnswers,
  scopeCountsFromAnswers,
  scopeProbeQueries,
  sessionScopeQuery,
  sliceScopeQueries,
  statusInSlice,
} from "../src/web-ui/session-list-scope.js";

/**
 * Счётчик и список сессий обязаны говорить одно и то же. Для этого отбор
 * ведётся на сервере, а числа берутся с того же сервера: клиентский пересчёт
 * по загруженному окну давал владельцу одно число, а на экране было другое.
 */

describe("срез списка сессий", () => {
  it("отбирает статусы, которые значат «работает»", () => {
    expect(statusInSlice("running", "working")).toBe(true);
    expect(statusInSlice("needs_input", "working")).toBe(true);
    expect(statusInSlice("idle", "working")).toBe(false);
    expect(statusInSlice("stopped", "working")).toBe(false);
  });

  it("«все» значит все статусы, включая завершённые", () => {
    expect(statusInSlice("stopped", "all")).toBe(true);
    expect(statusInSlice("error", "all")).toBe(true);
  });

  it("спрашивает сервер по статусам среза", () => {
    expect(sliceScopeQueries("working", "zcode")).toEqual([
      { harness: "zcode", status: "running" },
      { harness: "zcode", status: "needs_input" },
    ]);
    expect(sliceScopeQueries("waiting", "")).toEqual([{ harness: undefined, status: "idle" }]);
    expect(sliceScopeQueries("all", "zcode")).toEqual([{ harness: "zcode" }]);
  });

  it("поиск идёт мимо среза: он ищет в любом статусе", () => {
    expect(sliceScopeQueries("working", "zcode", true)).toEqual([{ harness: "zcode" }]);
  });

  it("склеивает окна запросов и не дублирует сессии", () => {
    const merged = mergeScopeAnswers(
      [
        { sessions: [{ id: "a" }, { id: "b" }], total: 2 },
        { sessions: [{ id: "b" }, { id: "c" }], total: 2 },
      ],
      (session) => session.id,
    );
    expect(merged.sessions.map((session) => session.id)).toEqual(["a", "b", "c"]);
    expect(merged.total).toBe(4);
  });

  it("считает числа по ответам сервера", () => {
    const counts = scopeCountsFromAnswers(
      [
        { harness: "zcode", status: "running", total: 3 },
        { harness: "zcode", status: "needs_input", total: 1 },
        { harness: "zcode", status: "idle", total: 20 },
        { harness: "zcode", total: 30 },
        { harness: "codex", status: "running", total: 5 },
        { harness: "codex", status: "needs_input", total: 0 },
      ],
      { slice: "working", harness: "zcode", harnesses: ["zcode", "codex"] },
    );
    expect(counts.byStatus.running).toBe(3);
    expect(counts.byStatus.needs_input).toBe(1);
    expect(counts.byStatus.idle).toBe(20);
    expect(counts.total).toBe(30);
    expect(counts.byHarness).toEqual([
      { harness: "zcode", count: 4 },
      { harness: "codex", count: 5 },
    ]);
  });

  it("спрашивает сервер обо всех срезах выбранной среды", () => {
    const queries = scopeProbeQueries({ slice: "working", harness: "zcode", harnesses: ["zcode", "codex"] });
    expect(queries).toContainEqual({ harness: "zcode", status: "running" });
    expect(queries).toContainEqual({ harness: "zcode", status: "needs_input" });
    expect(queries).toContainEqual({ harness: "zcode", status: "idle" });
    expect(queries).toContainEqual({ harness: "zcode" });
    expect(queries).toContainEqual({ harness: "codex", status: "running" });
  });

  it("запрос списка несёт срез, среду и окно", () => {
    expect(sessionScopeQuery({ harness: "zcode", status: "running" }, 100)).toBe(
      "/api/sessions?quick=1&limit=100&harness=zcode&status=running",
    );
  });
});
