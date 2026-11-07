import WebSocket from "ws";
import type { ChromePageTools } from "./mac-mini-chrome-transport.js";

type TargetInfo = { targetId: string; type: string; title?: string; url?: string; browserContextId?: string };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type Socket = Pick<WebSocket, "on" | "send" | "close" | "readyState">;
type SocketFactory = (url: string) => Socket;

export interface DirectCdpConfig {
  /** Trusted browser-level CDP WebSocket URL, supplied explicitly by the owner. */
  endpoint: string;
  /** Exact existing BrowserContext to which this adapter is pinned. */
  contextId: string;
  /** Exact initial page target. A page created by new_page replaces it. */
  targetId: string;
  timeoutMs?: number;
}

/** Narrow direct-CDP implementation of the page operations ChatGPT uses. */
export class DirectCdpPageTools implements ChromePageTools {
  private socket?: Socket;
  private connecting?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private sessionId?: string;
  private currentTargetId: string;
  private closed = false;
  private readonly timeoutMs: number;
  private readonly socketFactory: SocketFactory;

  constructor(private readonly config: DirectCdpConfig, socketFactory: SocketFactory = url => new WebSocket(url)) {
    const endpoint = new URL(config.endpoint);
    if (!(["ws:", "wss:"].includes(endpoint.protocol)) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("CDP endpoint must be an explicit ws(s) URL without credentials, query or fragment");
    }
    if (!config.contextId.trim() || !config.targetId.trim()) throw new Error("CDP contextId and targetId are required");
    this.currentTargetId = config.targetId;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) {
      throw new Error("CDP timeoutMs must be between 100 and 120000");
    }
    this.socketFactory = socketFactory;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    switch (name) {
      case "list_pages": return this.listPages();
      case "new_page": return this.newPage(args);
      case "evaluate_script": return this.evaluate(args);
      case "navigate_page": return this.navigate(args);
      default: throw new Error(`unsupported_direct_cdp_tool:${name}`);
    }
  }

  private async connect(): Promise<void> {
    if (this.closed) throw new Error("direct_cdp_closed");
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = this.socketFactory(this.config.endpoint);
      this.socket = socket;
      const fail = (error: Error) => {
        if (this.socket === socket) this.socket = undefined;
        reject(error);
      };
      socket.on("open", () => resolve());
      socket.on("error", (error: Error) => fail(new Error(`direct_cdp_connect_failed:${error.message}`)));
      socket.on("message", (data: WebSocket.RawData) => this.onMessage(data.toString()));
      socket.on("close", () => this.onClose());
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private onMessage(raw: string): void {
    let frame: { id?: unknown; result?: unknown; error?: { message?: string } };
    try { frame = JSON.parse(raw) as typeof frame; }
    catch { return; }
    if (!Number.isSafeInteger(frame.id) || typeof frame.id !== "number") return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if (frame.error) pending.reject(new Error(`direct_cdp_command_failed:${String(frame.error.message || "unknown")}`));
    else pending.resolve(frame.result);
  }

  private onClose(): void {
    this.socket = undefined;
    this.sessionId = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("direct_cdp_disconnected; operation outcome may be unknown"));
    }
    this.pending.clear();
  }

  private async command<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("direct_cdp_disconnected");
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`direct_cdp_timeout:${method}; operation outcome may be unknown; do not retry`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (cause) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`direct_cdp_send_failed:${method}:${cause instanceof Error ? cause.message : "unknown"}; outcome may be unknown`));
      }
    });
  }

  private async targets(): Promise<TargetInfo[]> {
    const response = await this.command<{ targetInfos?: TargetInfo[] }>("Target.getTargets");
    return Array.isArray(response.targetInfos) ? response.targetInfos : [];
  }

  private async attachExactTarget(): Promise<void> {
    const target = (await this.targets()).find(item => item.targetId === this.currentTargetId);
    if (!target || target.type !== "page" || target.browserContextId !== this.config.contextId) {
      throw new Error("direct_cdp_target_context_mismatch");
    }
    const attached = await this.command<{ sessionId?: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    if (!attached.sessionId) throw new Error("direct_cdp_attach_missing_session");
    this.sessionId = attached.sessionId;
  }

  private async ensureSession(): Promise<string> {
    if (!this.sessionId) await this.attachExactTarget();
    if (!this.sessionId) throw new Error("direct_cdp_target_not_attached");
    return this.sessionId;
  }

  private async listPages(): Promise<string> {
    const target = (await this.targets()).find(item => item.targetId === this.currentTargetId);
    if (!target) return "";
    if (target.type !== "page" || target.browserContextId !== this.config.contextId) throw new Error("direct_cdp_target_context_mismatch");
    const url = target.url || "about:blank";
    const title = (target.title || "").replace(/[\r\n()]/gu, " ").slice(0, 200);
    return `1: ${title} (${url}) [selected]`;
  }

  private async newPage(args: Record<string, unknown>): Promise<string> {
    const url = typeof args.url === "string" ? new URL(args.url) : undefined;
    if (!url || url.protocol !== "https:" || url.origin !== "https://chatgpt.com") throw new Error("direct_cdp_new_page_url_rejected");
    const created = await this.command<{ targetId?: string }>("Target.createTarget", { url: url.toString(), browserContextId: this.config.contextId });
    if (!created.targetId) throw new Error("direct_cdp_new_page_missing_target");
    const prior = this.sessionId;
    this.sessionId = undefined;
    this.currentTargetId = created.targetId;
    await this.attachExactTarget();
    if (prior) await this.command("Target.detachFromTarget", { sessionId: prior }).catch(() => undefined);
    return "Direct CDP page opened";
  }

  private async evaluate(args: Record<string, unknown>): Promise<string> {
    if (args.pageId !== 1 || typeof args.function !== "string" || args.function.length > 512 * 1024) {
      throw new Error("direct_cdp_evaluate_requires_pinned_page_and_bounded_function");
    }
    const session = await this.ensureSession();
    const response = await this.command<{ result?: { value?: unknown }; exceptionDetails?: { text?: string } }>("Runtime.evaluate", {
      expression: `(${args.function})()`, returnByValue: true, awaitPromise: true, userGesture: true,
    }, session);
    if (response.exceptionDetails) throw new Error(`direct_cdp_evaluate_exception:${response.exceptionDetails.text || "page evaluation failed"}`);
    if (!response.result || !("value" in response.result)) throw new Error("direct_cdp_evaluate_no_value");
    return `\`\`\`json\n${JSON.stringify(response.result.value)}\n\`\`\``;
  }

  private async navigate(args: Record<string, unknown>): Promise<string> {
    if (args.pageId !== 1 || typeof args.url !== "string") throw new Error("direct_cdp_navigate_requires_pinned_page");
    const url = new URL(args.url);
    if (url.protocol !== "https:" || url.origin !== "https://chatgpt.com") throw new Error("direct_cdp_navigation_origin_rejected");
    const session = await this.ensureSession();
    const response = await this.command<{ errorText?: string }>("Page.navigate", { url: url.toString() }, session);
    if (response.errorText) throw new Error(`direct_cdp_navigation_failed:${response.errorText}`);
    return "Direct CDP navigation accepted";
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.onClose();
  }
}
