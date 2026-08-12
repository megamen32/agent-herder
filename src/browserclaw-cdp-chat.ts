import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createBrowserClawA11yDriver,
  type BrowserClawA11yClient,
  type BrowserClawA11yPage,
  type BrowserClawA11yTab,
} from "./browserclaw-a11y-page.js";
import {
  normalizeBrowserClawA11yResponse,
  type BrowserClawA11yNode,
  type BrowserClawA11ySnapshot,
  type BrowserClawSemanticAction,
} from "./browserclaw-a11y.js";
import type { ChatGptAccountExportDriver } from "./chatgpt-account-archive.js";
import type { ChatGptHistoryArchiveDriver, ChatGptHistoryChat, ChatGptHistorySegment } from "./chatgpt-history-archive.js";
import type { ChatRecord, CdpChatCapabilities, CdpChatDriver, CdpChatPage, DownloadedMedia, MessageRecord, PageIdentity } from "./cdp-chat.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:9010/mcp";
const CHATGPT_ORIGIN = "https://chatgpt.com";
const DEFAULT_ACCOUNT_EXPORT_DIAGNOSTIC_ROOT = resolve(process.cwd(), "trash", "logs");
const DEFAULT_HISTORY_ARCHIVE_DIAGNOSTIC_ROOT = resolve(process.cwd(), "trash", "logs");
const MAX_ACCOUNT_EXPORT_SCREENSHOT_BYTES = 12 * 1024 * 1024;
const MAX_ACCOUNT_EXPORT_DIAGNOSTIC_TEXT = 512;
const ACCOUNT_EXPORT_KEYWORDS = /(?:data|данн|control|управлен|privacy|конфиден|export|экспорт|download|скач)/iu;
const ACTIONABLE_ACCOUNT_EXPORT_ROLES = new Set(["button", "link", "menuitem", "tab"]);

export interface BrowserClawScreenshot {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
}

export interface BrowserClawAccountExportDiagnosticInput {
  outcome: "failed" | "requested" | "already_requested";
  stage: string;
  failure?: string;
  snapshot: BrowserClawA11ySnapshot;
  stoppedNode?: BrowserClawA11yNode;
}

export interface BrowserClawAccountExportDiagnosticReporter {
  capture(input: BrowserClawAccountExportDiagnosticInput): Promise<void>;
}

export interface BrowserClawAccountExportDiagnosticArtifact {
  a11yPath: string;
  screenshotPath?: string;
}

export interface BrowserClawHistoryArchiveDiagnosticInput {
  outcome: "captured" | "failed";
  stage: "list_chats" | "open_chat" | "scroll_back";
  failure?: string;
  snapshot: BrowserClawA11ySnapshot;
}

export interface BrowserClawHistoryArchiveDiagnosticArtifact {
  receiptPath: string;
  screenshotPath?: string;
}

export interface BrowserClawHistoryArchiveDiagnosticReporter {
  capture(input: BrowserClawHistoryArchiveDiagnosticInput): Promise<void>;
}

/**
 * The history route is intentionally read-only: it can list visible sidebar
 * rows and persist raw snapshots while scrolling the one owned page. Composer
 * mutation remains disabled until separately proven.
 */
export const BROWSERCLAW_CDP_CHAT_CAPABILITIES: CdpChatCapabilities = {
  new_chat: false,
  list_chats: false,
  search_chat: false,
  export_chat: false,
  send_message: false,
  edit_message: false,
  download_media: false,
};

export interface BrowserClawCdpChatDriverOptions {
  endpoint?: string;
  token?: string;
  /** Existing single page may be reused; otherwise exactly one page is opened by this driver. */
  openPage?: boolean;
}

function remainingMs(deadlineAt: number): number {
  return Math.max(1, deadlineAt - Date.now());
}

function parseJsonRpcBody(body: string): Record<string, unknown> | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    const events = trimmed
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(events[index]!) as unknown;
        if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      } catch {
        // Ignore non-JSON keep-alive events.
      }
    }
  }
  return null;
}

/** Small persistent Streamable-HTTP MCP client owned by this CDP adapter. */
export class BrowserClawCdpMcpClient {
  private sessionId: string | undefined;
  private requestId = 1;

  private constructor(private readonly endpoint: string, private readonly token?: string) {}

  static async connect(endpoint: string, deadlineAt: number, token?: string): Promise<BrowserClawCdpMcpClient> {
    const client = new BrowserClawCdpMcpClient(endpoint, token);
    await client.initialize(deadlineAt);
    return client;
  }

  get sessionRef(): string {
    if (!this.sessionId) throw new Error("BrowserClaw MCP session is not initialized");
    return this.sessionId;
  }

  async callToolRaw(name: string, argumentsValue: Record<string, unknown>, deadlineAt: number): Promise<Record<string, unknown>> {
    const response = await this.post({
      jsonrpc: "2.0",
      id: this.requestId++,
      method: "tools/call",
      params: { name, arguments: argumentsValue },
    }, deadlineAt);
    if (response?.error) throw new Error("BrowserClaw rejected the browser tool call");
    const result = response?.result as { isError?: unknown } | undefined;
    if (!result || result.isError) throw new Error("BrowserClaw reported a browser tool failure");
    return response ?? {};
  }

  async callToolImage(name: string, argumentsValue: Record<string, unknown>, deadlineAt: number): Promise<BrowserClawScreenshot> {
    const response = await this.callToolRaw(name, argumentsValue, deadlineAt);
    const result = response.result as { content?: unknown } | undefined;
    const content = result?.content;
    const image = Array.isArray(content)
      ? content.find((item): item is { type: "image"; data: string; mimeType: BrowserClawScreenshot["mimeType"] } => Boolean(
        item && typeof item === "object" && (item as { type?: unknown }).type === "image"
          && typeof (item as { data?: unknown }).data === "string"
          && ["image/png", "image/jpeg", "image/webp"].includes((item as { mimeType?: unknown }).mimeType as string),
      ))
      : undefined;
    if (!image) throw new Error("BrowserClaw screenshot did not return an image");
    return { mimeType: image.mimeType, data: image.data };
  }

  private async initialize(deadlineAt: number): Promise<void> {
    const response = await this.post({
      jsonrpc: "2.0",
      id: this.requestId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "agent-herder-cdp-chat", version: "0.1" },
      },
    }, deadlineAt);
    if (response?.error || !this.sessionId) throw new Error("BrowserClaw MCP initialization failed");
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, deadlineAt);
  }

  private async post(body: Record<string, unknown>, deadlineAt: number): Promise<Record<string, unknown> | null> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(remainingMs(deadlineAt)),
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    if (!response.ok) throw new Error("BrowserClaw MCP request failed");
    const parsed = parseJsonRpcBody(await response.text());
    if (body.method === "initialize" && !this.sessionId) throw new Error("BrowserClaw MCP did not return a session");
    return parsed;
  }
}

/** BrowserClaw implementation of the minimal semantic A11y transport. */
export class BrowserClawMcpA11yClient implements BrowserClawA11yClient {
  private readonly urls = new Map<number, string>();

  constructor(private readonly client: BrowserClawCdpMcpClient) {}

  get sessionRef(): string {
    return this.client.sessionRef;
  }

  async captureAccountExportDiagnostic(input: BrowserClawAccountExportDiagnosticInput): Promise<BrowserClawAccountExportDiagnosticArtifact> {
    const root = resolve(process.env.CHATGPT_ACCOUNT_EXPORT_DIAGNOSTIC_ROOT || DEFAULT_ACCOUNT_EXPORT_DIAGNOSTIC_ROOT);
    const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const base = `chatgpt-account-export-${timestamp}-${randomUUID()}`;
    const a11yPath = join(root, `${base}.a11y.json`);
    const payload = JSON.stringify(redactedAccountExportDiagnostic(input), null, 2) + "\n";
    await writePrivateFile(a11yPath, payload);

    try {
      const screenshot = await this.client.callToolImage("screenshot", {
        page: input.snapshot.page,
        format: "png",
        fullPage: false,
        size: { width: 1440, height: 1000 },
      }, deadline());
      const bytes = Buffer.from(screenshot.data, "base64");
      if (bytes.length === 0 || bytes.length > MAX_ACCOUNT_EXPORT_SCREENSHOT_BYTES) {
        throw new Error("BrowserClaw screenshot is empty or exceeds the diagnostic size limit");
      }
      const screenshotPath = join(root, `${base}.${imageExtension(screenshot.mimeType)}`);
      await writePrivateFile(screenshotPath, bytes);
      return { a11yPath, screenshotPath };
    } catch (error) {
      const updated = JSON.stringify({
        ...redactedAccountExportDiagnostic(input),
        screenshot: { captured: false, error: diagnosticError(error) },
      }, null, 2) + "\n";
      await writePrivateFile(a11yPath, updated);
      return { a11yPath };
    }
  }

  async captureHistoryArchiveDiagnostic(input: BrowserClawHistoryArchiveDiagnosticInput): Promise<BrowserClawHistoryArchiveDiagnosticArtifact> {
    const root = resolve(process.env.CHATGPT_HISTORY_ARCHIVE_DIAGNOSTIC_ROOT || DEFAULT_HISTORY_ARCHIVE_DIAGNOSTIC_ROOT);
    const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const base = `chatgpt-history-archive-${timestamp}-${randomUUID()}`;
    const receiptPath = join(root, `${base}.json`);
    const receipt = {
      schema: "agent-herder.chatgpt-history-archive-diagnostic.v1",
      capturedAt: new Date().toISOString(),
      outcome: input.outcome,
      stage: input.stage,
      ...(input.failure ? { failure: diagnosticError(input.failure) } : {}),
      page: input.snapshot.page,
      url: redactedSnapshotUrl(input.snapshot),
      screenshot: { captured: true },
    };
    await writePrivateFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");

    try {
      const screenshot = await this.client.callToolImage("screenshot", {
        page: input.snapshot.page,
        format: "png",
        fullPage: false,
        size: { width: 1440, height: 1000 },
      }, deadline());
      const bytes = Buffer.from(screenshot.data, "base64");
      if (bytes.length === 0 || bytes.length > MAX_ACCOUNT_EXPORT_SCREENSHOT_BYTES) {
        throw new Error("BrowserClaw screenshot is empty or exceeds the diagnostic size limit");
      }
      const screenshotPath = join(root, `${base}.${imageExtension(screenshot.mimeType)}`);
      await writePrivateFile(screenshotPath, bytes);
      return { receiptPath, screenshotPath };
    } catch (error) {
      await writePrivateFile(receiptPath, JSON.stringify({
        ...receipt,
        screenshot: { captured: false, error: diagnosticError(error) },
      }, null, 2) + "\n");
      return { receiptPath };
    }
  }

  async listTabs(): Promise<readonly BrowserClawA11yTab[]> {
    const response = await this.client.callToolRaw("tabs", { action: "list" }, deadline());
    const text = textContent(response);
    const tabs: BrowserClawA11yTab[] = [];
    for (const match of text.matchAll(/^\s*\[(\d+)\]\s+(https?:\/\/\S+)/gm)) {
      const page = Number(match[1]);
      if (Number.isSafeInteger(page) && page >= 0) {
        const url = match[2]!;
        tabs.push({ page, url });
        this.urls.set(page, url);
      }
    }
    return tabs;
  }

  async openChatGptPage(): Promise<number> {
    const response = await this.client.callToolRaw("tabs", { action: "new", url: `${CHATGPT_ORIGIN}/` }, deadline());
    const text = textContent(response);
    const match = text.match(/(?:opened page|page)\s+(\d+)/i);
    if (!match) throw new Error("BrowserClaw did not report an opened ChatGPT page id");
    return Number(match[1]);
  }

  async snapshotPage(page: number): Promise<BrowserClawA11ySnapshot> {
    // BrowserClaw's full snapshot is the supported equivalent of a CDP AX tree
    // for this owned page. It is read-only and does not create or navigate tabs.
    const response = await this.client.callToolRaw("snapshot", { page, mode: "full", depth: 100 }, deadline());
    return normalizeBrowserClawA11yResponse(response, {
      page,
      url: this.currentUrl(page),
      snapshotRef: randomUUID(),
    });
  }

  /** Read page links on the already owned page; this never opens or navigates a tab. */
  async conversationSidebarTitles(page: number): Promise<ReadonlySet<string>> {
    const response = await this.client.callToolRaw("read", { page, format: "links" }, deadline());
    return conversationTitlesFromLinks(textContent(response));
  }

  async actPage(page: number, action: BrowserClawSemanticAction): Promise<BrowserClawA11ySnapshot> {
    const args: Record<string, unknown> = { page, kind: action.kind };
    if (action.kind === "press") args.key = action.key;
    else if (action.kind === "scroll") {
      args.direction = action.direction;
      if (action.amount !== undefined) args.amount = action.amount;
    }
    else {
      args.ref = action.ref;
      if (action.kind === "fill") args.value = action.value;
      if (action.kind === "type") args.text = action.text;
    }
    await this.client.callToolRaw("act", args, deadline());
    // An a11y action can navigate the ChatGPT SPA. Refresh the owned tab's URL
    // before producing the post-action snapshot so callers can distinguish a
    // conversation route from the landing page without opening another tab.
    await this.listTabs();
    return this.snapshotPage(page);
  }

  private currentUrl(page: number): string {
    return this.urls.get(page) ?? `${CHATGPT_ORIGIN}/`;
  }
}

/**
 * One BrowserClaw-owned Settings flow for the official asynchronous account
 * export. It has no chat composer action and never opens a second tab.
 */
export class BrowserClawAccountExportDriver implements ChatGptAccountExportDriver {
  private readonly page: BrowserClawA11yPage;

  private constructor(page: BrowserClawA11yPage, private readonly diagnostics?: BrowserClawAccountExportDiagnosticReporter) {
    this.page = page;
  }

  static fromOwnedPage(page: BrowserClawA11yPage, diagnostics?: BrowserClawAccountExportDiagnosticReporter): BrowserClawAccountExportDriver {
    return new BrowserClawAccountExportDriver(page, diagnostics);
  }

  async requestAccountExport(): Promise<{
    requestedAt: string;
    delivery: "email_or_sms";
    status: "requested" | "already_requested";
  }> {
    let snapshot: BrowserClawA11ySnapshot | undefined;
    let stage = "initial snapshot";
    try {
      snapshot = await this.page.snapshot(deadline());
      stage = "profile menu";
      snapshot = await this.click(snapshot, (node) => node.role === "button" && /(?:открыть )?(?:меню )?профил|profile/i.test(node.name ?? ""), stage);
      stage = "settings";
      snapshot = await this.click(snapshot, (node) => ["menuitem", "button", "link"].includes(node.role) && /(?:^|\s)(?:настройки|settings)(?:$|\s)/i.test(node.name ?? ""), stage);
      stage = "data management";
      snapshot = await this.click(snapshot, isDataManagementControl, stage);

      const alreadyRequested = findNode(snapshot.root, (node) => /(?:уже )?(?:запрош|request(?:ed)? already|export already)/i.test(`${node.name ?? ""} ${node.description ?? ""}`));
      if (alreadyRequested) {
        await this.captureDiagnostic({ outcome: "already_requested", stage, snapshot });
        return { requestedAt: new Date().toISOString(), delivery: "email_or_sms", status: "already_requested" };
      }

      stage = "account export";
      snapshot = await this.click(snapshot, isAccountExportControl, stage);
      stage = "confirm account export";
      snapshot = await this.click(snapshot, (node) => node.role === "button" && /^(?:подтвердить(?: экспорт)?|confirm(?: export)?|confirm your export)$/i.test(node.name ?? ""), stage);
      await this.captureDiagnostic({ outcome: "requested", stage, snapshot });
      return { requestedAt: new Date().toISOString(), delivery: "email_or_sms", status: "requested" };
    } catch (error) {
      if (snapshot) await this.captureDiagnostic({ outcome: "failed", stage, failure: diagnosticError(error), snapshot, stoppedNode: findRelevantAccountExportNode(snapshot.root) });
      throw error;
    }
  }

  private async click(
    snapshot: BrowserClawA11ySnapshot,
    predicate: (node: BrowserClawA11yNode) => boolean,
    label: string,
  ): Promise<BrowserClawA11ySnapshot> {
    const node = findNode(snapshot.root, predicate);
    if (!node || node.disabled) throw new Error(`ChatGPT ${label} control was not found on the owned page`);
    await this.page.act({ snapshotRef: snapshot.snapshotRef, action: { kind: "click", ref: node.ref } }, deadline());
    return this.page.snapshot(deadline());
  }

  private async captureDiagnostic(input: BrowserClawAccountExportDiagnosticInput): Promise<void> {
    if (!this.diagnostics) return;
    try {
      await this.diagnostics.capture(input);
    } catch (error) {
      console.error(`[browserclaw-cdp-chat] account-export diagnostic failed: ${diagnosticError(error)}`);
    }
  }
}

/** Concrete driver factory loaded by CDP_CHAT_DRIVER_MODULE. */
export async function createCdpChatDriver(options: BrowserClawCdpChatDriverOptions = {}): Promise<CdpChatDriver> {
  const client = await BrowserClawCdpMcpClient.connect(
    options.endpoint ?? process.env.AGENT_HERDER_BROWSERCLAW_MCP_URL ?? DEFAULT_ENDPOINT,
    deadline(),
    options.token ?? (process.env.AGENT_HERDER_BROWSERCLAW_MCP_TOKEN?.trim() || undefined),
  );
  const a11yClient = new BrowserClawMcpA11yClient(client);
  // A BrowserClaw page belongs to its MCP session. A visible pre-existing ChatGPT
  // tab can therefore be unowned, so this driver creates exactly one page in its
  // own long-lived session rather than trying to claim that tab.
  const ownedPage = options.openPage !== false ? await a11yClient.openChatGptPage() : undefined;
  const a11y = createBrowserClawA11yDriver(a11yClient, {
    targetUrl: `${CHATGPT_ORIGIN}/`,
    allowPathPrefix: "/",
    page: ownedPage,
  });
  const ownedA11yPage = await a11y.acquirePage();
  const page = new BrowserClawCdpChatPage(ownedA11yPage, a11yClient.sessionRef);
  const historyArchiveDriver = new BrowserClawHistoryArchiveDriver(ownedA11yPage, a11yClient.sessionRef, {
    async capture(input) {
      await a11yClient.captureHistoryArchiveDiagnostic(input);
    },
  }, a11yClient.conversationSidebarTitles.bind(a11yClient));
  const accountExportDriver = BrowserClawAccountExportDriver.fromOwnedPage(ownedA11yPage, {
    async capture(input) {
      await a11yClient.captureAccountExportDiagnostic(input);
    },
  });
  return {
    async acquirePage(): Promise<CdpChatPage> {
      return page;
    },
    capabilities: BROWSERCLAW_CDP_CHAT_CAPABILITIES,
    accountExportDriver,
    historyArchiveDriver,
  };
}

/** Read-only mapping of the one BrowserClaw-owned page to the history exporter. */
class BrowserClawHistoryArchiveDriver implements ChatGptHistoryArchiveDriver {
  private readonly idPrefix: string;
  private lastSnapshot: BrowserClawA11ySnapshot | undefined;
  private activeChatId: string | undefined;

  constructor(
    private readonly page: BrowserClawA11yPage,
    sessionRef: string,
    private readonly diagnostics?: BrowserClawHistoryArchiveDiagnosticReporter,
    private readonly conversationTitles?: (page: number) => Promise<ReadonlySet<string>>,
  ) {
    this.idPrefix = createHash("sha256").update(sessionRef).digest("hex").slice(0, 24);
  }

  async listChats(): Promise<readonly ChatGptHistoryChat[]> {
    let snapshot: BrowserClawA11ySnapshot | undefined;
    try {
      snapshot = await this.page.snapshot(deadline());
      this.lastSnapshot = snapshot;
      const titles = this.conversationTitles ? await this.conversationTitles(snapshot.page) : undefined;
      return visibleSidebarChats(snapshot, this.idPrefix, titles);
    } catch (error) {
      await this.captureDiagnostic({
        outcome: "failed",
        stage: "list_chats",
        failure: diagnosticError(error),
        snapshot: this.lastSnapshot ?? snapshot,
      });
      throw error;
    }
  }

  async openChat(input: { chatId: string }): Promise<ChatGptHistorySegment> {
    let snapshot: BrowserClawA11ySnapshot | undefined;
    try {
      snapshot = await this.page.snapshot(deadline());
      const titles = this.conversationTitles ? await this.conversationTitles(snapshot.page) : undefined;
      const chat = visibleSidebarChats(snapshot, this.idPrefix, titles).find((entry) => entry.id === input.chatId);
      if (!chat) throw new Error("ChatGPT chat is not visible in the owned sidebar; call cdp_list_chats again");
      const node = findNode(snapshot.root, (entry) => entry.ref === chat.nodeRef);
      if (!node || node.disabled) throw new Error("ChatGPT sidebar chat control was not found on the owned page");
      const afterClick = await this.page.act({ snapshotRef: snapshot.snapshotRef, action: { kind: "click", ref: node.ref } }, deadline());
      this.lastSnapshot = afterClick;
      if (!isChatHistoryConversationUrl(afterClick.url)) {
        throw new Error("ChatGPT sidebar control did not open a conversation route");
      }
      this.activeChatId = input.chatId;
      await this.captureDiagnostic({ outcome: "captured", stage: "open_chat", snapshot: afterClick });
      return historySegment(this.lastSnapshot, afterClick.url);
    } catch (error) {
      await this.captureDiagnostic({
        outcome: "failed",
        stage: "open_chat",
        failure: diagnosticError(error),
        snapshot: this.lastSnapshot ?? snapshot,
      });
      throw error;
    }
  }

  async scrollBack(): Promise<{ segment: ChatGptHistorySegment; atStart: boolean }> {
    try {
      if (!this.lastSnapshot || !this.activeChatId) throw new Error("ChatGPT history export has no active chat page");
      const before = snapshotFingerprint(this.lastSnapshot);
      const after = await this.page.act({
        snapshotRef: this.lastSnapshot.snapshotRef,
        action: { kind: "scroll", direction: "up", amount: 12 },
      }, deadline());
      this.lastSnapshot = after;
      return { segment: historySegment(this.lastSnapshot, after.url), atStart: before === snapshotFingerprint(this.lastSnapshot) };
    } catch (error) {
      await this.captureDiagnostic({
        outcome: "failed",
        stage: "scroll_back",
        failure: diagnosticError(error),
        snapshot: this.lastSnapshot,
      });
      throw error;
    }
  }

  private async captureDiagnostic(input: Omit<BrowserClawHistoryArchiveDiagnosticInput, "snapshot"> & { snapshot?: BrowserClawA11ySnapshot }): Promise<void> {
    if (!this.diagnostics || !input.snapshot) return;
    try {
      await this.diagnostics.capture(input as BrowserClawHistoryArchiveDiagnosticInput);
    } catch (error) {
      console.error(`[browserclaw-cdp-chat] history-archive diagnostic failed: ${diagnosticError(error)}`);
    }
  }
}

export type BrowserClawVisibleHistoryChat = ChatGptHistoryChat & { nodeRef: string };

export function visibleSidebarChats(
  snapshot: BrowserClawA11ySnapshot,
  idPrefix: string,
  conversationTitles?: ReadonlySet<string>,
): BrowserClawVisibleHistoryChat[] {
  const seen = new Set<string>();
  const candidates: Array<{ node: BrowserClawA11yNode; title: string; path: readonly BrowserClawA11yNode[] }> = [];
  const visit = (node: BrowserClawA11yNode, path: readonly BrowserClawA11yNode[]): void => {
    const title = node.name?.trim();
    if (node.role === "link" && title && isHistorySidebarTitle(title) && node.children.length <= 2 && !seen.has(node.ref) && isLikelyHistoryRow(path)
      && (conversationTitles === undefined || conversationTitles.has(normalizedHistoryTitle(title)))) {
      seen.add(node.ref);
      candidates.push({ node, title, path });
    }
    for (const child of node.children) visit(child, [...path, node]);
  };
  visit(snapshot.root, []);
  return candidates
    .map(({ node, title }) => ({
      // Keep the public binding stable across fresh a11y refs; `nodeRef` below
      // remains the current semantic click target. The post-click /c/ check is
      // the authoritative conversation verification.
      id: historyChatId(idPrefix, title, node.description),
      nodeRef: node.ref,
      title,
      unread: /(?:\bunread\b|непрочитан)/iu.test(`${node.description ?? ""} ${node.name ?? ""}`),
      working: /(?:\bworking\b|thinking|думает|генерир)/iu.test(`${node.description ?? ""} ${node.name ?? ""}`),
      // BrowserClaw does not expose ChatGPT row timestamps. Stable current order
      // becomes a deterministic recent-order marker for the MCP list contract.
      updatedAt: new Date(0).toISOString(),
    }));
}

function conversationTitlesFromLinks(value: string): ReadonlySet<string> {
  const titles = new Set<string>();
  for (const match of value.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+|\/[^)]+)\)/gu)) {
    const href = match[2]!;
    try {
      const url = new URL(href, CHATGPT_ORIGIN);
      if (url.origin === CHATGPT_ORIGIN && /^\/c\/[^/]+/u.test(url.pathname)) titles.add(normalizedHistoryTitle(match[1]!));
    } catch {
      // A malformed link cannot identify a ChatGPT conversation row.
    }
  }
  return titles;
}

function normalizedHistoryTitle(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function isLikelyHistoryRow(path: readonly BrowserClawA11yNode[]): boolean {
  // ChatGPT project folders are top-level sidebar links. Conversation rows are
  // rendered inside a compact sidebar group; require two ancestors to avoid
  // choosing a project/shell link while preserving the a11y click surface.
  return path.length >= 2;
}

function historyChatId(idPrefix: string, title: string, description: string | undefined): string {
  const normalized = `${title.trim().toLocaleLowerCase()}\u0000${(description ?? "").trim().toLocaleLowerCase()}`;
  return `${idPrefix}:${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

function isHistorySidebarTitle(title: string): boolean {
  if (title.length > 512) return false;
  return !/^(?:new chat|новый чат|library|библиотека|scheduled|запланированное|plugins|плагины|more|больше|search|поиск|download apps|скачать приложения|settings|настройки|profile|профиль)$/iu.test(title);
}

/** A saved history segment is valid only after the same page reaches a real chat route. */
export function isChatHistoryConversationUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.origin === CHATGPT_ORIGIN && /^\/c\/[^/]+/u.test(parsed.pathname);
  } catch {
    return false;
  }
}

function snapshotFingerprint(snapshot: BrowserClawA11ySnapshot): string {
  const nodes: string[] = [];
  const visit = (node: BrowserClawA11yNode): void => {
    nodes.push(`${node.role}\u0000${node.name ?? ""}\u0000${node.value ?? ""}\u0000${node.description ?? ""}`);
    for (const child of node.children) visit(child);
  };
  visit(snapshot.root);
  return createHash("sha256").update(nodes.join("\n")).digest("hex");
}

function historySegment(snapshot: BrowserClawA11ySnapshot, url: string): ChatGptHistorySegment {
  return {
    capturedAt: new Date().toISOString(),
    page: { url: normalizeHistoryUrl(url) },
    content: {
      schema: snapshot.schema,
      page: snapshot.page,
      url: normalizeHistoryUrl(snapshot.url),
      root: snapshot.root,
    },
  };
}

function normalizeHistoryUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return `${CHATGPT_ORIGIN}/`;
  }
}

class BrowserClawCdpChatPage implements CdpChatPage {
  private readonly identityValue: PageIdentity;
  private created: ChatRecord | undefined;

  constructor(private readonly page: BrowserClawA11yPage, sessionRef: string) {
    const digest = createHash("sha256").update(sessionRef).digest("hex").slice(0, 24);
    this.identityValue = {
      origin: CHATGPT_ORIGIN,
      accountRef: `browserclaw:${digest}`,
      pageRef: `browserclaw-page:${digest}`,
      leaseRef: `browserclaw-lease:${digest}`,
    };
  }

  async identity(): Promise<PageIdentity> {
    return this.identityValue;
  }

  async snapshot(): Promise<{ chats: ChatRecord[] }> {
    const snapshot = await this.page.snapshot(deadline());
    return { chats: this.created ? [structuredClone(this.created)] : [] };
  }

  async createChat(input: { title?: string }): Promise<ChatRecord> {
    if (this.created) return structuredClone(this.created);
    const first = await this.page.snapshot(deadline());
    const newChat = findNode(first.root, (node) => node.role === "link" && /^(новый чат|new chat)$/i.test(node.name ?? ""));
    if (newChat) await this.page.act({ snapshotRef: first.snapshotRef, action: { kind: "click", ref: newChat.ref } }, deadline());
    else {
      const snapshot = await this.page.snapshot(deadline());
      const composer = findComposer(snapshot.root);
      if (!composer) throw new Error("ChatGPT composer was not found on the owned page");
      // The blank ChatGPT home composer is already a disposable chat; no prompt is submitted.
    }
    const createdAt = new Date().toISOString();
    this.created = {
      id: `fixture:${randomUUID()}`,
      title: input.title?.trim() || "Agent Herder disposable chat",
      unread: false,
      working: false,
      updatedAt: createdAt,
      messages: [],
    };
    return structuredClone(this.created);
  }

  async sendMessage(input: { chatId: string; text: string }): Promise<MessageRecord> {
    const chat = this.requireFixture(input.chatId);
    const snapshot = await this.page.snapshot(deadline());
    const composer = findComposer(snapshot.root);
    if (!composer) throw new Error("ChatGPT composer was not found on the owned page");
    const typed = await this.page.act({ snapshotRef: snapshot.snapshotRef, action: { kind: "fill", ref: composer.ref, value: input.text } }, deadline());
    await this.page.act({ snapshotRef: typed.snapshotRef, action: { kind: "press", key: "Enter" } }, deadline());
    const result: MessageRecord = {
      id: `message:${randomUUID()}`,
      role: "user",
      text: input.text,
      version: 1,
      createdAt: new Date().toISOString(),
      media: [],
    };
    chat.messages.push(result);
    chat.updatedAt = result.createdAt;
    return structuredClone(result);
  }

  async editMessage(): Promise<MessageRecord> {
    throw new Error("ChatGPT A11y edit_message is not implemented in the 80/20 driver");
  }

  async downloadMedia(): Promise<DownloadedMedia> {
    throw new Error("ChatGPT A11y download_media is not implemented in the 80/20 driver");
  }

  private requireFixture(chatId: string): ChatRecord {
    if (!this.created || this.created.id !== chatId) throw new Error("chat is not the disposable fixture");
    return this.created;
  }
}

function deadline(): number {
  return Date.now() + 15_000;
}

function textContent(response: Record<string, unknown>): string {
  const result = response.result;
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } => Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string"))
    .map((item) => item.text)
    .join("\n");
}

function isDataManagementControl(node: BrowserClawA11yNode): boolean {
  return ACTIONABLE_ACCOUNT_EXPORT_ROLES.has(node.role)
    && /(?:управлен(?:ие|ия) данн|data\s*(?:controls?|management|privacy)|privacy\s*(?:controls?|settings?))/iu.test(`${node.name ?? ""} ${node.description ?? ""}`);
}

function isAccountExportControl(node: BrowserClawA11yNode): boolean {
  return ACTIONABLE_ACCOUNT_EXPORT_ROLES.has(node.role)
    && /(?:экспорт(?:ировать)?(?:\s+данн(?:ые|ых))?|export(?:\s+(?:data|your\s+data))?|download\s+(?:data|your\s+data))/iu.test(`${node.name ?? ""} ${node.description ?? ""}`);
}

function diagnosticError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n\t]+/gu, " ").slice(0, MAX_ACCOUNT_EXPORT_DIAGNOSTIC_TEXT);
}

function diagnosticNode(node: BrowserClawA11yNode): { role: string; name?: string; description?: string; disabled?: boolean } {
  return {
    role: node.role,
    ...(node.name ? { name: node.name.slice(0, MAX_ACCOUNT_EXPORT_DIAGNOSTIC_TEXT) } : {}),
    ...(node.description ? { description: node.description.slice(0, MAX_ACCOUNT_EXPORT_DIAGNOSTIC_TEXT) } : {}),
    ...(node.disabled === undefined ? {} : { disabled: node.disabled }),
  };
}

function accountExportDiagnosticNodes(root: BrowserClawA11yNode): Array<{ role: string; name?: string; description?: string; disabled?: boolean }> {
  const matches: Array<{ role: string; name?: string; description?: string; disabled?: boolean }> = [];
  const visit = (node: BrowserClawA11yNode): void => {
    if (ACCOUNT_EXPORT_KEYWORDS.test(`${node.name ?? ""} ${node.description ?? ""}`)) matches.push(diagnosticNode(node));
    for (const child of node.children) visit(child);
  };
  visit(root);
  return matches.slice(0, 100);
}

function findRelevantAccountExportNode(root: BrowserClawA11yNode): BrowserClawA11yNode | undefined {
  return findNode(root, isAccountExportControl) ?? findNode(root, isDataManagementControl) ?? findNode(root, (node) => ACCOUNT_EXPORT_KEYWORDS.test(`${node.name ?? ""} ${node.description ?? ""}`));
}

function redactedAccountExportDiagnostic(input: BrowserClawAccountExportDiagnosticInput): Record<string, unknown> {
  return {
    schema: "agent-herder.chatgpt-account-export-a11y.v1",
    capturedAt: new Date().toISOString(),
    outcome: input.outcome,
    stage: input.stage,
    ...(input.failure ? { failure: input.failure } : {}),
    page: input.snapshot.page,
    url: redactedSnapshotUrl(input.snapshot),
    ...(input.stoppedNode ? { stoppedNode: diagnosticNode(input.stoppedNode) } : {}),
    relevantNodes: accountExportDiagnosticNodes(input.snapshot.root),
    screenshot: { captured: true },
  };
}

function redactedSnapshotUrl(snapshot: BrowserClawA11ySnapshot): string {
  const parsed = new URL(snapshot.url);
  return `${parsed.origin}${parsed.pathname}`;
}

function imageExtension(mimeType: BrowserClawScreenshot["mimeType"]): "png" | "jpg" | "webp" {
  return mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
}

async function writePrivateFile(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function findNode(node: BrowserClawA11yNode, predicate: (node: BrowserClawA11yNode) => boolean): BrowserClawA11yNode | undefined {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function findComposer(root: BrowserClawA11yNode): BrowserClawA11yNode | undefined {
  return findNode(root, (node) => node.role === "textbox" && /чат с chatgpt|message chatgpt|сообщение/i.test(`${node.name ?? ""} ${node.value ?? ""}`));
}

export default createCdpChatDriver;
