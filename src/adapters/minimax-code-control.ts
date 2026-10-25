import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Control transport for the live MiniMax Code desktop runtime.
 *
 * The desktop app owns its sessions inside its own process tree: the renderer
 * talks to the runtime hosted by the utility process over a MessagePort. The
 * same runtime can be published on loopback HTTP by the app's diagnostic
 * sidecar, which writes a manifest with the chosen port. Every request of that
 * transport is forwarded to the very runtime the app is showing, so an
 * external controller steers and queues the real session instead of a copy of
 * the on-disk store.
 *
 * Wire contract: the generated DesktopService thrift routes.
 *   POST /minimax-desktop/api/v1/session/:id/message    send a prompt (event stream)
 *   POST /minimax-desktop/api/v1/session/:id/steer     steer the running turn
 *   POST /minimax-desktop/api/v1/session/:id/queue     enqueue a prompt
 *   GET  /minimax-desktop/api/v1/session/:id/queue     read the queue
 *   POST /minimax-desktop/api/v1/session/:id/abort     abort the running turn
 *   GET  /minimax-desktop/api/v1/session/:id           read one session
 *   GET  /minimax-desktop/api/v1/session/:id/message   read the live transcript
 */

/** Manifest published by the desktop app when its loopback transport is on. */
export interface MinimaxControlManifest {
  port: number;
  host: string;
  pid: number;
  owner?: string;
  mode?: string;
  startedAt?: string;
  startedAtMs?: number;
  startupToken?: string;
}

export const MINIMAX_CONTROL_MANIFEST_PATH =
  process.env.MINIMAX_CODE_CONTROL_MANIFEST?.trim() ||
  join(homedir(), ".minimax", "run", "mcode-diagnostic.json");

/** Prefix of the generated DesktopService routes. */
export const MINIMAX_CONTROL_API_PREFIX = "/minimax-desktop/api/v1";

export interface MinimaxControlResult {
  ok: boolean;
  status: number;
  /** Parsed response body, or the first event frame of a streamed answer. */
  body: unknown;
  error?: string;
}

export interface MinimaxControlOptions {
  manifestPath?: string;
  /** How long a published manifest is trusted before it is re-read. */
  manifestTtlMs?: number;
  /** Deadline of one control request. */
  timeoutMs?: number;
  /** Installed official MiniMax Code CLI, used only for exact-ID idle delivery. */
  cliPath?: string;
  /** A timeout after process start is an unknown native outcome and is never replayable. */
  cliTimeoutMs?: number;
}

function errorMessageFrom(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["serverMessage", "message", "error"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    const code = record.code;
    if (typeof code === "string" && code.trim()) return code;
  }
  return `MiniMax Code control request failed with status ${status}`;
}

function parseJsonSafe(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class MinimaxCodeControl {
  private readonly manifestPath: string;
  private readonly manifestTtlMs: number;
  private readonly timeoutMs: number;
  private readonly cliPath: string;
  private readonly cliTimeoutMs: number;
  private cached: { manifest: MinimaxControlManifest | null; at: number } | null = null;

  constructor(options: MinimaxControlOptions = {}) {
    this.manifestPath = options.manifestPath || MINIMAX_CONTROL_MANIFEST_PATH;
    this.manifestTtlMs = options.manifestTtlMs ?? 2_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.cliPath = options.cliPath || join(homedir(), ".npm-global", "bin", "mcode");
    this.cliTimeoutMs = options.cliTimeoutMs ?? 5 * 60_000;
  }

  /** Read the published transport manifest, if the app published one. */
  async manifest(): Promise<MinimaxControlManifest | null> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < this.manifestTtlMs) return this.cached.manifest;
    let manifest: MinimaxControlManifest | null = null;
    try {
      const raw = JSON.parse(await readFile(this.manifestPath, "utf8")) as Partial<MinimaxControlManifest>;
      if (typeof raw.port === "number" && raw.port > 0 && raw.port < 65_536) {
        manifest = {
          port: raw.port,
          host: typeof raw.host === "string" && raw.host.trim() ? raw.host.trim() : "127.0.0.1",
          pid: typeof raw.pid === "number" ? raw.pid : 0,
          owner: raw.owner,
          mode: raw.mode,
          startedAt: raw.startedAt,
          startedAtMs: raw.startedAtMs,
          startupToken: raw.startupToken,
        };
      }
    } catch {
      manifest = null;
    }
    this.cached = { manifest, at: now };
    return manifest;
  }

  /** True when the desktop app published its live runtime transport. */
  async available(): Promise<boolean> {
    return (await this.manifest()) !== null;
  }

  /** Send a prompt and start or continue a turn. */
  async sendMessage(id: string, content: string, options: { model?: string } = {}): Promise<MinimaxControlResult> {
    const body: Record<string, unknown> = { content };
    if (options.model) body.model = { model: options.model };
    return this.stream("POST", `/session/${encodeURIComponent(id)}/message`, body);
  }

  /**
   * Run one message in the existing native session through the installed MCode
   * CLI. This is only a transport fallback when Desktop did not publish its
   * owner manifest; callers must preflight exact native identity, workspace,
   * idle status, no turn lease and a durable UserMessageDelivery claim.
   *
   * No model, permission or resume override is supplied: MCode restores the
   * selected session's persisted configuration. Prompt text is sent on stdin,
   * never interpolated into argv or shell text.
   */
  async runSession(id: string, workspace: string, content: string): Promise<MinimaxControlResult> {
    return new Promise((resolve) => {
      const env = { ...process.env };
      for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "OMNIROUTE_API_KEY", "OMNIROUTE_BASE_URL"]) delete env[key];
      let child;
      try {
        child = spawn(this.cliPath, [
          "exec", "--cwd", workspace, "--session", id,
          "--input", "-", "--input-format", "text", "--output-format", "json",
        ], { cwd: workspace, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      } catch {
        resolve({ ok: false, status: 0, body: { started: false, errorKind: "cli_unavailable" }, error: "mcode_cli_unavailable" });
        return;
      }
      let started = false;
      let timedOut = false;
      let outputOverflow = false;
      let stdout = "";
      let stdoutBytes = 0;
      const maxOutputBytes = 2 * 1024 * 1024;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, this.cliTimeoutMs);
      child.once("spawn", () => { started = true; });
      child.stdout.on("data", (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += data.length;
        if (stdoutBytes > maxOutputBytes) {
          outputOverflow = true;
          child.kill("SIGTERM");
          return;
        }
        stdout += data.toString("utf8");
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolve({ ok: false, status: 0, body: { started, errorKind: "cli_unavailable" }, error: started ? "mcode_cli_outcome_unknown" : "mcode_cli_unavailable" });
      });
      child.once("close", (code: number | null) => {
        clearTimeout(timer);
        if (!started) {
          resolve({ ok: false, status: 0, body: { started: false, errorKind: "cli_unavailable" }, error: "mcode_cli_unavailable" });
          return;
        }
        let parsed: Record<string, unknown> | null = null;
        try {
          const value = JSON.parse(stdout.trim()) as unknown;
          if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
        } catch { /* A process that ran without a parseable receipt is unknown. */ }
        const modelValue = parsed?.model;
        const model = modelValue && typeof modelValue === "object" && !Array.isArray(modelValue)
          ? modelValue as Record<string, unknown>
          : undefined;
        const safeModel = model ? {
          ...(typeof model.providerId === "string" ? { providerId: model.providerId } : {}),
          ...(typeof model.modelId === "string" ? { modelId: model.modelId } : {}),
          ...(typeof model.providerKind === "string" ? { providerKind: model.providerKind } : {}),
        } : undefined;
        const nativeSessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId : undefined;
        const turnId = typeof parsed?.turnId === "string" ? parsed.turnId : undefined;
        const status = typeof parsed?.status === "string" ? parsed.status : undefined;
        const usageSource = typeof parsed?.usageSource === "string" ? parsed.usageSource : undefined;
        const rawError = typeof parsed?.error === "string" ? parsed.error : "";
        const busy = /already has an active writer|prompt is already running/i.test(rawError);
        const body = {
          started,
          ...(nativeSessionId ? { sessionId: nativeSessionId } : {}),
          ...(turnId ? { turnId } : {}),
          ...(status ? { status } : {}),
          ...(safeModel ? { model: safeModel } : {}),
          ...(usageSource ? { usageSource } : {}),
          ...(busy ? { errorKind: "session_busy" } : {}),
          ...(timedOut ? { timedOut: true } : {}),
          ...(outputOverflow ? { outputOverflow: true } : {}),
        };
        if (code === 0 && !timedOut && !outputOverflow && nativeSessionId && turnId && status === "succeeded" && safeModel?.providerId && safeModel.modelId && safeModel.providerKind) {
          resolve({ ok: true, status: 200, body });
          return;
        }
        resolve({ ok: false, status: typeof code === "number" ? code : 0, body, error: busy ? "session_busy" : "mcode_cli_outcome_unknown" });
      });
      child.stdin.once("error", () => { /* close reports the native outcome as unknown */ });
      child.stdin.end(content);
    });
  }

  /**
   * Steer the turn that is running right now.
   *
   * The runtime steers a queued item, not free text: the message is queued
   * first and the queue item is then addressed. When the runtime already
   * consumed that item and started a turn with it, the steer target is gone
   * and the message is delivered anyway.
   */
  async steer(id: string, content: string, options: { queueItemId?: string } = {}): Promise<MinimaxControlResult> {
    if (options.queueItemId) {
      const body: Record<string, unknown> = { content, queue_item_id: options.queueItemId };
      return this.call("POST", `/session/${encodeURIComponent(id)}/steer`, body);
    }
    const queued = await this.enqueue(id, content);
    if (!queued.ok) return queued;
    const itemId = (queued.body as { item_id?: string } | null)?.item_id;
    if (!itemId) return queued;
    const steered = await this.call("POST", `/session/${encodeURIComponent(id)}/steer`, {
      content,
      queue_item_id: itemId,
    });
    if (!steered.ok && steered.status === 404) {
      return {
        ok: true,
        status: queued.status,
        body: { ...((queued.body ?? {}) as Record<string, unknown>), steered: false },
      };
    }
    return steered;
  }

  /** Enqueue a prompt for the next turn. */
  async enqueue(id: string, content: string, options: { model?: string } = {}): Promise<MinimaxControlResult> {
    const body: Record<string, unknown> = { content };
    if (options.model) body.model = { model: options.model };
    return this.call("POST", `/session/${encodeURIComponent(id)}/queue`, body);
  }

  /** Abort the running turn while keeping the session resumable. */
  async abort(id: string, reason?: string): Promise<MinimaxControlResult> {
    const body: Record<string, unknown> = {};
    if (reason) body.reason = reason;
    return this.call("POST", `/session/${encodeURIComponent(id)}/abort`, body);
  }

  /** Read the pending queue of one session. */
  async listQueue(id: string): Promise<MinimaxControlResult> {
    return this.call("GET", `/session/${encodeURIComponent(id)}/queue`);
  }

  /** Read one live session. */
  async getSession(id: string): Promise<MinimaxControlResult> {
    return this.call("GET", `/session/${encodeURIComponent(id)}`);
  }

  /** Read the live transcript of one session. */
  async getMessages(id: string, options: { limit?: number } = {}): Promise<MinimaxControlResult> {
    const query = options.limit && options.limit > 0 ? `?limit=${Math.floor(options.limit)}` : "";
    return this.call("GET", `/session/${encodeURIComponent(id)}/message${query}`);
  }

  /** One metadata-only request against the published transport. */
  async call(method: string, path: string, body?: unknown): Promise<MinimaxControlResult> {
    const response = await this.request(method, path, body);
    if (!response) {
      return { ok: false, status: 0, body: null, error: "MiniMax Code control transport is not published" };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const parsed = parseJsonSafe(text);
      return { ok: false, status: response.status, body: parsed, error: errorMessageFrom(parsed, response.status) };
    }
    const text = await response.text().catch(() => "");
    return { ok: true, status: response.status, body: parseJsonSafe(text) };
  }

  /**
   * One streamed request. The first event frame carries the admission receipt,
   * and the rest of the stream is drained in the background: closing it early
   * would abort the request signal the runtime hands to the admitted turn.
   */
  private async stream(method: string, path: string, body: unknown): Promise<MinimaxControlResult> {
    const response = await this.request(method, path, body);
    if (!response) {
      return { ok: false, status: 0, body: null, error: "MiniMax Code control transport is not published" };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const parsed = parseJsonSafe(text);
      return { ok: false, status: response.status, body: parsed, error: errorMessageFrom(parsed, response.status) };
    }
    const reader = response.body?.getReader();
    if (!reader) return { ok: true, status: response.status, body: null };
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const boundary = buffer.indexOf("\n\n");
        if (boundary < 0) continue;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const payload = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        void this.drain(reader, decoder);
        return { ok: true, status: response.status, body: payload ? parseJsonSafe(payload) : null };
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      return {
        ok: false,
        status: response.status,
        body: null,
        error: `MiniMax Code control stream failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { ok: true, status: response.status, body: null };
  }

  /** Keep the event stream open until the turn ends. */
  private async drain(reader: ReadableStreamDefaultReader<Uint8Array>, decoder: TextDecoder): Promise<void> {
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
        decoder.decode(new Uint8Array(0), { stream: true });
      }
    } catch {
      // The turn owns its own lifetime; a closed stream is not a failure.
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response | null> {
    const manifest = await this.manifest();
    if (!manifest) return null;
    const url = `http://${manifest.host}:${manifest.port}${MINIMAX_CONTROL_API_PREFIX}${path}`;
    try {
      return await fetch(url, {
        method,
        headers: body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // A published manifest can outlive the app; drop it so the next call
      // re-reads the file instead of retrying a dead port.
      this.cached = { manifest: null, at: Date.now() };
      return null;
    }
  }
}
