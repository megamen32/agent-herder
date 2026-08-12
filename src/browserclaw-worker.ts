import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { z } from "zod";
import {
  BrowserWorkerDispatchError,
  BrowserWorkerErrorClass,
  BrowserWorkerReceipt,
  BrowserWorkerReceiptSchema,
  BrowserWorkerRequest,
  BrowserWorkerRequestSchema,
  BrowserWorkerTemplateId,
} from "./browser-worker.js";

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_BROWSERCLAW_MCP_URL = "http://127.0.0.1:9010/mcp";
const DEFAULT_WORKER_HOST = "127.0.0.1";
const DEFAULT_WORKER_PORT = 9012;
export const BROWSER_CANARY_TOKEN = "AGENT_HERDER_BROWSER_CANARY_READY_8";
const BROWSER_CANARY_TOKEN_PREFIX = "AGENT_HERDER_BROWSER_CANARY_";
const BROWSER_CANARY_TOKEN_SUFFIX = "READY_8";

function logBrowserStage(stage: string, page?: number, error?: unknown): void {
  const suffix = page === undefined ? "" : ` page=${page}`;
  const detail = error instanceof Error ? ` error=${error.message}` : "";
  console.error(`[browserclaw-worker] stage=${stage}${suffix}${detail}`);
}

const browserWorkerLedgerTimestamp = z.string().max(64).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
const browserWorkerClaimSchema = z.object({
  request: BrowserWorkerRequestSchema,
  status: z.literal("claimed"),
  acceptedAt: browserWorkerLedgerTimestamp,
  receiptRef: z.string().trim().min(1).max(256),
}).strict();
const browserWorkerTerminalSchema = z.object({
  request: BrowserWorkerRequestSchema,
  status: z.enum(["completed", "failed"]),
  receipt: BrowserWorkerReceiptSchema,
}).strict().superRefine((record, context) => {
  if (record.status !== record.receipt.status) {
    context.addIssue({ code: "custom", path: ["status"], message: "ledger status must match receipt status" });
  }
});
const browserWorkerLedgerRecordSchema = z.union([browserWorkerClaimSchema, browserWorkerTerminalSchema]);
const browserWorkerLedgerFileSchema = z.object({ version: z.literal(1), records: z.array(browserWorkerLedgerRecordSchema) }).strict();

type BrowserWorkerLedgerRecord = z.infer<typeof browserWorkerLedgerRecordSchema>;
interface BrowserWorkerLedgerFile {
  version: 1;
  records: BrowserWorkerLedgerRecord[];
}

export class BrowserClawWorkerError extends Error {
  constructor(readonly errorClass: BrowserWorkerErrorClass, message: string) {
    super(message);
    this.name = "BrowserClawWorkerError";
  }
}

export class BrowserClawWorkerConflictError extends Error {
  readonly statusCode = 409;

  constructor(message = "Browser worker idempotency conflict") {
    super(message);
    this.name = "BrowserClawWorkerConflictError";
  }
}

export interface BrowserClawScreenshot {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
}

export interface BrowserClawToolClient {
  callTool(name: string, argumentsValue: Record<string, unknown>, deadlineAt: number): Promise<string>;
  callToolImage?(name: string, argumentsValue: Record<string, unknown>, deadlineAt: number): Promise<BrowserClawScreenshot>;
}

export interface BrowserClawDriver {
  execute(request: BrowserWorkerRequest, deadlineAt: number): Promise<void>;
  captureScreenshot?(deadlineAt: number): Promise<BrowserClawScreenshot>;
  captureStageScreenshot?(deadlineAt: number): Promise<BrowserClawScreenshot>;
}

interface BrowserClawPage {
  page: number;
  url: string;
}

function now(): string {
  return new Date().toISOString();
}

function remainingMs(deadlineAt: number): number {
  return Math.max(1, deadlineAt - Date.now());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textBlocks(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const content = (value as { result?: { content?: unknown } }).result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } => Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string"))
    .map((item) => item.text)
    .join("\n");
}

function parseJsonRpcBody(body: string): Record<string, unknown> | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    // Streamable HTTP responses are commonly SSE even for one JSON-RPC result.
  }
  const events = trimmed.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(events[index]) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      // Ignore non-JSON SSE keep-alive data.
    }
  }
  return null;
}

function errorFromFetch(error: unknown): BrowserClawWorkerError {
  const name = error instanceof Error ? error.name : "";
  return new BrowserClawWorkerError(
    name === "AbortError" || name === "TimeoutError" ? "worker_timeout" : "worker_unavailable",
    "BrowserClaw MCP request failed",
  );
}

export class BrowserClawMcpClient implements BrowserClawToolClient {
  private sessionId: string | undefined;
  private requestId = 1;

  private constructor(private readonly endpoint: string, private readonly token?: string) {}

  static async connect(endpoint: string, deadlineAt: number, token?: string): Promise<BrowserClawMcpClient> {
    const client = new BrowserClawMcpClient(endpoint, token);
    await client.initialize(deadlineAt);
    return client;
  }

  async callTool(name: string, argumentsValue: Record<string, unknown>, deadlineAt: number): Promise<string> {
    return textBlocks(await this.callToolResponse(name, argumentsValue, deadlineAt));
  }

  async callToolImage(name: string, argumentsValue: Record<string, unknown>, deadlineAt: number): Promise<BrowserClawScreenshot> {
    const response = await this.callToolResponse(name, argumentsValue, deadlineAt);
    const content = (response?.result as { content?: unknown } | undefined)?.content;
    const image = Array.isArray(content)
      ? content.find((item): item is { type: "image"; data: string; mimeType: BrowserClawScreenshot["mimeType"] } => Boolean(
        item && typeof item === "object" && (item as { type?: unknown }).type === "image"
          && typeof (item as { data?: unknown }).data === "string"
          && ["image/png", "image/jpeg", "image/webp"].includes((item as { mimeType?: unknown }).mimeType as string),
      ))
      : undefined;
    if (!image) throw new BrowserClawWorkerError("browser_action_failed", "BrowserClaw screenshot did not return an image");
    return { mimeType: image.mimeType, data: image.data };
  }

  private async callToolResponse(name: string, argumentsValue: Record<string, unknown>, deadlineAt: number): Promise<Record<string, unknown> | null> {
    const response = await this.post({
      jsonrpc: "2.0",
      id: this.requestId++,
      method: "tools/call",
      params: { name, arguments: argumentsValue },
    }, deadlineAt, this.token);
    if (response?.error) throw new BrowserClawWorkerError("browser_action_failed", "BrowserClaw rejected the browser tool call");
    const result = response?.result as { isError?: boolean; content?: unknown } | undefined;
    if (!result || result.isError) throw new BrowserClawWorkerError("browser_action_failed", "BrowserClaw reported a browser tool failure");
    return response;
  }

  private async initialize(deadlineAt: number): Promise<void> {
    const response = await this.post({
      jsonrpc: "2.0",
      id: this.requestId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "agent-herder-browserclaw-worker", version: "1.0" },
      },
    }, deadlineAt, this.token);
    if (response?.error || !this.sessionId) throw new BrowserClawWorkerError("worker_unavailable", "BrowserClaw MCP initialization failed");
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, deadlineAt, this.token);
  }

  private async post(body: Record<string, unknown>, deadlineAt: number, token?: string): Promise<Record<string, unknown> | null> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    if (token) headers.authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(remainingMs(deadlineAt)),
      });
    } catch (error) {
      throw errorFromFetch(error);
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    if (!response.ok) throw new BrowserClawWorkerError(response.status >= 500 ? "worker_unavailable" : "worker_rejected", "BrowserClaw MCP returned a non-success status");
    const parsed = parseJsonRpcBody(await response.text());
    if (body.method === "initialize" && !this.sessionId) throw new BrowserClawWorkerError("worker_unavailable", "BrowserClaw MCP did not return a session");
    return parsed;
  }
}

export function browserWorkerPrompt(templateId: BrowserWorkerTemplateId): string {
  if (templateId === "secretary.browser-canary.v1") {
    return `Служебная проверка канала Agent Herder. Не вызывай внешние инструменты и ничего не меняй. Ответь ровно строкой, полученной объединением двух частей «${BROWSER_CANARY_TOKEN_PREFIX}» и «${BROWSER_CANARY_TOKEN_SUFFIX}» без пробела.`;
  }
  return "Посмотри входящие в личных сообщениях и общей группе подключенного аккаунта личного секретаря. Ответь тем, кому нужно, по правилам личного секретаря. Не выдумывай отсутствующие сообщения.";
}

function parsePageId(value: string): number | null {
  const match = value.match(/(?:opened page|page)\s+(\d+)/i);
  return match ? Number(match[1]) : null;
}

function parseTabs(value: string): BrowserClawPage[] {
  const pages: BrowserClawPage[] = [];
  const pattern = /^\s*\[(\d+)\]\s+(https?:\/\/\S+|chrome:\/\/\S+|about:\S+)/gm;
  for (const match of value.matchAll(pattern)) pages.push({ page: Number(match[1]), url: match[2] });
  return pages;
}

function targetIdentity(value: string): string {
  const parsed = new URL(value);
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

function findTargetRef(snapshot: string): string | null {
  const aliases = ["E-Frontier", "ИИ Фронтир — вечер", "ИИ Фронтир"];
  const aliasPattern = aliases.map(escapeRegExp).join("|");
  const pattern = new RegExp(`(?:link|button) "[^"\\n]*(?:${aliasPattern})[^"\\n]*" \\[ref=(e\\d+)\\]`, "i");
  return snapshot.match(pattern)?.[1] || null;
}

function findComposerRef(snapshot: string): string | null {
  const pattern = /textbox(?: "([^"]*)")? \[ref=(e\d+)\]/g;
  for (const match of snapshot.matchAll(pattern)) {
    const label = (match[1] || "").toLowerCase();
    if (!label || label.includes("чат с chatgpt") || label.includes("message chatgpt") || label.includes("сообщение")) return match[2];
  }
  return null;
}

function hasStreamingMarker(snapshot: string): boolean {
  return /Остановить|Stop generating|Прервать генерацию|Stop response/i.test(snapshot);
}

export interface BrowserClawBrowserDriverOptions {
  endpoint: string;
  token?: string;
  targetUrl?: string;
  clientFactory?: (deadlineAt: number) => Promise<BrowserClawToolClient>;
}

export class BrowserClawBrowserDriver {
  private client: BrowserClawToolClient | null = null;
  private targetPage: number | null = null;
  private lastFailureScreenshot: BrowserClawScreenshot | null = null;
  private lastStageScreenshot: BrowserClawScreenshot | null = null;

  constructor(private readonly options: BrowserClawBrowserDriverOptions) {
    const parsed = new URL(options.endpoint);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("BrowserClaw MCP endpoint must use http or https");
    if (options.targetUrl) {
      const target = new URL(options.targetUrl);
      if (target.protocol !== "https:" || target.hostname !== "chatgpt.com") throw new Error("Browser target URL must be an https chatgpt.com URL");
    }
  }

  async execute(request: BrowserWorkerRequest, deadlineAt: number): Promise<void> {
    this.lastFailureScreenshot = null;
    this.lastStageScreenshot = null;
    try {
      const { client, page } = await this.ensureTargetPage(deadlineAt);
      logBrowserStage("target-ready", page);
      const composer = await this.waitForComposer(client, page, deadlineAt);
      logBrowserStage("composer-ready", page);
      await client.callTool("act", { page, kind: "type", ref: composer, text: browserWorkerPrompt(request.templateId) }, deadlineAt);
      logBrowserStage("prompt-typed", page);
      await this.captureStageScreenshotBestEffort(client, page, "prompt-typed");
      await client.callTool("act", { page, kind: "press", key: "Enter" }, deadlineAt);
      logBrowserStage("prompt-submitted", page);
      await this.captureStageScreenshotBestEffort(client, page, "prompt-submitted");
      await this.waitForCompletion(client, page, request.templateId, deadlineAt);
      logBrowserStage("completion-ready", page);
    } catch (error) {
      if (this.client && this.targetPage !== null) {
        try {
          this.lastFailureScreenshot = await this.captureCurrentPageScreenshot(Date.now() + 10_000);
          logBrowserStage("failure-screenshot-ready", this.targetPage);
        } catch (screenshotError) {
          logBrowserStage("failure-screenshot-failed", this.targetPage, screenshotError);
        }
      }
      // Keep a valid BrowserClaw session/page after a UI-level failure so the
      // next wake does not create another tab. Only transport/session failures
      // force a reconnect; the cached page is validated on the next wake.
      if (!(error instanceof BrowserClawWorkerError) || error.errorClass === "worker_unavailable" || error.errorClass === "worker_timeout") {
        this.client = null;
        this.targetPage = null;
      }
      logBrowserStage("failed", this.targetPage === null ? undefined : this.targetPage, error);
      throw error;
    }
  }

  async captureScreenshot(deadlineAt: number): Promise<BrowserClawScreenshot> {
    if (this.lastFailureScreenshot) {
      logBrowserStage("screenshot-evidence-replay");
      return this.lastFailureScreenshot;
    }
    try {
      // After a browser failure the page may be busy or its snapshot may be
      // temporarily unavailable. Capture the cached page directly so the
      // evidence request cannot discard the very failure state being debugged.
      const cachedClient = this.client;
      const cachedPage = this.targetPage;
      const { client, page } = cachedClient && cachedPage !== null
        ? { client: cachedClient, page: cachedPage }
        : await this.ensureTargetPage(deadlineAt);
      const screenshot = await this.capturePageScreenshot(client, page, deadlineAt);
      logBrowserStage("screenshot-ready", page);
      return screenshot;
    } catch (error) {
      logBrowserStage("screenshot-failed", this.targetPage === null ? undefined : this.targetPage, error);
      throw error;
    }
  }

  async captureStageScreenshot(deadlineAt: number): Promise<BrowserClawScreenshot> {
    if (this.lastStageScreenshot) {
      logBrowserStage("screenshot-stage-replay");
      return this.lastStageScreenshot;
    }
    throw new BrowserClawWorkerError("browser_action_failed", "BrowserClaw stage screenshot is unavailable");
  }

  private async captureCurrentPageScreenshot(deadlineAt: number): Promise<BrowserClawScreenshot> {
    const client = this.client;
    const page = this.targetPage;
    if (!client || page === null) throw new BrowserClawWorkerError("browser_action_failed", "BrowserClaw failure page is unavailable");
    return this.capturePageScreenshot(client, page, deadlineAt);
  }

  private async capturePageScreenshot(client: BrowserClawToolClient, page: number, deadlineAt: number): Promise<BrowserClawScreenshot> {
    if (!client.callToolImage) throw new BrowserClawWorkerError("browser_action_failed", "BrowserClaw screenshot capability is unavailable");
    return client.callToolImage("screenshot", { page, format: "png", fullPage: false, size: { width: 1440, height: 1000 } }, deadlineAt);
  }

  private async captureStageScreenshotBestEffort(client: BrowserClawToolClient, page: number, stage: string): Promise<void> {
    try {
      this.lastStageScreenshot = await this.capturePageScreenshot(client, page, Date.now() + 10_000);
      logBrowserStage(`${stage}-screenshot-ready`, page);
    } catch (error) {
      logBrowserStage(`${stage}-screenshot-failed`, page, error);
    }
  }

  private async getClient(deadlineAt: number): Promise<BrowserClawToolClient> {
    if (this.client) return this.client;
    this.client = this.options.clientFactory
      ? await this.options.clientFactory(deadlineAt)
      : await BrowserClawMcpClient.connect(this.options.endpoint, deadlineAt, this.options.token);
    return this.client;
  }

  private async ensureTargetPage(deadlineAt: number): Promise<{ client: BrowserClawToolClient; page: number }> {
    const client = await this.getClient(deadlineAt);
    // BrowserClaw page ids belong to the MCP session that opened them. Keep both
    // handles in memory so later wakes stay in the same session and tab.
    if (this.targetPage !== null) {
      try {
        await client.callTool("snapshot", { page: this.targetPage, mode: "interactive", depth: 1 }, deadlineAt);
        return { client, page: this.targetPage };
      } catch (error) {
        if (!(error instanceof BrowserClawWorkerError) || error.errorClass !== "browser_action_failed") throw error;
        this.targetPage = null;
      }
    }

    const tabs = this.options.targetUrl
      ? []
      : parseTabs(await client.callTool("tabs", { action: "list" }, deadlineAt));

    // Existing tabs may be owned by another BrowserClaw MCP session. Probe
    // only ChatGPT root tabs and skip an ownership error; direct navigation to
    // a conversation URL leaves the ChatGPT composer unloaded in this profile.
    for (const tab of tabs.filter((item) => item.url === "https://chatgpt.com/" || item.url.startsWith("https://chatgpt.com/?"))) {
      try {
        const snapshot = await client.callTool("snapshot", { page: tab.page, mode: "full", depth: 100 }, deadlineAt);
        const targetRef = findTargetRef(snapshot);
        if (!targetRef) continue;
        await client.callTool("act", { page: tab.page, kind: "click", ref: targetRef }, deadlineAt);
        this.targetPage = tab.page;
        await this.waitForTargetNavigation(client, tab.page, deadlineAt);
        logBrowserStage("target-loaded", tab.page);
        return { client, page: tab.page };
      } catch (error) {
        if (!(error instanceof BrowserClawWorkerError) || error.errorClass !== "browser_action_failed") throw error;
      }
    }

    const opened = await client.callTool("tabs", { action: "new", url: "https://chatgpt.com/" }, deadlineAt);
    const page = parsePageId(opened);
    if (page === null) throw new BrowserClawWorkerError("browser_session_not_found", "BrowserClaw did not open the ChatGPT root page");
    for (let attempt = 0; attempt < 30 && Date.now() < deadlineAt; attempt += 1) {
      const snapshot = await client.callTool("snapshot", { page, mode: "full", depth: 100 }, deadlineAt);
      const targetRef = findTargetRef(snapshot);
      if (targetRef) {
        await client.callTool("act", { page, kind: "click", ref: targetRef }, deadlineAt);
        this.targetPage = page;
        await this.waitForTargetNavigation(client, page, deadlineAt);
        logBrowserStage("target-loaded", page);
        return { client, page };
      }
      await client.callTool("wait", { page, for: "time", timeout: Math.min(1000, remainingMs(deadlineAt)), value: 500 }, deadlineAt);
    }
    throw new BrowserClawWorkerError("browser_session_not_found", "The allowlisted E-Frontier ChatGPT session was not found");
  }

  private async waitForTargetNavigation(client: BrowserClawToolClient, page: number, deadlineAt: number): Promise<void> {
    if (!this.options.targetUrl) return;
    const expected = targetIdentity(this.options.targetUrl);
    for (let attempt = 0; attempt < 60 && Date.now() < deadlineAt; attempt += 1) {
      const current = parseTabs(await client.callTool("tabs", { action: "list" }, deadlineAt)).find((tab) => tab.page === page);
      if (current && targetIdentity(current.url) === expected) return;
      await client.callTool("wait", { page, for: "time", timeout: Math.min(1000, remainingMs(deadlineAt)), value: 500 }, deadlineAt);
    }
    throw new BrowserClawWorkerError("browser_action_failed", "The E-Frontier conversation did not finish loading after target selection");
  }

  private async waitForComposer(client: BrowserClawToolClient, page: number, deadlineAt: number): Promise<string> {
    for (let attempt = 0; attempt < 60 && Date.now() < deadlineAt; attempt += 1) {
      const snapshot = await client.callTool("snapshot", { page, mode: "full", depth: 10 }, deadlineAt);
      const composer = findComposerRef(snapshot);
      if (composer) return composer;
      await client.callTool("wait", { page, for: "time", timeout: Math.min(1000, remainingMs(deadlineAt)), value: 500 }, deadlineAt);
    }
    throw new BrowserClawWorkerError("browser_action_failed", "The E-Frontier composer did not become available");
  }

  private async waitForCompletion(client: BrowserClawToolClient, page: number, templateId: BrowserWorkerTemplateId, deadlineAt: number): Promise<void> {
    if (templateId === "secretary.browser-canary.v1") {
      // The configured GPT may follow its own secretary workflow instead of
      // echoing the canary token. Prove completion by observing the real
      // streaming lifecycle: a stop/thinking marker must appear and then
      // disappear while the composer is restored.
      let sawStreaming = false;
      for (let attempt = 0; attempt < 120 && Date.now() < deadlineAt; attempt += 1) {
        const snapshot = await client.callTool("snapshot", { page, mode: "full", depth: 100 }, deadlineAt);
        if (hasStreamingMarker(snapshot)) sawStreaming = true;
        if (sawStreaming && !hasStreamingMarker(snapshot) && findComposerRef(snapshot)) return;
        await client.callTool("wait", { page, for: "time", timeout: Math.min(1000, remainingMs(deadlineAt)), value: 1000 }, deadlineAt);
      }
      throw new BrowserClawWorkerError("browser_action_failed", "The ChatGPT response did not finish before the browser deadline");
    }

    await client.callTool("wait", { page, for: "time", timeout: Math.min(1000, remainingMs(deadlineAt)), value: 500 }, deadlineAt);
    for (let attempt = 0; attempt < 16 && Date.now() < deadlineAt; attempt += 1) {
      const snapshot = await client.callTool("snapshot", { page, mode: "full", depth: 100 }, deadlineAt);
      if (findComposerRef(snapshot) && !hasStreamingMarker(snapshot)) {
        return;
      }
      await client.callTool("wait", { page, for: "time", timeout: Math.min(1000, remainingMs(deadlineAt)), value: 750 }, deadlineAt);
    }
    throw new BrowserClawWorkerError("browser_action_failed", "The ChatGPT response did not finish before the browser deadline");
  }
}

export class BrowserClawWorkerLedger {
  private readonly lockTarget: string;

  constructor(private readonly filePath: string) {
    this.lockTarget = `${filePath}.lock`;
  }

  async get(idempotencyId: string): Promise<BrowserWorkerLedgerRecord | null> {
    const file = await this.read();
    return file.records.find((record) => record.request.idempotencyId === idempotencyId) || null;
  }

  async put(record: BrowserWorkerLedgerRecord): Promise<void> {
    const file = await this.read();
    const index = file.records.findIndex((item) => item.request.idempotencyId === record.request.idempotencyId);
    if (index >= 0) file.records[index] = record;
    else file.records.push(record);
    await this.write(file);
  }

  async withLock<T>(operation: () => Promise<T>, deadlineMs: number): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.lockTarget, "", { flag: "a" });
    const release = await lockfile.lock(this.lockTarget, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: Math.max(0, Math.floor(deadlineMs / 25)), minTimeout: 25, maxTimeout: 25, factor: 1 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async read(): Promise<BrowserWorkerLedgerFile> {
    try {
      return browserWorkerLedgerFileSchema.parse(JSON.parse(await readFile(this.filePath, "utf8"))) as BrowserWorkerLedgerFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, records: [] };
      throw error;
    }
  }

  private async write(file: BrowserWorkerLedgerFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}

function sameRequest(left: BrowserWorkerRequest, right: BrowserWorkerRequest): boolean {
  return left.schema === right.schema && left.worker === right.worker && left.target === right.target && left.templateId === right.templateId && left.runId === right.runId && left.idempotencyId === right.idempotencyId && left.deadlineMs === right.deadlineMs && left.sourceRefs.length === right.sourceRefs.length && left.sourceRefs.every((ref, index) => ref === right.sourceRefs[index]);
}

function receiptForClaim(request: BrowserWorkerRequest, acceptedAt: string, receiptRef: string, errorClass?: BrowserWorkerErrorClass): BrowserWorkerReceipt {
  const failedAt = now();
  if (errorClass) {
    return { worker: request.worker, target: request.target, templateId: request.templateId, runId: request.runId, idempotencyId: request.idempotencyId, receiptRef, status: "failed", acceptedAt, failedAt, errorClass };
  }
  return { worker: request.worker, target: request.target, templateId: request.templateId, runId: request.runId, idempotencyId: request.idempotencyId, receiptRef, status: "completed", acceptedAt, completedAt: failedAt };
}

export class BrowserClawWorker {
  constructor(private readonly ledger: BrowserClawWorkerLedger, private readonly driver: BrowserClawDriver) {}

  async captureScreenshot(deadlineAt = Date.now() + 10_000): Promise<BrowserClawScreenshot> {
    if (!this.driver.captureScreenshot) throw new BrowserClawWorkerError("browser_action_failed", "Browser worker screenshot capability is unavailable");
    return this.driver.captureScreenshot(deadlineAt);
  }

  async captureStageScreenshot(deadlineAt = Date.now() + 10_000): Promise<BrowserClawScreenshot> {
    if (!this.driver.captureStageScreenshot) throw new BrowserClawWorkerError("browser_action_failed", "Browser worker stage screenshot capability is unavailable");
    return this.driver.captureStageScreenshot(deadlineAt);
  }

  async dispatch(input: unknown): Promise<BrowserWorkerReceipt> {
    const request = BrowserWorkerRequestSchema.parse(input);
    return this.ledger.withLock(async () => {
      const existing = await this.ledger.get(request.idempotencyId);
      if (existing) {
        if (!sameRequest(existing.request, request)) throw new BrowserClawWorkerConflictError();
        if (existing.status !== "claimed") return existing.receipt;
        const replay = receiptForClaim(existing.request, existing.acceptedAt, existing.receiptRef, "worker_unavailable");
        await this.ledger.put({ request: existing.request, status: "failed", receipt: replay });
        return replay;
      }

      const acceptedAt = now();
      const receiptRef = `browserclaw.receipt.${randomUUID()}`;
      await this.ledger.put({ request, status: "claimed", acceptedAt, receiptRef });
      try {
        await this.driver.execute(request, Date.now() + request.deadlineMs);
        const receipt = receiptForClaim(request, acceptedAt, receiptRef);
        await this.ledger.put({ request, status: "completed", receipt });
        return receipt;
      } catch (error) {
        const errorClass = error instanceof BrowserClawWorkerError
          ? error.errorClass
          : error instanceof BrowserWorkerDispatchError
            ? error.errorClass
            : "browser_action_failed" as const;
        const receipt = receiptForClaim(request, acceptedAt, receiptRef, errorClass);
        await this.ledger.put({ request, status: "failed", receipt });
        return receipt;
      }
    }, request.deadlineMs);
  }
}

function bearerMatches(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BrowserClawWorkerError("worker_rejected", "Browser worker request is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, { "content-type": "application/json", "content-length": Buffer.byteLength(serialized) });
  response.end(serialized);
}

function sendImage(response: ServerResponse, screenshot: BrowserClawScreenshot): void {
  const body = Buffer.from(screenshot.data, "base64");
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": body.length,
    "content-type": screenshot.mimeType,
  });
  response.end(body);
}

export interface BrowserClawWorkerServerOptions {
  host: string;
  port: number;
  token?: string;
  path?: string;
  worker: BrowserClawWorker;
}

export function createBrowserClawWorkerServer(options: BrowserClawWorkerServerOptions): Server {
  const endpointPath = options.path || "/browser-wake";
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      sendJson(response, 200, { ok: true, worker: "mac-mini-browserclaw" });
      return;
    }
    if (request.method === "GET" && request.url === "/debug/screenshot") {
      if (!bearerMatches(request, options.token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      try {
        sendImage(response, await options.worker.captureScreenshot(Date.now() + 30_000));
      } catch {
        sendJson(response, 503, { error: "screenshot_unavailable" });
      }
      return;
    }
    if (request.method === "GET" && request.url === "/debug/screenshot/stage") {
      if (!bearerMatches(request, options.token)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      try {
        sendImage(response, await options.worker.captureStageScreenshot());
      } catch {
        sendJson(response, 404, { error: "stage_screenshot_unavailable" });
      }
      return;
    }
    if (request.method !== "POST" || request.url !== endpointPath) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (!bearerMatches(request, options.token)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    try {
      const input = JSON.parse(await readBody(request)) as unknown;
      const parsed = BrowserWorkerRequestSchema.parse(input);
      const receipt = await options.worker.dispatch(parsed);
      sendJson(response, 200, receipt);
    } catch (error) {
      if (error instanceof BrowserClawWorkerConflictError) {
        sendJson(response, error.statusCode, { error: "idempotency_conflict" });
      } else if (error instanceof z.ZodError || error instanceof SyntaxError) {
        sendJson(response, 400, { error: "invalid_request" });
      } else if (error instanceof BrowserClawWorkerError && error.errorClass === "worker_rejected") {
        sendJson(response, 413, { error: "request_rejected" });
      } else {
        sendJson(response, 503, { error: "worker_unavailable" });
      }
    }
  });
}

export function createConfiguredBrowserClawWorker(environment: NodeJS.ProcessEnv = process.env): BrowserClawWorker {
  const endpoint = environment.AGENT_HERDER_BROWSERCLAW_MCP_URL || DEFAULT_BROWSERCLAW_MCP_URL;
  const targetUrl = environment.AGENT_HERDER_BROWSER_TARGET_URL;
  const token = environment.AGENT_HERDER_BROWSERCLAW_MCP_TOKEN?.trim() || undefined;
  return new BrowserClawWorker(
    new BrowserClawWorkerLedger(environment.AGENT_HERDER_BROWSER_WORKER_LEDGER || ".agent-herder/browser-worker-ledger.json"),
    new BrowserClawBrowserDriver({ endpoint, targetUrl, token }),
  );
}

export function createConfiguredBrowserClawWorkerServer(environment: NodeJS.ProcessEnv = process.env): Server {
  const host = environment.AGENT_HERDER_BROWSER_WORKER_HOST || DEFAULT_WORKER_HOST;
  const portValue = environment.AGENT_HERDER_BROWSER_WORKER_PORT || String(DEFAULT_WORKER_PORT);
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AGENT_HERDER_BROWSER_WORKER_PORT must be a valid TCP port");
  return createBrowserClawWorkerServer({
    host,
    port,
    token: environment.AGENT_HERDER_BROWSER_WORKER_TOKEN?.trim() || undefined,
    path: environment.AGENT_HERDER_BROWSER_WORKER_PATH || "/browser-wake",
    worker: createConfiguredBrowserClawWorker(environment),
  });
}

export async function startConfiguredBrowserClawWorker(environment: NodeJS.ProcessEnv = process.env): Promise<Server> {
  const server = createConfiguredBrowserClawWorkerServer(environment);
  const host = environment.AGENT_HERDER_BROWSER_WORKER_HOST || DEFAULT_WORKER_HOST;
  const port = Number(environment.AGENT_HERDER_BROWSER_WORKER_PORT || DEFAULT_WORKER_PORT);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
