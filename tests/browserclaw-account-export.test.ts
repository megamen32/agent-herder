import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserClawAccountExportDriver, BrowserClawMcpA11yClient } from "../src/browserclaw-cdp-chat.js";
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

  it("accepts semantically named settings and data-controls links when BrowserClaw reports roles differently", async () => {
    const snapshots = [
      snapshot("home", [{ ref: "profile", role: "button", name: "Profile", children: [] }]),
      snapshot("menu", [{ ref: "settings", role: "link", name: "Open Settings", children: [] }]),
      snapshot("menu", [{ ref: "settings", role: "link", name: "Open Settings", children: [] }]),
      snapshot("settings", [{ ref: "data", role: "link", name: "Data Controls", children: [] }]),
      snapshot("settings", [{ ref: "data", role: "link", name: "Data Controls", children: [] }]),
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

  it("records the actual Data Controls nodes when the export flow stops before the export button", async () => {
    const snapshots = [
      snapshot("home", [{ ref: "profile", role: "button", name: "Profile", children: [] }]),
      snapshot("menu", [{ ref: "settings", role: "menuitem", name: "Settings", children: [] }]),
      snapshot("menu", [{ ref: "settings", role: "menuitem", name: "Settings", children: [] }]),
      snapshot("settings", [{ ref: "data", role: "link", name: "Privacy settings", description: "Manage your data controls", children: [] }]),
      snapshot("settings", [{ ref: "data", role: "link", name: "Privacy settings", description: "Manage your data controls", children: [] }]),
      snapshot("data", [{ ref: "other", role: "text", name: "No export control", children: [] }]),
      snapshot("data", [{ ref: "other", role: "text", name: "No export control", children: [] }]),
    ];
    const actions: string[] = [];
    const diagnostics: unknown[] = [];
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

    await expect(BrowserClawAccountExportDriver.fromOwnedPage(page, {
      async capture(input) { diagnostics.push(input); },
    }).requestAccountExport()).rejects.toThrow("account export control was not found");
    expect(actions).toEqual(["profile", "settings", "data"]);
    expect(diagnostics).toMatchObject([{
      outcome: "failed",
      stage: "account export",
      stoppedNode: { role: "text", name: "No export control" },
    }]);
  });

  it("matches a semantically named Export Data link in Data Controls", async () => {
    const snapshots = [
      snapshot("home", [{ ref: "profile", role: "button", name: "Profile", children: [] }]),
      snapshot("menu", [{ ref: "settings", role: "menuitem", name: "Settings", children: [] }]),
      snapshot("menu", [{ ref: "settings", role: "menuitem", name: "Settings", children: [] }]),
      snapshot("settings", [{ ref: "data", role: "link", name: "Privacy settings", description: "Manage your data controls", children: [] }]),
      snapshot("settings", [{ ref: "data", role: "link", name: "Privacy settings", description: "Manage your data controls", children: [] }]),
      snapshot("data", [{ ref: "export", role: "link", name: "Export Data", children: [] }]),
      snapshot("data", [{ ref: "export", role: "link", name: "Export Data", children: [] }]),
      snapshot("confirm", [{ ref: "confirm", role: "button", name: "Confirm export", children: [] }]),
      snapshot("confirm", [{ ref: "confirm", role: "button", name: "Confirm export", children: [] }]),
      snapshot("receipt", [{ ref: "done", role: "alert", name: "Request sent", children: [] }]),
      snapshot("receipt", [{ ref: "done", role: "alert", name: "Request sent", children: [] }]),
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

    await expect(BrowserClawAccountExportDriver.fromOwnedPage(page).requestAccountExport()).resolves.toMatchObject({ status: "requested" });
    expect(actions).toEqual(["profile", "settings", "data", "export", "confirm"]);
  });

  it("writes a redacted a11y tree and same-page screenshot artifact on a failed export control", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-account-export-diagnostic-"));
    const previousRoot = process.env.CHATGPT_ACCOUNT_EXPORT_DIAGNOSTIC_ROOT;
    process.env.CHATGPT_ACCOUNT_EXPORT_DIAGNOSTIC_ROOT = root;
    try {
      const client = {
        sessionRef: "session-diagnostic",
        async callToolImage(name: string, args: Record<string, unknown>) {
          expect(name).toBe("screenshot");
          expect(args).toMatchObject({ page: 7, format: "png" });
          return { mimeType: "image/png" as const, data: Buffer.from("png-test-image").toString("base64") };
        },
      };
      const reporter = new BrowserClawMcpA11yClient(client as never);
      const artifact = await reporter.captureAccountExportDiagnostic({
        outcome: "failed",
        stage: "account export",
        failure: "control was not found",
        snapshot: {
          schema: "agent-herder.browserclaw-a11y.v1",
          page: 7,
          url: "https://chatgpt.com/#settings?secret=never-recorded",
          snapshotRef: "snapshot-1",
          root: { ref: "root", role: "document", children: [{ ref: "privacy", role: "link", name: "Privacy settings", description: "Manage your data controls", children: [] }] },
        },
      });
      const a11y = await readFile(artifact.a11yPath, "utf8");
      expect(a11y).toContain('"role": "link"');
      expect(a11y).toContain('"name": "Privacy settings"');
      expect(a11y).toContain('"url": "https://chatgpt.com/"');
      expect(a11y).not.toContain("secret=never-recorded");
      expect(artifact.screenshotPath).toBeDefined();
      expect(await stat(artifact.a11yPath)).toMatchObject({ mode: expect.any(Number) });
      expect((await stat(artifact.a11yPath)).mode & 0o777).toBe(0o600);
      expect((await stat(artifact.screenshotPath!)).mode & 0o777).toBe(0o600);
      expect(await readdir(root)).toHaveLength(2);
    } finally {
      if (previousRoot === undefined) delete process.env.CHATGPT_ACCOUNT_EXPORT_DIAGNOSTIC_ROOT;
      else process.env.CHATGPT_ACCOUNT_EXPORT_DIAGNOSTIC_ROOT = previousRoot;
      await rm(root, { recursive: true, force: true });
    }
  });
});
