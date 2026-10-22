import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { baseVersions, recordValue, recordsOf, saveSettings, type SettingsView } from "../src/web-ui/settings/settings-client.js";
import { currentRunsNotice, nodeStatusText } from "../src/web-ui/settings/stop-control.js";

/**
 * The form of the settings of the herder.
 *
 * The form shows the values of the settings and the way back. A secret is
 * typed once and never shown again, and the form never starts an executor of
 * the herder by opening or by reading the journal.
 */
describe("the form of the settings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const view = {
    ok: true,
    etag: "sha256:1234567890abcdef",
    records: [
      {
        id: "herder.env/NOTIFY_CENTER_PROJECT",
        humanName: "Подключение к центру уведомлений: проект",
        action: "Имя проекта.",
        scope: { kind: "node" },
        source: "override",
        origin: "explicit",
        desired: { value: "agent-herder", version: 3 },
        confirmed: { version: 3, state: "Записано", appliedAt: null, applyMode: "после перезапуска", requiresRestart: true },
        changedBy: "roomhacker",
        changedAt: "2026-10-22T12:00:00.000Z",
        rollbackRef: "entry-1",
      },
      {
        id: "herder.env/NOTIFY_CENTER_TOKEN",
        humanName: "Подключение к центру уведомлений: ключ",
        action: "Ключ.",
        scope: { kind: "node" },
        source: "override",
        origin: "explicit",
        desired: { value: null, version: 2, fingerprint: "sha256:abcdef0123456789" },
        confirmed: { version: 2, state: "Записано", appliedAt: null, applyMode: "после перезапуска", requiresRestart: true },
        changedBy: "roomhacker",
        changedAt: "2026-10-22T12:00:00.000Z",
        rollbackRef: "entry-2",
      },
    ],
  } as unknown as SettingsView;

  it("shows the value of a plain setting and never the value of a secret", () => {
    expect(recordValue(view.records[0]!)).toBe("agent-herder");
    // A secret has no value at all: the form has nothing to show.
    expect(recordValue(view.records[1]!)).toBe("");
    expect(JSON.stringify(view.records[1]!)).not.toContain("center-token-value");
  });

  it("sends the version the owner read with every change", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ...view, applied: [] }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await saveSettings({ environment: { NOTIFY_CENTER_PROJECT: "agent-herder" } }, view.etag);
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("/api/settings");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["if-match"]).toBe(view.etag);
    // The value of a secret is not in the answer of the server.
    expect(JSON.stringify(result)).not.toContain("center-token-value");
  });

  it("carries the difference of a conflict instead of overwriting", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      ok: false,
      code: "version_conflict",
      error: "Настройки изменились",
      difference: [{ id: "herder.env/NOTIFY_CENTER_PROJECT", key: "NOTIFY_CENTER_PROJECT", entity: "herder.env", baseVersion: 3, currentVersion: 4, changedBy: "roomhacker", changedAt: "2026-10-22T12:05:00.000Z" }],
      current: { etag: "sha256:0000000000000000", records: [] },
    }), { status: 412, headers: { "content-type": "application/json" } }));

    const result = await saveSettings({ environment: { NOTIFY_CENTER_PROJECT: "agent-herder" } }, view.etag);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("version_conflict");
    expect(result.difference?.[0]?.currentVersion).toBe(4);
  });

  it("remembers the version of every record the owner edited", () => {
    const versions = baseVersions(view, ["herder.env/NOTIFY_CENTER_PROJECT"]);
    expect(versions).toEqual({ "herder.env/NOTIFY_CENTER_PROJECT": 3 });
    // A record that is not in the read is not in the precondition.
    expect(baseVersions(view, ["herder.env/NOTIFY_CENTER_PROJECT", "herder.env/NOT_SET"])).toEqual({
      "herder.env/NOTIFY_CENTER_PROJECT": 3,
    });
  });

  it("shows the state of a node as unknown when the node did not answer", () => {
    expect(nodeStatusText({ hostId: "node-44", status: "unreachable" }).known).toBe(false);
    expect(nodeStatusText({ hostId: "node-44", status: "applied" }).known).toBe(true);
    expect(nodeStatusText({ hostId: "node-44", status: "error", reason: "нет связи" }).known).toBe(true);
    // A node without a status is unknown, never "включено".
    expect(nodeStatusText({ hostId: "node-44" }).known).toBe(false);
  });

  it("says when the current runs of the area were not stopped", () => {
    expect(currentRunsNotice({ applied: false, reason: "нет маппинга на живые сессии" })).toContain("не остановлены");
    expect(currentRunsNotice({ applied: true, reason: "" })).toBeNull();
  });

  it("asks the server to move the lever of the owner and never takes its token", async () => {
    const source = await readFile(join(process.cwd(), "src", "web-ui", "settings", "stop-control.tsx"), "utf8");
    // The token of the lever stays on the server.
    expect(source).not.toContain("AGENT_HERDER_DISARM_TOKEN");
    expect(source).not.toContain("disarmToken");
    // The flag of a human request is not an authority.
    expect(source).not.toContain("humanRequested");
    // The panel asks the server to move the lever on behalf of the owner.
    expect(source).toContain("/api/settings/automation/disarm");
  });

  it("starts no executor of the herder and keeps no secret in the browser", async () => {
    const root = join(process.cwd(), "src", "web-ui", "settings");
    const sources = await Promise.all([
      readFile(join(root, "settings-screen.tsx"), "utf8"),
      readFile(join(root, "settings-client.ts"), "utf8"),
      readFile(join(root, "stop-control.tsx"), "utf8"),
    ]);
    const code = sources.join("\n");

    // Nothing that would start an executor of the herder.
    expect(code).not.toContain("/api/sessions/new-or-resume");
    expect(code).not.toContain("/api/models");
    expect(code).not.toContain("new-or-resume");
    // The form keeps no secret in the storage of the browser and prints
    // nothing to the console.
    expect(code).not.toContain("localStorage");
    expect(code).not.toContain("sessionStorage");
    expect(code).not.toContain("console.log");
    expect(code).not.toContain("console.warn");
    // The value of a secret never goes into the address bar.
    expect(code).not.toContain("location.search");
    expect(code).not.toContain("history.pushState");
  });
});
