import { describe, expect, it } from "vitest";
import { BrowserClawAccountExportDriver } from "../src/browserclaw-cdp-chat.js";
import type { BrowserClawA11yPage } from "../src/browserclaw-a11y-page.js";
import type { BrowserClawA11ySnapshot } from "../src/browserclaw-a11y.js";

function snapshot(snapshotRef: string, children: BrowserClawA11ySnapshot["root"]["children"]): BrowserClawA11ySnapshot {
  return {
    schema: "agent-herder.browserclaw-a11y.v1",
    page: 7,
    url: "https://chatgpt.com/#settings",
    snapshotRef,
    root: { ref: "root", role: "document", children },
  };
}

describe("BrowserClawAccountExportDriver", () => {
  it("uses one owned page through profile, settings, data management, export, and confirm", async () => {
    const snapshots = [
      snapshot("home", [{ ref: "profile", role: "button", name: "Nic, открыть меню профиля", children: [] }]),
      snapshot("menu", [{ ref: "settings", role: "menuitem", name: "Настройки", children: [] }]),
      snapshot("menu", [{ ref: "settings", role: "menuitem", name: "Настройки", children: [] }]),
      snapshot("settings", [{ ref: "data", role: "tab", name: "Управление данными", children: [] }]),
      snapshot("settings", [{ ref: "data", role: "tab", name: "Управление данными", children: [] }]),
      snapshot("data", [{ ref: "export", role: "button", name: "Экспорт данных", children: [] }]),
      snapshot("data", [{ ref: "export", role: "button", name: "Экспорт данных", children: [] }]),
      snapshot("confirm", [{ ref: "confirm", role: "button", name: "Подтвердить экспорт", children: [] }]),
      snapshot("confirm", [{ ref: "confirm", role: "button", name: "Подтвердить экспорт", children: [] }]),
      snapshot("receipt", [{ ref: "done", role: "alert", name: "Запрос отправлен", children: [] }]),
      snapshot("receipt", [{ ref: "done", role: "alert", name: "Запрос отправлен", children: [] }]),
    ];
    const actions: string[] = [];
    const page: BrowserClawA11yPage = {
      async snapshot() {
        const value = snapshots.shift();
        if (!value) throw new Error("missing initial snapshot");
        return value;
      },
      async act(input) {
        actions.push(input.action.kind === "click" ? input.action.ref : "unexpected");
        const value = snapshots.shift();
        if (!value) throw new Error("missing action snapshot");
        return value;
      },
    };

    const result = await BrowserClawAccountExportDriver.fromOwnedPage(page).requestAccountExport();
    expect(actions).toEqual(["profile", "settings", "data", "export", "confirm"]);
    expect(result).toMatchObject({ delivery: "email_or_sms", status: "requested" });
  });

  it("reports an existing request without clicking export again", async () => {
    const snapshots = [
      snapshot("home", [{ ref: "profile", role: "button", name: "Profile", children: [] }]),
      snapshot("menu", [{ ref: "settings", role: "menuitem", name: "Settings", children: [] }]),
      snapshot("menu", [{ ref: "settings", role: "menuitem", name: "Settings", children: [] }]),
      snapshot("settings", [{ ref: "data", role: "button", name: "Data Controls", children: [] }]),
      snapshot("settings", [{ ref: "data", role: "button", name: "Data Controls", children: [] }]),
      snapshot("data", [{ ref: "existing", role: "alert", name: "Export already requested", children: [] }]),
      snapshot("data", [{ ref: "existing", role: "alert", name: "Export already requested", children: [] }]),
    ];
    const actions: string[] = [];
    const page: BrowserClawA11yPage = {
      async snapshot() {
        const value = snapshots.shift();
        if (!value) throw new Error("missing initial snapshot");
        return value;
      },
      async act(input) {
        actions.push(input.action.kind === "click" ? input.action.ref : "unexpected");
        const value = snapshots.shift();
        if (!value) throw new Error("missing action snapshot");
        return value;
      },
    };

    await expect(BrowserClawAccountExportDriver.fromOwnedPage(page).requestAccountExport()).resolves.toMatchObject({ status: "already_requested" });
    expect(actions).toEqual(["profile", "settings", "data"]);
  });

  it("accepts a semantically named settings link when BrowserClaw reports a menu role differently", async () => {
    const snapshots = [
      snapshot("home", [{ ref: "profile", role: "button", name: "Profile", children: [] }]),
      snapshot("menu", [{ ref: "settings", role: "link", name: "Open Settings", children: [] }]),
      snapshot("menu", [{ ref: "settings", role: "link", name: "Open Settings", children: [] }]),
      snapshot("settings", [{ ref: "data", role: "button", name: "Data Controls", children: [] }]),
      snapshot("settings", [{ ref: "data", role: "button", name: "Data Controls", children: [] }]),
      snapshot("data", [{ ref: "existing", role: "alert", name: "Export already requested", children: [] }]),
      snapshot("data", [{ ref: "existing", role: "alert", name: "Export already requested", children: [] }]),
    ];
    const actions: string[] = [];
    const page: BrowserClawA11yPage = {
      async snapshot() {
        const value = snapshots.shift();
        if (!value) throw new Error("missing initial snapshot");
        return value;
      },
      async act(input) {
        actions.push(input.action.kind === "click" ? input.action.ref : "unexpected");
        const value = snapshots.shift();
        if (!value) throw new Error("missing action snapshot");
        return value;
      },
    };

    await expect(BrowserClawAccountExportDriver.fromOwnedPage(page).requestAccountExport()).resolves.toMatchObject({ status: "already_requested" });
    expect(actions).toEqual(["profile", "settings", "data"]);
  });
});
