import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { SessionInspectBlock, machineLabel, modelRows, subagentStatusLabel } from "../src/web-ui/session-work-target.js";
import { machineName } from "../src/web-ui/session-sidebar.js";

describe("session inspector block", () => {
  const facts = {
    model: { native: "gpt-6.1-sol" },
    lastAction: { label: "Работа с git", tool: "shell" },
    files: [{ path: "src/web/server.ts", operation: "Изменение файлов" }],
    worktreeFiles: [],
    subagents: { count: 1, items: [{ id: "c1", name: "Проверить отчёт", named: true, role: "worker", status: "running" }] },
    history: { source: "acp-load", complete: true },
  };

  it("shows one model row and marks a pending next answer apart", () => {
    const html = renderToStaticMarkup(React.createElement(SessionInspectBlock, { facts }));
    expect(html).toContain("Модель");
    expect(html).not.toContain("Следующий ответ");
  });

  it("marks the pending next answer when it differs", () => {
    const html = renderToStaticMarkup(React.createElement(SessionInspectBlock, { facts, pendingModel: "gpt-6-luna" }));
    expect(html).toContain("Следующий ответ");
    expect(html).toContain("gpt-6-luna");
    expect(html).toContain("inspector-facts-pending");
  });

  it("answers what the agent does now and which files it changed", () => {
    const html = renderToStaticMarkup(React.createElement(SessionInspectBlock, { facts }));
    expect(html).toContain("Работа с git");
    expect(html).toContain("src/web/server.ts");
  });

  it("says plainly when nothing is known", () => {
    const html = renderToStaticMarkup(React.createElement(SessionInspectBlock, {
      facts: { ...facts, lastAction: null, files: [], worktreeFiles: [], subagents: { count: 0, items: [] } },
    }));
    expect(html).toContain("действий пока нет");
    expect(html).toContain("изменённых файлов не зафиксировано");
    expect(html).toContain("дочерних сессий нет");
  });

  it("names the subagent and its status instead of a placeholder", () => {
    const html = renderToStaticMarkup(React.createElement(SessionInspectBlock, {
      facts: { ...facts, subagents: { count: 1, items: [{ id: "c1", name: "название не сохранилось", named: false, status: "idle" }] } },
    }));
    expect(html).toContain("название не сохранилось");
    expect(html).toContain("Ожидает запуска");
    expect(html).not.toContain("Untitled session");
  });
});

describe("machine labels", () => {
  it("names the fleet machines in words", () => {
    expect(machineLabel("roomhacker-server-100")).toBe("Сервер 100");
    expect(machineLabel("roomhacker-server-88")).toBe("Сервер 88");
    expect(machineLabel("roomhacker-server-44")).toBe("Сервер 44");
    expect(machineLabel("mac-mini")).toBe("Mac Mini");
    expect(machineLabel("mac-m1")).toBe("Mac M1");
  });

  it("keeps an unknown machine identifiable", () => {
    expect(machineLabel("other-host", "Другая машина")).toBe("Другая машина");
  });

  it("names the sidebar machine in words too", () => {
    expect(machineName("roomhacker-server-100")).toBe("Сервер 100");
    expect(machineName("mac-m1")).toBe("Mac M1");
    expect(machineName(undefined)).toBe("Машина не подтверждена");
  });
});

describe("model rows", () => {
  it("shows one row when the pending model equals the one in use", () => {
    expect(modelRows("gpt-6.1-sol", "gpt-6.1-sol")).toEqual([{ label: "Модель", value: "gpt-6.1-sol" }]);
  });

  it("marks a different pending model apart", () => {
    expect(modelRows("gpt-6.1-sol", "gpt-6-luna")).toEqual([
      { label: "Модель", value: "gpt-6.1-sol" },
      { label: "Следующий ответ", value: "gpt-6-luna", pending: true },
    ]);
  });

  it("does not claim a model when the server confirmed none", () => {
    expect(modelRows(undefined, undefined)).toEqual([{ label: "Модель", value: "не подтверждена" }]);
  });
});

describe("subagent status", () => {
  it("says what the child session is doing", () => {
    expect(subagentStatusLabel("running")).toBe("Работает");
    expect(subagentStatusLabel("idle")).toBe("Ожидает запуска");
  });
});
