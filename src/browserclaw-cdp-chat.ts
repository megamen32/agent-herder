import { createHash, randomUUID } from "node:crypto";
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
import type { ChatRecord, CdpChatDriver, CdpChatPage, DownloadedMedia, MessageRecord, PageIdentity } from "./cdp-chat.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:9010/mcp";
const CHATGPT_ORIGIN = "https://chatgpt.com";

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
class BrowserClawCdpMcpClient {
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
class BrowserClawMcpA11yClient implements BrowserClawA11yClient {
  private readonly urls = new Map<number, string>();

  constructor(private readonly client: BrowserClawCdpMcpClient) {}

  get sessionRef(): string {
    return this.client.sessionRef;
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
    const response = await this.client.callToolRaw("snapshot", { page }, deadline());
    return normalizeBrowserClawA11yResponse(response, {
      page,
      url: this.currentUrl(page),
      snapshotRef: randomUUID(),
    });
  }

  async actPage(page: number, action: BrowserClawSemanticAction): Promise<BrowserClawA11ySnapshot> {
    const args: Record<string, unknown> = { page, kind: action.kind };
    if (action.kind === "press") args.key = action.key;
    else {
      args.ref = action.ref;
      if (action.kind === "fill") args.value = action.value;
      if (action.kind === "type") args.text = action.text;
    }
    await this.client.callToolRaw("act", args, deadline());
    return this.snapshotPage(page);
  }

  private currentUrl(page: number): string {
    return this.urls.get(page) ?? `${CHATGPT_ORIGIN}/`;
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
  const page = new BrowserClawCdpChatPage(await a11y.acquirePage(), a11yClient.sessionRef);
  return {
    async acquirePage(): Promise<CdpChatPage> {
      return page;
    },
  };
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
