import type { ClaudeEffectiveSettings } from "../types/common.js";
import { createHash, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import {
  getSessionInfo, getSessionMessages, listSessions, query,
  type CanUseTool, type HookCallback, type Options, type Query, type SDKMessage,
  type SDKSessionInfo, type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentSession, ClaudeCreateSettings, ControlResult, CreateSessionOptions, HarnessAdapter,
  ListSessionsOptions, PermissionRequest, SendMessageOptions, SessionMessageView,
} from "../types/index.js";
import { localSessionHostId } from "../types/index.js";
import { resolveAutopilotStateDir } from "../autopilot/state-dir.js";
import { ClaudeCodeAdapter } from "./claude.js";

const missing = (error: string): ControlResult => ({ ok: false, notSubmitted: true, error });
const lost: ControlResult = { ok: false, admissionUnknown: true, nonRetryable: true, error: "Claude stream closed before receipt" };
type Settings = ClaudeCreateSettings & { model?: string };
type Reply = (result: ControlResult) => void;

// A retry after a lost stream reply can locate the same user frame in native
// JSONL. UUIDv8 reserves application-defined bits; use a session-scoped hash.
function inputUuid(session: string, key: string): ReturnType<typeof randomUUID> {
  const bytes = createHash("sha256").update(JSON.stringify(["herder-claude-input-v1", session, key])).digest();
  bytes[6] = (bytes[6] & 15) | 0x80;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString("hex", 0, 16);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

class ClaudeStream {
  readonly input = new PassThrough({ objectMode: true });
  readonly query: Query;
  readonly ready: Promise<unknown>;
  readonly done: Promise<void>;
  readonly pending = new Map<string, { prompt: PermissionRequest; answer: (allow: boolean) => void }>();
  readonly effective: ClaudeEffectiveSettings = { thinkingBudget: null };
  private readonly acks = new Map<string, Reply>();
  busy = false;
  activeInput?: string;
  initialized = false;
  lastError?: string;
  closed = false;
  lastTool?: string;
  lastLine?: string;
  private completion?: { uuid: string; admitted: boolean; finish: Reply };
  private readonly queued = new Set<string>();

  constructor(readonly id: string, options: Options, onClose: () => void) {
    const observe: HookCallback = async (event) => {
      if (!event.agent_id && event.effort) this.effective.effort = event.effort.level;
      return {};
    };
    this.query = query({ prompt: this.input, options: {
      ...options, extraArgs: { "replay-user-messages": null },
      hooks: { Stop: [{ hooks: [observe] }], PreToolUse: [{ hooks: [observe] }] },
      canUseTool: this.permission,
    } });
    this.ready = this.query.initializationResult().then(async () => {
      // 0.3.207 exposes the native get_settings control at runtime. Its
      // response also contains unrelated user settings; project only applied values.
      const control = this.query as Query & { getSettings?: () => Promise<{
        applied?: Record<string, unknown>; effective?: { env?: { MAX_THINKING_TOKENS?: string } };
      }> };
      const native = await control.getSettings?.().catch(() => undefined);
      const applied = native?.applied;
      if (typeof applied?.model === "string") this.effective.model = applied.model;
      if (typeof applied?.effort === "string") this.effective.effort = applied.effort;
      const ceiling = native?.effective?.env?.MAX_THINKING_TOKENS;
      if (ceiling && /^\d+$/.test(ceiling)) this.effective.thinkingBudget = Number(ceiling);
      this.initialized = true;
    });
    this.done = this.drain().finally(() => {
      this.closed = true;
      this.input.end();
      for (const resolve of this.acks.values()) resolve(lost);
      this.acks.clear();
      this.completion?.finish(lost);
      for (const p of this.pending.values()) p.answer(false);
      onClose();
    });
  }

  private permission: CanUseTool = async (tool, input, opts) => {
    const id = opts.requestId || opts.toolUseID;
    return new Promise((resolve) => {
      const abort = () => answer(false);
      const timer = setTimeout(abort, 300_000);
      const answer = (allow: boolean) => {
        clearTimeout(timer);
        opts.signal.removeEventListener("abort", abort);
        this.pending.delete(id);
        resolve(allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Permission denied or expired" });
      };
      this.pending.set(id, { prompt: { id, type: "tool_use", toolName: tool, description: opts.title || opts.description || tool }, answer });
      opts.signal.addEventListener("abort", abort, { once: true });
      if (opts.signal.aborted || this.closed) abort();
    });
  };

  private async drain() {
    try {
      for await (const event of this.query) this.observe(event);
    } catch { /* Stream termination resolves outstanding callers in done. */ }
  }

  private observe(event: SDKMessage) {
    if (event.session_id !== this.id) return;
    if (event.type === "system" && event.subtype === "init") {
      this.effective.model = event.model;
      this.effective.permissionMode = event.permissionMode;
    } else if (event.type === "user" && "isReplay" in event && event.isReplay) {
      if (this.completion?.uuid === event.uuid) this.completion.admitted = true;
      if (this.queued.delete(event.uuid)) {
        this.busy = true;
        this.activeInput = event.uuid;
      }
      this.acks.get(event.uuid)?.({ ok: true, admitted: true, nativeInputMessageId: event.uuid });
      this.acks.delete(event.uuid);
    } else if (event.type === "assistant" && !event.parent_tool_use_id) {
      if (event.error) this.lastError = event.error;
      for (const block of event.message.content) {
        if (block.type === "text" && block.text.trim()) this.lastLine = block.text.trim().split(/\r?\n/).at(-1)?.slice(0, 240);
        if (block.type === "tool_use") this.lastTool = block.name;
      }
    } else if (event.type === "result") {
      this.busy = this.queued.size > 0;
      this.activeInput = undefined;
      if (!this.completion?.admitted) return;
      this.completion.finish(event.is_error || event.subtype !== "success"
        ? { ok: false, admitted: true, nonRetryable: true, error: `Claude turn failed (${this.lastError || event.subtype})` }
        : { ok: true, admitted: true });
      this.completion = undefined;
    }
  }

  send(options: SendMessageOptions, seed = false): Promise<ControlResult> {
    if (this.closed || ((options.activeTurnOnly || options.steer) && !this.activeInput)) return Promise.resolve(missing("No owned active Claude turn"));
    const sync = !seed && !options.queue && !options.steer;
    if (sync && this.busy) return Promise.resolve(missing("Claude is busy; select queue or steer"));
    const uuid = options.inputId ? inputUuid(this.id, options.inputId) : randomUUID();
    if (this.acks.has(uuid) || this.queued.has(uuid) || this.completion?.uuid === uuid) {
      return Promise.resolve({ ...lost, error: "Claude input is already in flight" });
    }
    const frame: SDKUserMessage = {
      type: "user", session_id: this.id, uuid, parent_tool_use_id: null,
      message: { role: "user", content: options.message },
      ...(seed ? { shouldQuery: false } : { priority: options.steer ? "now" : "next" }),
    };
    if (!seed && !this.busy) {
      this.lastError = undefined;
    }
    if (!seed) {
      this.busy = true;
      this.queued.add(uuid);
    }
    return new Promise((resolve) => {
      // Each asynchronous call gets its own native user-message echo. Only
      // one synchronous caller can be waiting for the primary turn result.
      const timer = setTimeout(() => {
        this.acks.delete(uuid);
        if (this.completion?.finish === finish) this.completion = undefined;
        resolve({ ...lost, error: "Timed out waiting for Claude receipt" });
      }, sync ? 300_000 : 30_000);
      const finish: Reply = result => { clearTimeout(timer); resolve({ ...result, inputId: options.inputId }); };
      if (sync) this.completion = { uuid, admitted: false, finish };
      else this.acks.set(uuid, finish);
      this.input.write(frame);
    });
  }

  close() {
    this.closed = true;
    this.input.end();
    this.query.close();
    return this.done;
  }
}

export class ClaudeSDKAdapter implements HarnessAdapter {
  readonly type = "claude" as const;
  readonly name = "Claude Code (SDK)";
  readonly controlCapabilities = { steer: true, resume: true, terminate: true };
  private readonly streams = new Map<string, ClaudeStream>();
  private readonly opening = new Map<string, Promise<ClaudeStream>>();
  private snapshotLimited = false;
  private readonly files = new ClaudeCodeAdapter({ claudeDir: process.env.CLAUDE_CONFIG_DIR });

  async init() { await listSessions({ limit: 1 }); }

  private settingsPath(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid Claude session UUID");
    return join(resolveAutopilotStateDir(), "claude-sessions", id + ".json");
  }

  private async settings(id: string): Promise<Settings> {
    try { return JSON.parse(await readFile(this.settingsPath(id), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  }

  private async open(id: string, cwd: string, settings: Settings, title?: string) {
    const { model, effort, permissionMode, thinkingBudget } = settings;
    const stream = new ClaudeStream(id, {
      cwd, model, effort, permissionMode,
      ...(thinkingBudget === undefined ? {} : {
        thinking: thinkingBudget === 0 ? { type: "disabled" } : { type: "enabled", budgetTokens: thinkingBudget },
        settings: { env: { MAX_THINKING_TOKENS: String(thinkingBudget) } },
      }),
      ...(title === undefined ? { resume: id } : { sessionId: id, title }),
    }, () => { if (this.streams.get(id) === stream) this.streams.delete(id); });
    this.streams.set(id, stream);
    try { await stream.ready; return stream; }
    catch (error) { await stream.close(); throw error; }
  }

  async createSession(options: CreateSessionOptions) {
    if (options.reasoningEffort !== undefined || options.serviceTier !== undefined) {
      throw new Error("reasoningEffort and serviceTier require the Codex harness");
    }
    const id = randomUUID();
    const { model, effort, permissionMode, thinkingBudget } = options;
    const settings = { model, effort, permissionMode, thinkingBudget };
    await mkdir(join(resolveAutopilotStateDir(), "claude-sessions"), { recursive: true, mode: 0o700 });
    await writeFile(this.settingsPath(id), JSON.stringify(settings), { flag: "wx", mode: 0o600 });
    const stream = await this.open(id, options.cwd, settings, options.name);
    try {
      const result = await stream.send({ message: "Session initialized by Agent Herder." }, true);
      if (!result.ok) throw new Error(result.error);
      let info = await getSessionInfo(id, { dir: options.cwd });
      for (let retry = 0; info?.customTitle !== options.name && retry < 20; retry++) {
        await delay(100);
        info = await getSessionInfo(id, { dir: options.cwd });
      }
      if (!info || info.customTitle !== options.name) throw new Error("Claude session title not yet confirmed in native store");
      return this.row(info, settings);
    } catch (error) { await stream.close(); throw error; }
  }

  private async attach(id: string) {
    const live = this.streams.get(id);
    if (live) { await live.ready; return live; }
    let pending = this.opening.get(id);
    if (!pending) {
      pending = (async () => {
        const info = await getSessionInfo(id);
        if (!info?.cwd) throw new Error("Claude session or cwd unavailable");
        return this.open(id, info.cwd, await this.settings(id));
      })().finally(() => this.opening.delete(id));
      this.opening.set(id, pending);
    }
    return pending;
  }

  async resumeSession(id: string) {
    try { await this.attach(id); return { ok: true }; }
    catch { return missing("Claude could not resume the selected session"); }
  }

  async sendMessage(id: string, options: SendMessageOptions) {
    if (options.activeTurnOnly || options.steer) return this.sendActiveMessage(id, options);
    try { return await (await this.attach(id)).send(options); }
    catch { return missing("Claude session could not be opened"); }
  }

  async sendActiveMessage(id: string, options: SendMessageOptions) {
    const stream = this.streams.get(id);
    return stream ? stream.send({ ...options, steer: true }) : missing("No owned active Claude turn");
  }

  async dispose() {
    await Promise.all([...this.streams.values()].map(stream => stream.close()));
  }

  async stopSession(id: string) {
    const stream = this.streams.get(id) ?? await this.opening.get(id)?.catch(() => undefined);
    if (!stream) return missing("No owned Claude process for this session");
    await stream.close();
    return { ok: true };
  }

  async getPermissionState(id: string) {
    const stream = this.streams.get(id);
    if (!stream || stream.closed) return null;
    return {
      target: { hostId: localSessionHostId(), harness: this.type, sessionId: id },
      scope: "session" as const, canSetMode: false, currentMode: stream.effective.permissionMode,
      observedAt: new Date().toISOString(),
      pendingRequests: [...stream.pending.values()].map(({ prompt }) => ({
        id: prompt.id, toolName: prompt.toolName, reason: prompt.description, canRespond: true,
      })),
    };
  }

  async respondPermission(id: string, permissionId: string, response: "allow" | "deny", remember?: boolean) {
    const pending = this.streams.get(id)?.pending.get(permissionId);
    if (!pending || remember) return missing(remember ? "Persistent permission grants are unavailable" : "No such permission on this session");
    pending.answer(response === "allow");
    return { ok: true };
  }

  async setPermissions() { return missing("Use permissionMode at Claude session creation"); }

  private row(info: SDKSessionInfo, settings?: Settings): AgentSession {
    const stream = this.streams.get(info.sessionId);
    const prompt = stream?.pending.values().next().value?.prompt;
    const status = prompt ? "needs_input" : stream?.busy ? "running" : stream ? "idle" : "stopped";
    return {
      id: info.sessionId, harness: this.type, cwd: info.cwd ?? "", hostId: localSessionHostId(),
      title: (info.customTitle || info.summary || info.firstPrompt || "Untitled session").replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 128),
      lastActivity: new Date(info.lastModified).toISOString(), status, needsPermission: !!prompt,
      permissionDetails: prompt, model: stream?.effective.model, lastMessage: stream?.lastLine,
      meta: { ready: !!stream?.initialized && !stream.closed, requestedSettings: settings, effectiveSettings: stream?.effective,
        progress: { turnStatus: stream?.lastError && !stream.busy ? "failed" : status, error: stream?.lastError, lastTool: stream?.lastTool, lastAssistantLine: stream?.lastLine } },
    };
  }

  async getCoordinationActiveTurnId(id: string) {
    return this.streams.get(id)?.activeInput ?? null;
  }

  async changeModel(id: string, model: string) {
    const stream = await this.attach(id);
    if (stream.busy) return missing("Select a model while Claude is idle");
    await stream.query.setModel(model);
    // The next system/init carries the resolved native name, including alias expansion.
    delete stream.effective.model;
    const settings = { ...await this.settings(id), model };
    const path = this.settingsPath(id);
    const staged = path + "." + randomUUID();
    await mkdir(join(resolveAutopilotStateDir(), "claude-sessions"), { recursive: true, mode: 0o700 });
    await writeFile(staged, JSON.stringify(settings), { mode: 0o600 });
    await rename(staged, path);
    return { ok: true };
  }

  async listModels() {
    const stream = this.streams.values().next().value;
    return stream ? (await stream.query.supportedModels()).map(model => model.value) : this.files.listModels();
  }

  async listSessions(options: ListSessionsOptions = {}) {
    const limit = options.limit ?? 100;
    const infos = await listSessions({ dir: options.cwd, limit: limit + 1, includeWorktrees: false });
    this.snapshotLimited = infos.length > limit;
    return infos.slice(0, limit).map(info => {
      const row = this.row(info);
      delete row.meta;
      return row;
    });
  }

  getSessionSnapshotReceipt() {
    return { exhaustive: !this.snapshotLimited, observedAt: new Date().toISOString(), source: "claude-sdk",
      ...(this.snapshotLimited && { reason: "bounded_native_page" }) };
  }

  async findNamedSessions(name: string, cwd: string) {
    return (await listSessions({ dir: cwd, includeWorktrees: false })).filter(info => info.customTitle === name).map(info => this.row(info));
  }

  async getSession(id: string) {
    const info = await getSessionInfo(id);
    if (!info) return null;
    const row = this.row(info, await this.settings(id));
    if (!this.streams.has(id)) {
      const tail = await this.files.readProgress(id);
      row.lastMessage = tail.lastAssistantLine;
      row.meta!.progress = { turnStatus: row.status, ...tail };
    }
    return row;
  }

  async getCoordinationMessageAdmission(id: string, key: string) {
    const uuid = inputUuid(id, key);
    const rows = await getSessionMessages(id);
    return rows.some(row => row.session_id === id && row.type === "user" && row.uuid === uuid)
      ? { state: "admitted" as const } : { state: "not_found" as const };
  }

  async getSessionMessages(id: string, limit = 200, recoverInputId?: string): Promise<SessionMessageView[]> {
    const native = await getSessionMessages(id);
    const expected = recoverInputId && inputUuid(id, recoverInputId);
    const rows = expected ? native.filter(row => row.session_id === id && row.type === "user" && row.uuid === expected) : native.slice(-limit);
    return rows.map(({ uuid, type, message }) => {
      const { content } = message as { content?: string | { type: string; text?: string; name?: string }[] };
      const parts: SessionMessageView["parts"] = [];
      if (typeof content === "string") parts.push({ type: "text", text: content });
      else for (const block of content ?? []) {
        if (block.type === "text") parts.push({ type: "text", text: block.text });
        if (block.type === "tool_use") parts.push({ type: "tool_call", name: block.name });
      }
      return { id: uuid, nativeMessageId: uuid, sessionId: id, role: type, ...(expected && { inputId: recoverInputId }), parts, text: parts.map(p => p.text).filter(Boolean).join("\n") };
    });
  }

  getTranscript(id: string) { return this.files.getTranscript(id); }
  getRawTranscript(id: string, signal?: AbortSignal) { return this.files.getRawTranscript(id, signal); }
}
