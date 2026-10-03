import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import lockfile from "proper-lockfile";
import type { AgentSession, HarnessAdapter } from "./types/index.js";
import { coordinationNotes } from "./coordination-notes.js";
import { deferredMessages, withDeferred } from "./deferred-messages.js";

export type NamedSessionMode = "queue" | "sync";

export interface NamedSessionRequest {
  harness: string;
  name: string;
  cwd: string;
  model?: string;
}

export interface NewOrResumeNamedSessionRequest extends NamedSessionRequest {
  message: string;
  mode?: NamedSessionMode;
  model?: string;
}

export interface NamedSessionResult {
  ok: boolean;
  created: boolean;
  harness: string;
  name: string;
  cwd: string;
  sessionId?: string;
  delivery?: "accepted" | "completed" | "failed" | "not_attempted";
  model?: string;
  error?: string;
}

type NamedSessionResolution =
  | { kind: "error"; result: NamedSessionResult }
  | { kind: "resolved"; adapter: HarnessAdapter; target: AgentSession; created: boolean; normalized: NamedSessionRequest };

const queues = new Map<string, Promise<void>>();

export async function createNamedSession(
  adapters: Map<string, HarnessAdapter>,
  request: NamedSessionRequest,
): Promise<NamedSessionResult> {
  return withNamedSessionLock(request, async (normalized) => {
    const adapter = adapters.get(normalized.harness);
    if (!adapter) return failed(normalized, `Harness '${normalized.harness}' is not configured`);
    if (!adapter.createSession) return failed(normalized, `${adapter.name} does not support session creation`);
    let matches: AgentSession[];
    try {
      matches = await exactMatches(adapter, normalized.name, normalized.cwd);
    } catch (error) {
      return failed(normalized, (error as Error).message);
    }
    if (matches.length > 0) {
      return failed(normalized, `Named session '${normalized.name}' already exists for ${normalized.harness}:${normalized.cwd}`);
    }
    try {
      const session = await adapter.createSession({ name: normalized.name, cwd: normalized.cwd, model: request.model });
      return { ok: true, created: true, sessionId: session.id, model: request.model, ...normalized };
    } catch (error) {
      return failed(normalized, (error as Error).message);
    }
  });
}

export async function newOrResumeNamedSession(
  adapters: Map<string, HarnessAdapter>,
  request: NewOrResumeNamedSessionRequest,
): Promise<NamedSessionResult> {
  const resolved = await withNamedSessionLock<NamedSessionResolution>(request, async (normalized) => {
    const adapter = adapters.get(normalized.harness);
    if (!adapter) return { kind: "error", result: failed(normalized, `Harness '${normalized.harness}' is not configured`, "not_attempted") };
    if (!adapter.createSession) return { kind: "error", result: failed(normalized, `${adapter.name} does not support session creation`, "not_attempted") };

    let matches: AgentSession[];
    try {
      matches = await exactMatches(adapter, normalized.name, normalized.cwd);
    } catch (error) {
      return { kind: "error", result: failed(normalized, (error as Error).message, "not_attempted") };
    }
    if (matches.length > 1) {
      return { kind: "error", result: failed(normalized, `Ambiguous named session '${normalized.name}' for ${normalized.harness}:${normalized.cwd}`, "not_attempted") };
    }

    let target = matches[0];
    let created = false;
    if (!target) {
      try {
        target = await adapter.createSession({ name: normalized.name, cwd: normalized.cwd, model: request.model });
        created = true;
      } catch (error) {
        return { kind: "error", result: failed(normalized, (error as Error).message, "not_attempted") };
      }
    }
    return { kind: "resolved", adapter, target, created, normalized };
  });
  if (resolved.kind === "error") return resolved.result;

  const mode = request.mode || "sync";
  // A create request may accept a model option without the native service
  // actually applying it. Trust only the returned session state; otherwise
  // select the model explicitly before the first prompt.
  if (request.model !== undefined && resolved.target.model !== request.model) {
    if (!resolved.adapter.changeModel) {
      return {
        ok: false,
        created: resolved.created,
        sessionId: resolved.target.id,
        delivery: "not_attempted",
        error: `${resolved.adapter.name} does not support model selection before delivery`,
        ...resolved.normalized,
      };
    }
    const modelResult = await resolved.adapter.changeModel(resolved.target.id, request.model);
    if (!modelResult.ok) {
      return {
        ok: false,
        created: resolved.created,
        sessionId: resolved.target.id,
        delivery: "not_attempted",
        error: modelResult.error || "Model selection failed",
        ...resolved.normalized,
      };
    }
  }
  const injectedMessage = await coordinationNotes.inject(resolved.target, request.message);
  const delivery = await resolved.adapter.sendMessage(resolved.target.id, {
      message: injectedMessage,
      queue: mode === "queue",
  });
  if (!delivery.ok) {
    return {
      ok: false,
      created: resolved.created,
      sessionId: resolved.target.id,
      delivery: "failed",
      error: delivery.error || "Message delivery failed",
      ...(request.model ? { model: request.model } : {}),
      ...resolved.normalized,
    };
  }
  return {
    ok: true,
    created: resolved.created,
    sessionId: resolved.target.id,
    delivery: mode === "queue" ? "accepted" : "completed",
    ...(request.model ? { model: request.model } : {}),
    ...resolved.normalized,
  };
}

async function exactMatches(adapter: HarnessAdapter, name: string, cwd: string): Promise<AgentSession[]> {
  const sessions = adapter.findNamedSessions
    ? await adapter.findNamedSessions(name, cwd)
    : await adapter.listSessions({ cwd });
  const candidates = adapter.findNamedSessions ? sessions : sessions.filter((session) => session.title === name);
  const matches: AgentSession[] = [];
  for (const session of candidates) {
    try {
      if (await realpath(session.cwd) === cwd) matches.push(session);
    } catch {
      // A vanished legacy CWD cannot be the requested canonical identity.
    }
  }
  return matches;
}

async function normalize(request: NamedSessionRequest): Promise<NamedSessionRequest> {
  const harness = request.harness.trim();
  const name = request.name.trim();
  if (!harness) throw new Error("harness must be a non-empty string");
  if (!name) throw new Error("name must be a non-empty string");
  if (!isAbsolute(request.cwd)) throw new Error("cwd must be an absolute path");
  return { harness, name, cwd: await realpath(request.cwd) };
}

async function withNamedSessionLock<T>(
  request: NamedSessionRequest,
  operation: (normalized: NamedSessionRequest) => Promise<T>,
): Promise<T> {
  const normalized = await normalize(request);
  const key = `${normalized.harness}\u0000${normalized.cwd}\u0000${normalized.name}`;
  const previous = queues.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => current);
  queues.set(key, tail);
  await previous.catch(() => undefined);
  let releaseFileLock: (() => Promise<void>) | undefined;
  try {
    releaseFileLock = await acquireFileLock(key);
    return await operation(normalized);
  } finally {
    try {
      if (releaseFileLock) await releaseFileLock();
    } finally {
      release();
      if (queues.get(key) === tail) queues.delete(key);
    }
  }
}

async function acquireFileLock(key: string): Promise<() => Promise<void>> {
  const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
  const root = process.env.AGENT_HERDER_LOCK_DIR
    || (process.env.XDG_RUNTIME_DIR
      ? join(process.env.XDG_RUNTIME_DIR, "agent-herder", "named-session-locks")
      : join(tmpdir(), `agent-herder-${uid}`, "named-session-locks"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const digest = createHash("sha256").update(key).digest("hex");
  const lockTarget = join(root, digest);
  await writeFile(lockTarget, "", { flag: "a", mode: 0o600 });
  return lockfile.lock(lockTarget, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 120, minTimeout: 25, maxTimeout: 250, factor: 1.2 },
  });
}

function failed(
  request: NamedSessionRequest,
  error: string,
  delivery?: NamedSessionResult["delivery"],
): NamedSessionResult {
  return { ok: false, created: false, error, ...(delivery ? { delivery } : {}), ...request };
}

export type DeliverActivation = "always" | "if_running" | "defer";
export type DeliverCreate = "if_missing" | "never";
export interface DeliverNamedRequest extends NewOrResumeNamedSessionRequest { create?: DeliverCreate; activation?: DeliverActivation; }
export type DeliverResult = Omit<NamedSessionResult, "delivery"> & { sessionStatus?: AgentSession["status"]; activated?: boolean; delivery?: NamedSessionResult["delivery"] | "deferred" | "skipped_inactive" | "not_found"; };

export async function deliverNamedSession(adapters: Map<string,HarnessAdapter>, request: DeliverNamedRequest): Promise<DeliverResult> {
  return withNamedSessionLock(request, async normalized => {
    const adapter=adapters.get(normalized.harness);
    if (!adapter) return {...failed(normalized,`Harness '${normalized.harness}' is not configured`,"not_attempted"),activated:false};
    let matches:AgentSession[]; try { matches=await exactMatches(adapter,normalized.name,normalized.cwd); } catch(e){ return {...failed(normalized,(e as Error).message,"not_attempted"),activated:false}; }
    if (matches.length>1) return {...failed(normalized,`Ambiguous named session '${normalized.name}' for ${normalized.harness}:${normalized.cwd}`,"not_attempted"),activated:false};
    let target=matches[0], created=false;
    if (!target) {
      if ((request.create||"if_missing")==="never") return {ok:false,created:false,harness:normalized.harness,name:normalized.name,cwd:normalized.cwd,delivery:"not_found",activated:false,error:"Named session not found"};
      if (!adapter.createSession) return {...failed(normalized,`${adapter.name} does not support session creation`,"not_attempted"),activated:false};
      try { target=await adapter.createSession({name:normalized.name,cwd:normalized.cwd,model:request.model}); created=true; } catch(e){ return {...failed(normalized,(e as Error).message,"not_attempted"),activated:false}; }
    }
    const fresh=(await adapter.getSession(target.id)) || target; const activation=request.activation||"always";
    if (activation==="if_running" && fresh.status!=="running") return {ok:true,created,sessionId:fresh.id,sessionStatus:fresh.status,delivery:"skipped_inactive",activated:false,...normalized};
    if (activation==="defer" && fresh.status!=="running") { await deferredMessages.add(fresh.id,request.message); return {ok:true,created,sessionId:fresh.id,sessionStatus:fresh.status,delivery:"deferred",activated:false,...normalized}; }
    const pending=await withDeferred(fresh.id,request.message); const injected=await coordinationNotes.inject(fresh,pending.message);
    const sent=await adapter.sendMessage(fresh.id,{message:injected,queue:(request.mode||"queue")==="queue"});
    if (sent.ok && pending.ids.length) await deferredMessages.remove(pending.ids);
    return sent.ok ? {ok:true,created,sessionId:fresh.id,sessionStatus:fresh.status,delivery:(request.mode||"queue")==="queue"?"accepted":"completed",activated:true,...normalized} : {ok:false,created,sessionId:fresh.id,sessionStatus:fresh.status,delivery:"failed",activated:false,error:sent.error||"Message delivery failed",...normalized};
  });
}
