import { describe, expect, it } from "vitest";
import {
  BrowserClawA11yPageError,
  createBrowserClawA11yDriver,
  type BrowserClawA11yClient,
  type BrowserClawA11ySnapshot,
  type BrowserClawA11yTab,
  type BrowserClawSemanticAction,
} from "../src/browserclaw-a11y-page.js";
import { BrowserClawA11yError } from "../src/browserclaw-a11y.js";

const targetUrl = "https://chatgpt.com/c/disposable";

function snapshot(page: number, snapshotRef: string, url = targetUrl): BrowserClawA11ySnapshot {
  return {
    schema: "agent-herder.browserclaw-a11y.v1",
    page,
    url,
    snapshotRef,
    root: {
      ref: "root",
      role: "document",
      children: [{ ref: "new-chat", role: "button", name: "New chat", children: [] }],
    },
  };
}

class FakeA11yClient implements BrowserClawA11yClient {
  sessionRef = "session-a";
  tabs: BrowserClawA11yTab[] = [{ page: 7, url: targetUrl }];
  snapshots = [snapshot(7, "snapshot-1"), snapshot(7, "snapshot-2")];
  listedTabs = 0;
  snapshotCalls: number[] = [];
  actions: Array<{ page: number; action: BrowserClawSemanticAction }> = [];

  async listTabs(): Promise<readonly BrowserClawA11yTab[]> {
    this.listedTabs += 1;
    return structuredClone(this.tabs);
  }

  async snapshotPage(page: number): Promise<BrowserClawA11ySnapshot> {
    this.snapshotCalls.push(page);
    const result = this.snapshots.shift();
    if (!result) throw new Error("no fake snapshot available");
    return structuredClone(result);
  }

  async actPage(page: number, action: BrowserClawSemanticAction): Promise<BrowserClawA11ySnapshot> {
    this.actions.push({ page, action: structuredClone(action) });
    const result = this.snapshots.shift();
    if (!result) throw new Error("no fake post-action snapshot available");
    return structuredClone(result);
  }
}

function driverFor(client: FakeA11yClient) {
  return createBrowserClawA11yDriver(client, { targetUrl });
}

describe("owned BrowserClaw accessibility page", () => {
  it("binds one page lease, sends only semantic actions, and returns a fresh snapshot", async () => {
    const client = new FakeA11yClient();
    const page = await driverFor(client).acquirePage();

    const first = await page.snapshot(Date.now() + 5_000);
    const second = await page.act({
      snapshotRef: first.snapshotRef,
      action: { kind: "click", ref: "new-chat" },
    }, Date.now() + 5_000);

    expect(first.snapshotRef).toBe("snapshot-1");
    expect(second.snapshotRef).toBe("snapshot-2");
    expect(client.actions).toEqual([{ page: 7, action: { kind: "click", ref: "new-chat" } }]);
    expect(client.listedTabs).toBe(2);
    expect(client.snapshotCalls).toEqual([7]);
  });

  it("rejects stale or unknown semantic refs before calling the browser", async () => {
    const client = new FakeA11yClient();
    const page = await driverFor(client).acquirePage();
    const first = await page.snapshot(Date.now() + 5_000);

    await expect(page.act({
      snapshotRef: "snapshot-old",
      action: { kind: "click", ref: "new-chat" },
    }, Date.now() + 5_000)).rejects.toMatchObject<Partial<BrowserClawA11yError>>({ code: "stale_snapshot_ref" });
    await expect(page.act({
      snapshotRef: first.snapshotRef,
      action: { kind: "click", ref: "missing" },
    }, Date.now() + 5_000)).rejects.toMatchObject<Partial<BrowserClawA11yError>>({ code: "stale_node_ref" });
    expect(client.actions).toHaveLength(0);
  });

  it("fails closed when the leased page disappears or is reused, without switching tabs", async () => {
    const client = new FakeA11yClient();
    const page = await driverFor(client).acquirePage();
    client.tabs = [
      { page: 8, url: targetUrl },
      { page: 7, url: "https://chatgpt.com/" },
    ];

    await expect(page.snapshot(Date.now() + 5_000)).rejects.toMatchObject<Partial<BrowserClawA11yPageError>>({ code: "page_lease_lost" });
    expect(client.snapshotCalls).toEqual([]);
  });

  it("invalidates the lease when the MCP session changes and rejects duplicate targets", async () => {
    const client = new FakeA11yClient();
    const page = await driverFor(client).acquirePage();
    client.sessionRef = "session-reconnected";

    await expect(page.snapshot(Date.now() + 5_000)).rejects.toMatchObject<Partial<BrowserClawA11yPageError>>({ code: "page_lease_lost" });

    const duplicateClient = new FakeA11yClient();
    duplicateClient.tabs = [
      { page: 7, url: targetUrl },
      { page: 8, url: targetUrl },
    ];
    await expect(driverFor(duplicateClient).acquirePage()).rejects.toMatchObject<Partial<BrowserClawA11yPageError>>({ code: "browser_action_failed" });
  });

  it("can preserve one SPA page through an explicitly allowed path transition", async () => {
    const client = new FakeA11yClient();
    const page = await createBrowserClawA11yDriver(client, {
      targetUrl: "https://chatgpt.com/",
      allowPathPrefix: "/",
    }).acquirePage();
    client.tabs = [{ page: 7, url: "https://chatgpt.com/c/disposable" }];
    client.snapshots = [snapshot(7, "snapshot-3")];

    await expect(page.snapshot(Date.now() + 5_000)).resolves.toMatchObject({ snapshotRef: "snapshot-3" });
  });

  it("keeps an explicitly selected owned page when unrelated matching tabs are visible", async () => {
    const client = new FakeA11yClient();
    const page = await createBrowserClawA11yDriver(client, {
      targetUrl,
      page: 7,
    }).acquirePage();
    client.tabs = [
      { page: 7, url: targetUrl },
      { page: 8, url: targetUrl },
    ];
    client.snapshots = [snapshot(7, "snapshot-owned")];

    await expect(page.snapshot(Date.now() + 5_000)).resolves.toMatchObject({ snapshotRef: "snapshot-owned" });
  });
});
