import { createHash } from "node:crypto";
import { join } from "node:path";
import { createOpenAICompatibleJudge, redactSecrets, type JudgeClient } from "../autopilot/index.js";
import { UserStyleStore } from "../autopilot/user-style.js";
import type { HerderJobRegistry } from "../herder-jobs.js";

type JudgeInput = Parameters<JudgeClient["decide"]>[0];
export type NoticePlaceNativeJudgeOptions = {
  port: { call(name: string, args: Record<string, unknown>, options?: { signal: AbortSignal }): Promise<unknown> };
  /** The protected local OpenCode profile pins provider/model; never an arbitrary remote instance. */
  instanceRef: "opencode-noticeplace-local";
  jobs: HerderJobRegistry;
  stateDir: string;
  /** Authoritative revision for this native Stop; no wall-clock/random identities. */
  revision(input: JudgeInput): Promise<string>;
  timeoutMs?: number;
  pollIntervalMs?: number;
};
type ObjectValue = Record<string, unknown>;
const MODEL = "minimax-coding-plan/MiniMax-M3.1-Flash";

/** Normalize actual MCP Complete/Task envelopes, including text-only compat tools. */
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("native_judge_invalid_envelope");
  return value as ObjectValue;
}
function unwrap(value: unknown): ObjectValue {
  let current = object(value);
  for (let depth = 0; depth < 8; depth++) {
    if (current.isError === true || current.error) throw new Error("native_judge_rpc_error");
    if (current.structuredContent) { current = object(current.structuredContent); continue; }
    if (Array.isArray(current.content)) {
      const texts = current.content.filter(item => item?.type === "text");
      if (texts.length !== 1 || typeof texts[0].text !== "string" || texts[0].text.length > 100_000) throw new Error("native_judge_invalid_content");
      current = object(JSON.parse(texts[0].text)); continue;
    }
    if (current.jsonrpc === "2.0" && current.result) { current = object(current.result); continue; }
    if (current.task && typeof current.task === "object") { current = object(current.task); continue; }
    return current;
  }
  throw new Error("native_judge_nested_envelope");
}
function taskRef(value: ObjectValue): string | undefined {
  const id = value.task_ref ?? value.taskId ?? value._herder_create_task;
  return typeof id === "string" && id.length > 0 && id.length <= 2048 ? id : undefined;
}
function ownedSession(value: ObjectValue): string | undefined {
  const body = value.result ? unwrap(value.result) : value;
  const create = body.create && typeof body.create === "object" ? object(body.create) : body;
  const ref = create.session_ref;
  return (create.effect === "confirmed" || create.created === true) && typeof ref === "string" && !!ref && ref.length <= 2048 ? ref : undefined;
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Existing judge prompt/parser/schema, with a local in-process transport seam:
 * fetchImpl below never performs HTTP; it submits one ordinary Rust create to
 * the protected subscription instance and returns its assistant JSON to the
 * existing validator. No arm, agent-resume, alternate provider or native send.
 * The existing jobs ledger pins accepted/UNKNOWN attempts across restart.
 */
export function createNoticePlaceNativeJudge(options: NoticePlaceNativeJudgeOptions): JudgeClient {
  if (options.instanceRef !== "opencode-noticeplace-local") throw new Error("native_judge_requires_protected_local_instance");
  if (!options.jobs.supportsDurableOnce()) throw new Error("native_judge_requires_durable_jobs");
  const timeout = Math.min(90_000, Math.max(1, options.timeoutMs ?? 90_000));
  const poll = Math.min(1000, Math.max(1, options.pollIntervalMs ?? 250));
  return {
    async decide(original) {
      if (!original.hook.session_id?.trim() || !original.hook.turn_id?.trim()) throw new Error("native_judge_requires_native_stop");
      const revision = await options.revision(original);
      if (typeof revision !== "string" || !revision.trim() || revision.length > 4096) throw new Error("native_judge_requires_revision");
      const input: JudgeInput = { ...original,
        evidence: redactSecrets(original.evidence).slice(0, 8000),
        hook: { ...original.hook, transcript_path: null,
          last_user_message: original.hook.last_user_message == null ? null : redactSecrets(original.hook.last_user_message).slice(0, 3500),
          last_assistant_message: original.hook.last_assistant_message == null ? null : redactSecrets(original.hook.last_assistant_message).slice(0, 3500) } };
      const fingerprint = createHash("sha256").update(JSON.stringify({ instance: options.instanceRef,
        native: original.hook.session_id, event: original.hook.turn_id, cwd: original.hook.cwd,
        revision })).digest("hex");
      const key = `notice-native-judge:${fingerprint}`;
      const contextFingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const job = options.jobs.start({ kind: "Проверка продолжения NoticePlace", ownerSessionId: original.hook.session_id,
        idempotencyKey: key, requestFingerprint: contextFingerprint, durableOnce: true,
        run: async () => {
          const controller = new AbortController();
          const deadline = Date.now() + timeout;
          const timer = setTimeout(() => controller.abort(), timeout);
          // Keep only ownership receipts in the durable failure record for reconciliation.
          const receipt: { task_ref?: string; session_ref?: string } = {};
          const call = async (name: string, args: ObjectValue) => {
            if (controller.signal.aborted || Date.now() >= deadline) throw new Error("native_judge_deadline");
            let rejectAbort!: () => void;
            const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error("native_judge_deadline")); });
            controller.signal.addEventListener("abort", rejectAbort, { once: true });
            try { return unwrap(await Promise.race([options.port.call(name, args, { signal: controller.signal }), aborted])); }
            finally { controller.signal.removeEventListener("abort", rejectAbort); }
          };
          try {
            const judge = createOpenAICompatibleJudge({
              // A descriptor only: the injected transport never calls this URL.
              baseUrl: "https://native-opencode.invalid", model: MODEL,
              styleStore: new UserStyleStore(join(options.stateDir, "user-style.json")),
              fetchImpl: async (_url, init) => {
                const body = object(JSON.parse(String(init?.body)));
                if (!Array.isArray(body.messages)) throw new Error("native_judge_prompt_unavailable");
                const prompt = "Read the following judge instructions and context as a single bounded evaluation. "
                  + "Return only the requested JSON; do not use tools or modify the workspace.\n"
                  + body.messages.map(message => `${message.role}: ${message.content}`).join("\n\n");
                if (prompt.length > 24_000) throw new Error("native_judge_prompt_too_large");
                const created = await call("create", { action: "create", instance_ref: options.instanceRef, prompt, request_key: key });
                const task = taskRef(created);
                let session = ownedSession(created);
                receipt.task_ref = task;
                receipt.session_ref = session;
                let admissionTerminal = false;
                let nativeTerminal = false;
                try {
                  if (task) {
                    for (let reads = 0; reads < 400; reads++) {
                      const state = await call("compat_task", { action: "get", task_ref: task });
                      const returnedTask = taskRef(state);
                      if (returnedTask && returnedTask !== task) throw new Error("native_judge_task_mismatch");
                      const ref = ownedSession(state);
                      if (ref && session && ref !== session) throw new Error("native_judge_session_mismatch");
                      session = ref ?? session;
                      receipt.session_ref = session;
                      if (["completed", "failed", "cancelled"].includes(String(state.status))) {
                        admissionTerminal = true;
                        if (state.status !== "completed") throw new Error("native_judge_task_failed");
                        break;
                      }
                      await delay(Math.min(poll, Math.max(1, deadline - Date.now())));
                    }
                    if (!admissionTerminal) throw new Error("native_judge_read_budget_exhausted");
                  }
                  if (!session || session === original.hook.session_id) throw new Error("native_judge_owned_session_unavailable");
                  for (let reads = 0; reads < 400; reads++) {
                    const reply = await call("session", { action: "messages", session_ref: session });
                    if (reply.session_ref !== session) throw new Error("native_judge_message_session_mismatch");
                    const messages = object(reply.page).messages;
                    if (!Array.isArray(messages)) throw new Error("native_judge_messages_unavailable");
                    const assistant = messages.filter(message => message?.role === "assistant").at(-1);
                    // Prompt admission is not native completion. Normalized .text also
                    // contains thinking parts, so only a stopped assistant's text parts
                    // may become the verdict, after a fresh read confirms native idle.
                    if (assistant?.phase === "stop") {
                      const listed = await call("sessions", { action: "list", instance_ref: options.instanceRef });
                      if (!Array.isArray(listed.sessions)) throw new Error("native_judge_sessions_unavailable");
                      const matches = listed.sessions.filter(row => row?.session_ref === session);
                      if (matches.length > 1) throw new Error("native_judge_session_ambiguous");
                      const row = matches[0];
                      if (row?.native) {
                        const native = object(row.native), address = object(row.address);
                        if (object(address.instance).instance_id !== options.instanceRef
                          || native.harness !== "opencode" || typeof native.id !== "string"
                          || native.id !== address.native_session_id || native.id === original.hook.session_id)
                          throw new Error("native_judge_session_mismatch");
                        if (native.status === "idle") {
                          nativeTerminal = true;
                          const text = Array.isArray(assistant.parts) ? assistant.parts
                            .filter((part: ObjectValue) => part?.type === "text" && typeof part.text === "string")
                            .map((part: ObjectValue) => part.text).join("\n") : "";
                          if (!text.trim()) throw new Error("native_judge_final_text_unavailable");
                          if (text.length > 16_384) throw new Error("native_judge_output_too_large");
                          return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { headers: { "content-type": "application/json" } });
                        }
                      }
                    }
                    await delay(Math.min(poll, Math.max(1, deadline - Date.now())));
                  }
                  throw new Error("native_judge_read_budget_exhausted");
                } finally {
                  // A completed create/prompt task does not permit archiving a running
                  // or UNKNOWN native turn. Retain its receipt for reconciliation.
                  if (session && session !== original.hook.session_id && nativeTerminal && !controller.signal.aborted) {
                    const archived = await call("session", { action: "archive", session_ref: session, request_key: `${key}:archive` });
                    if (archived.archived !== true) throw new Error("native_judge_archive_unconfirmed");
                  }
                }
              },
            });
            return await judge.decide(input); // Existing JSON parser + normalizeDecision validation.
          } catch { throw new Error(`native_judge_failed_or_unknown ${JSON.stringify(receipt)}`); }
          finally { clearTimeout(timer); }
        } });
      const deadline = Date.now() + timeout;
      while (Date.now() <= deadline) {
        const current = options.jobs.get(job.id);
        if (current?.state === "completed") return current.result;
        if (!current || ["failed", "interrupted", "cancelled"].includes(current.state)) throw new Error("native_judge_failed_or_unknown");
        await delay(Math.min(25, timeout));
      }
      throw new Error("native_judge_failed_or_unknown");
    },
  };
}
