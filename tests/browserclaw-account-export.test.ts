import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BrowserClawAccountExportDriver,
  BrowserClawCdpMcpClient,
  BrowserClawMcpA11yClient,
  isChatHistoryConversationUrl,
  visibleSidebarChats,
} from "../src/browserclaw-cdp-chat.js";
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

  it("writes a same-page screenshot receipt for a history archive capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-history-archive-diagnostic-"));
    const previousRoot = process.env.CHATGPT_HISTORY_ARCHIVE_DIAGNOSTIC_ROOT;
    process.env.CHATGPT_HISTORY_ARCHIVE_DIAGNOSTIC_ROOT = root;
    try {
      const client = {
        sessionRef: "session-history-diagnostic",
        async callToolImage(name: string, args: Record<string, unknown>) {
          expect(name).toBe("screenshot");
          expect(args).toMatchObject({ page: 7, format: "png" });
          return { mimeType: "image/png" as const, data: Buffer.from("png-history-image").toString("base64") };
        },
      };
      const reporter = new BrowserClawMcpA11yClient(client as never);
      const artifact = await reporter.captureHistoryArchiveDiagnostic({
        outcome: "captured",
        stage: "open_chat",
        snapshot: snapshot("history", []),
      });

      expect(artifact.screenshotPath).toBeDefined();
      const receipt = JSON.parse(await readFile(artifact.receiptPath, "utf8")) as Record<string, unknown>;
      expect(receipt).toMatchObject({
        schema: "agent-herder.chatgpt-history-archive-diagnostic.v1",
        outcome: "captured",
        stage: "open_chat",
        url: "https://chatgpt.com/",
        screenshot: { captured: true },
      });
      expect((await stat(artifact.receiptPath)).mode & 0o777).toBe(0o600);
      expect((await stat(artifact.screenshotPath!)).mode & 0o777).toBe(0o600);
    } finally {
      if (previousRoot === undefined) delete process.env.CHATGPT_HISTORY_ARCHIVE_DIAGNOSTIC_ROOT;
      else process.env.CHATGPT_HISTORY_ARCHIVE_DIAGNOSTIC_ROOT = previousRoot;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes the owned tab URL after a semantic action", async () => {
    const calls: string[] = [];
    const client = {
      sessionRef: "session-route-refresh",
      async callToolRaw(name: string) {
        calls.push(name);
        if (name === "tabs") {
          return { result: { content: [{ type: "text", text: "[7] https://chatgpt.com/c/real-chat" }] } };
        }
        if (name === "snapshot") {
          return { result: { content: [{ type: "text", text: 'button "Chat" [ref=e1]' }] } };
        }
        return { result: { content: [] } };
      },
    };

    const snapshot = await new BrowserClawMcpA11yClient(client as never).actPage(7, { kind: "click", ref: "e1" });
    expect(calls).toEqual(["act", "tabs", "snapshot"]);
    expect(snapshot.url).toBe("https://chatgpt.com/c/real-chat");
  });

  it("resumes an existing BrowserClaw MCP session without sending initialize again", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ method: string; sessionId: string | null }> = [];
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      const headers = new Headers(init?.headers);
      calls.push({ method: body.method, sessionId: headers.get("mcp-session-id") });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
        status: 200,
        headers: { "mcp-session-id": "resumed-session" },
      });
    }) as typeof fetch;
    try {
      const client = await BrowserClawCdpMcpClient.connect("http://browserclaw.test/mcp", Date.now() + 5_000, undefined, "resumed-session");
      expect(client.sessionRef).toBe("resumed-session");
      expect(calls).toEqual([{ method: "tools/list", sessionId: "resumed-session" }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reads only same-page ChatGPT conversation links without opening a tab", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      sessionRef: "session-history-links",
      async callToolRaw(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return {
          result: {
            content: [{
              type: "text",
              text: [
                "[Research article](https://chatgpt.com/c/real-chat)",
                "[Project](https://chatgpt.com/g/project)",
                "[Another article](/c/another-chat)",
              ].join("\n"),
            }],
          },
        };
      },
    };

    const routes = await new BrowserClawMcpA11yClient(client as never).conversationSidebarRoutes(7);

    expect(routes).toEqual(new Map([
      ["research article", ["/c/real-chat"]],
      ["another article", ["/c/another-chat"]],
    ]));
    expect(calls).toEqual([{ name: "read", args: { page: 7, format: "links" } }]);
  });

  it("keeps only compact non-navigation sidebar links as chat candidates", () => {
    const rows = visibleSidebarChats({
      schema: "agent-herder.browserclaw-a11y.v1",
      page: 7,
      url: "https://chatgpt.com/",
      snapshotRef: "sidebar",
      root: {
        ref: "root",
        role: "document",
        children: [{
          ref: "shell",
          role: "link",
          name: "ChatGPT shell container",
          children: [
          { ref: "library", role: "link", name: "Библиотека", children: [] },
            { ref: "history", role: "group", children: [
              { ref: "chat-1", role: "link", name: "Research article", children: [{ ref: "menu", role: "button", name: "More", children: [] }] },
              { ref: "chat-2", role: "link", name: "Deep research", children: [] },
            ] },
          ],
        }],
      },
    }, "test");

    expect(rows.map((row) => row.nodeRef)).toEqual(["chat-1", "chat-2"]);
    expect(isChatHistoryConversationUrl("https://chatgpt.com/c/real-chat")).toBe(true);
    expect(isChatHistoryConversationUrl("https://chatgpt.com/")).toBe(false);
  });

  it("keeps repeated a11y labels distinct for the post-click route check", () => {
    const rows = visibleSidebarChats({
      schema: "agent-herder.browserclaw-a11y.v1",
      page: 7,
      url: "https://chatgpt.com/",
      snapshotRef: "duplicate-sidebar-rows",
      root: {
        ref: "root",
        role: "document",
        children: [{ ref: "history", role: "group", children: [
          { ref: "chat-row-a", role: "link", name: "Same title", children: [] },
          { ref: "chat-row-b", role: "link", name: "Same title", children: [] },
        ] }],
      },
    }, "test");

    expect(rows.map((row) => row.nodeRef)).toEqual(["chat-row-a", "chat-row-b"]);
    expect(rows[0]!.id).toBe(rows[1]!.id);
  });

  it("keeps a history binding stable across BrowserClaw sessions when its /c route is known", () => {
    const routes = new Map([["research article", ["/c/stable-conversation"]]]) as never;
    const first = visibleSidebarChats({
      schema: "agent-herder.browserclaw-a11y.v1",
      page: 7,
      url: "https://chatgpt.com/",
      snapshotRef: "first-session",
      root: { ref: "root", role: "document", children: [{ ref: "history", role: "group", children: [{ ref: "chat-a", role: "link", name: "Research article", children: [] }] }] },
    }, "first-browserclaw-session", routes);
    const second = visibleSidebarChats({
      schema: "agent-herder.browserclaw-a11y.v1",
      page: 8,
      url: "https://chatgpt.com/",
      snapshotRef: "second-session",
      root: { ref: "root", role: "document", children: [{ ref: "history", role: "group", children: [{ ref: "chat-b", role: "link", name: "Research article", children: [] }] }] },
    }, "second-browserclaw-session", routes);

    expect(first[0]!.id).toBe(second[0]!.id);
  });

  it("keeps a chat binding stable across fresh a11y refs", () => {
    const before = visibleSidebarChats({
      schema: "agent-herder.browserclaw-a11y.v1",
      page: 7,
      url: "https://chatgpt.com/",
      snapshotRef: "before-refresh",
      root: { ref: "root", role: "document", children: [{ ref: "history", role: "group", children: [{ ref: "chat-before", role: "link", name: "Research article", children: [] }] }] },
    }, "test");
    const after = visibleSidebarChats({
      schema: "agent-herder.browserclaw-a11y.v1",
      page: 7,
      url: "https://chatgpt.com/",
      snapshotRef: "after-refresh",
      root: { ref: "root", role: "document", children: [{ ref: "history", role: "group", children: [{ ref: "chat-after", role: "link", name: "Research article", children: [] }] }] },
    }, "test");

    expect(before[0]!.nodeRef).not.toBe(after[0]!.nodeRef);
    expect(before[0]!.id).toBe(after[0]!.id);
  });
});
