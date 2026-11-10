import { createHash, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { MacMiniChromeTransport, parseChromeEvaluation, type ChromePageTools } from "../adapters/mac-mini-chrome-transport.js";
import { parseZaiPages } from "../adapters/zai-cdp-driver.js";
import { verifyNewChatAccountScope } from "../adapters/browser-chat-new-page.js";
import { ZAI_AUTOPILOT_MODELS, type ZaiAutopilotModel } from "./zai-failover.js";

export const ZAI_BROWSER_JUDGE_BASE_URL = "https://chat.z.ai/autopilot";
const HARD_PROMPT_BYTES = 512 * 1024;
const WEB_MODELS: Record<ZaiAutopilotModel, string> = {
  "glm-5.3": "GLM-5.3", "glm-5.2": "GLM-5.2", "glm-5.3-flash": "GLM-5.3-Flash",
};
type Guard = () => boolean | Promise<boolean>;
export type ZaiBrowserJudgeAttempt = {
  model: ZaiAutopilotModel; prompt: string; signal: AbortSignal; shouldContinue?: Guard;
};
export type ZaiBrowserJudgeOutcome =
  | { kind: "answer"; text: string; userMessageId: string; assistantMessageId: string }
  | { kind: "busy" | "model_unavailable" | "quota" };
/** A slot is an owned inference tab, never a user's ChatGPT/Z.AI conversation. */
export interface ZaiBrowserJudgeSlot {
  infer(input: ZaiBrowserJudgeAttempt): Promise<ZaiBrowserJudgeOutcome>;
  close(): Promise<void>;
  isQuarantined?(): boolean;
}
export type ZaiBrowserJudgeFetchOptions = {
  accountScope: string;
  tools?: ChromePageTools;
  maxPromptBytes?: number;
  responseTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Injection seam for isolated deterministic tests; production uses owned browser slots. */
  createSlot?: (model: ZaiAutopilotModel, index: number) => ZaiBrowserJudgeSlot;
};
export class ZaiBrowserJudgeError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ZaiBrowserJudgeError"; }
}
function abort(): Error { return new DOMException("Z.AI browser inference cancelled", "AbortError"); }
async function active(input: Pick<ZaiBrowserJudgeAttempt, "signal" | "shouldContinue">): Promise<void> {
  if (input.signal.aborted) throw abort();
  if (input.shouldContinue && !await input.shouldContinue()) throw abort();
  if (input.signal.aborted) throw abort();
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abort());
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(abort()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function overloaded(): Response {
  return json(503, { error: { code: "1305", message: "The owned Z.AI inference slot is busy." } });
}
function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new ZaiBrowserJudgeError("zai_browser_invalid_budget");
  return n;
}

/** Fetch-compatible inference transport. It never fetches the synthetic endpoint.
 * Three independent fixed-model slots let another target try the next model when
 * its first slot is busy. Only proven no-inference busy results become HTTP 503.
 * A lost acknowledgement after a click remains UNKNOWN and is never replayed. */
export function createZaiBrowserJudgeFetch(options: ZaiBrowserJudgeFetchOptions) {
  if (!/^[a-f0-9]{64}$/u.test(options.accountScope)) throw new ZaiBrowserJudgeError("zai_browser_account_scope_required");
  const maxPromptBytes = boundedInteger(options.maxPromptBytes, HARD_PROMPT_BYTES, 1024, HARD_PROMPT_BYTES);
  const timeoutMs = boundedInteger(options.responseTimeoutMs, 180_000, 1000, 600_000);
  const pollMs = boundedInteger(options.pollIntervalMs, 2500, 100, 30_000);
  const tools = options.tools ?? (options.createSlot ? undefined : new MacMiniChromeTransport());
  const shutdown = new AbortController();
  const slots = ZAI_AUTOPILOT_MODELS.map((model, index) => ({
    model, busy: false,
    port: options.createSlot?.(model, index) ?? new OwnedZaiJudgeSlot(tools!, options.accountScope, pollMs),
  }));
  let closed = false;
  const calls = new Set<Promise<unknown>>();
  const unresolvedRequests = new Set<string>();
  const withGuard = (shouldContinue?: Guard): typeof fetch => (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (closed) throw new ZaiBrowserJudgeError("zai_browser_pool_closed");
    const endpoint = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (endpoint !== ZAI_BROWSER_JUDGE_BASE_URL + "/chat/completions" || init?.method !== "POST" || typeof init.body !== "string")
      throw new ZaiBrowserJudgeError("zai_browser_invalid_inference_request");
    let body: Record<string, unknown>;
    try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { throw new ZaiBrowserJudgeError("zai_browser_invalid_inference_request"); }
    const slot = slots.find(item => item.model === body.model);
    if (!slot || !Array.isArray(body.messages) || body.messages.length !== 2)
      throw new ZaiBrowserJudgeError("zai_browser_invalid_inference_request");
    const messages = body.messages as Array<Record<string, unknown>>;
    if (messages[0]?.role !== "system" || messages[1]?.role !== "user"
      || messages.some(message => typeof message.content !== "string" || !message.content.trim()))
      throw new ZaiBrowserJudgeError("zai_browser_invalid_inference_request");
    // Identity is calculated before adding this attempt's unique browser receipt.
    const requestHash = createHash("sha256").update(JSON.stringify(messages)).digest("hex");
    if (unresolvedRequests.has(requestHash)) throw new ZaiBrowserJudgeError("zai_browser_request_requires_reconciliation");
    if (slots.every(item => item.port.isQuarantined?.() === true))
      throw new ZaiBrowserJudgeError("zai_browser_pool_requires_reconciliation");
    const prompt = "SYSTEM INSTRUCTIONS\n" + messages[0]!.content + "\n\nINPUT DATA\n" + messages[1]!.content
      + "\n\nReturn only the requested JSON decision.\nInference receipt: " + randomUUID();
    if (Buffer.byteLength(prompt, "utf8") > maxPromptBytes)
      throw new ZaiBrowserJudgeError("zai_browser_prompt_too_large");
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeoutMs), ...(init.signal ? [init.signal] : [])]);
    const context = { signal, shouldContinue };
    await active(context);
    if (slot.busy || slot.port.isQuarantined?.() === true) return overloaded();
    slot.busy = true;
    const work = (async () => {
      try {
        const result = await slot.port.infer({ ...context, model: slot.model, prompt });
        await active(context);
        if (result.kind === "busy") return overloaded();
        if (result.kind === "model_unavailable")
          return json(404, { error: { code: "model_not_supported", message: "The requested model is not in the verified live picker." } });
        if (result.kind === "quota")
          return json(403, { error: { code: "usage_limit", message: "Z.AI browser usage limit reached; owner action is required." } });
        if (result.kind !== "answer") throw new ZaiBrowserJudgeError("zai_browser_response_kind_invalid");
        if (!result.text.trim() || !result.userMessageId || !result.assistantMessageId || result.userMessageId === result.assistantMessageId)
          throw new ZaiBrowserJudgeError("zai_browser_response_correlation_unavailable");
        return json(200, { choices: [{ message: { role: "assistant", content: result.text }, finish_reason: "stop" }] });
      } catch (error) {
        // The original ambiguous inference is never resubmitted, including on
        // another model. Other targets can still use the healthy owned slots.
        if (slot.port.isQuarantined?.() === true || !(error instanceof ZaiBrowserJudgeError)
          && (error as { name?: string })?.name !== "AbortError") unresolvedRequests.add(requestHash);
        throw error;
      } finally { slot.busy = false; }
    })();
    calls.add(work);
    try { return await work; } finally { calls.delete(work); }
  }) as typeof fetch;
  return {
    fetchImpl: withGuard(),
    withGuard,
    async close() {
      if (closed) return;
      closed = true; shutdown.abort();
      await Promise.allSettled([...calls]);
      await Promise.allSettled(slots.map(slot => slot.port.close()));
    },
  };
}

type PageOperation = {
  step: "claim" | "state" | "model" | "fill" | "click" | "read" | "clear";
  owner: string; path: string; model: string; scope: string; prompt?: string; promptHash?: string;
  /** True only for the exact new ID named by a successful new_page receipt. */
  acknowledgedNewPage?: boolean;
};
type PageResult = {
  ok?: boolean; reason?: string; path?: string; phase?: string; draft?: boolean;
  kind?: "busy" | "model_unavailable" | "quota"; userMessageId?: string; assistantMessageId?: string; text?: string;
};
/** Serialized only into an already owned page. It has no module-scope dependencies. */
async function pageOperation(p: PageOperation): Promise<PageResult> {
  const page = globalThis as any, doc = page.document;
  const visible = (e: any) => !!e && e.getClientRects().length > 0;
  const ownerName = "agent-herder-zai-judge:" + p.owner;
  if (page.location.origin !== "https://chat.z.ai") return { ok: false, reason: "origin_changed" };
  const url = new URL(page.location.href);
  const rootIdentity = url.searchParams.get("agent-herder-zai-judge") === p.owner
    || p.acknowledgedNewPage === true && url.search === "" && url.hash === "";
  if (p.step === "claim") {
    if (page.location.pathname !== "/" || !rootIdentity)
      return { ok: false, reason: "new_page_identity_unverified" };
    if (page.name && page.name !== ownerName) return { ok: false, reason: "page_already_owned" };
    // Z.AI removes query parameters while hydrating a newly allocated page.
    // A successful exact-ID receipt is ownership evidence, but never permission
    // to claim a page that has acquired a conversation, draft, or generation.
    const blankEditor = doc.querySelector('textarea[placeholder="Send a Message"]');
    const blankSend = doc.querySelector("#send-message-button");
    const active = [...doc.querySelectorAll("button")].some((button: any) => visible(button)
      && !!button.querySelector(":scope > span.block.size-3.rounded-xs.bg-text-inverted"));
    if (!visible(blankEditor) || !visible(blankSend) || blankEditor.value || active)
      return { ok: false, reason: "new_page_not_blank" };
    page.name = ownerName;
  }
  if (page.name !== ownerName) return { ok: false, reason: "page_owner_changed" };
  if (page.location.pathname !== p.path || p.path === "/" && !rootIdentity)
    return { ok: false, reason: "target_changed", path: page.location.pathname };
  const controls = () => [...doc.querySelectorAll("button")].filter(visible);
  const generating = () => controls().some((button: any) =>
    !!button.querySelector(":scope > span.block.size-3.rounded-xs.bg-text-inverted"));
  const editor = () => doc.querySelector('textarea[placeholder="Send a Message"]');
  const send = () => doc.querySelector("#send-message-button");
  const picker = () => [...doc.querySelectorAll('button[aria-label="Select a model"]')].filter(visible);
  const security = [...doc.querySelectorAll("body *")].some((e: any) => visible(e) && e.children.length === 0
    && /please complete security verification|please drag the slider to complete the puzzle/i.test(e.textContent || ""));
  if (security) return { ok: false, reason: "security_verification" };
  const alerts = [...doc.querySelectorAll('[role="alert"],[class*="border-red-600"],[class*="bg-red-600"]')]
    .filter(visible).map((e: any) => e.innerText || e.textContent || "").join("\n");
  const errorKind = /usage (?:cap|limit)|quota (?:exceeded|exhausted)|insufficient balance|лимит.{0,25}исчерпан/i.test(alerts) ? "quota"
    : /current concurrent conversation limit has been reached|too many requests|rate limit|currently (?:busy|overloaded)|high demand|overloaded/i.test(alerts) ? "busy" : undefined;
  const ready = () => visible(editor()) && visible(send());
  const safe = () => page.name === ownerName && page.location.origin === "https://chat.z.ai"
    && page.location.pathname === p.path && ready() && !generating();
  if (p.step === "claim" || p.step === "state")
    return { ok: true, path: page.location.pathname, phase: generating() ? "generating" : ready() ? "idle" : "unknown",
      draft: !!editor()?.value, ...(errorKind ? { kind: errorKind } : {}) };
  if (p.step === "model") {
    if (!safe() || editor().value) return { ok: false, kind: "busy", reason: "target_not_idle" };
    if (errorKind) return { ok: false, kind: errorKind };
    const buttons = picker();
    if (buttons.length !== 1) return { ok: false, reason: "picker_unavailable" };
    const button = buttons[0];
    const wasOpen = button.getAttribute("data-state") === "open";
    if (!wasOpen) button.click();
    try {
      await new Promise(resolve => page.setTimeout(resolve, 160));
      if (page.name !== ownerName || page.location.origin !== "https://chat.z.ai" || page.location.pathname !== p.path)
        return { ok: false, reason: "target_changed" };
      if (!safe() || editor().value) return { ok: false, kind: "busy", reason: "target_not_idle" };
      const matches = [...doc.querySelectorAll('[role="menu"][data-state="open"] button')].filter(visible)
        .filter((item: any) => (item.textContent || "").trim() === p.model);
      if (matches.length !== 1) return { ok: false, kind: "model_unavailable" };
      if ((button.textContent || "").trim() !== p.model) matches[0].click();
      await new Promise(resolve => page.setTimeout(resolve, 180));
      return safe() && !editor().value && (button.textContent || "").trim() === p.model
        ? { ok: true } : { ok: false, reason: "model_readback_unconfirmed" };
    } finally {
      if (!wasOpen && page.name === ownerName && page.location.pathname === p.path
        && button.getAttribute("data-state") === "open") button.click();
    }
  }
  if (p.step === "clear") {
    if (!safe() || editor().value !== p.prompt) return { ok: false, reason: "draft_changed" };
    const setter = Object.getOwnPropertyDescriptor(page.HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) return { ok: false, reason: "composer_unavailable" };
    setter.call(editor(), ""); editor().dispatchEvent(new page.Event("input", { bubbles: true }));
    return { ok: editor().value === "" };
  }
  if (p.step === "fill") {
    if (!safe() || editor().value) return { ok: false, kind: "busy", reason: "target_not_idle" };
    if (picker().length !== 1 || (picker()[0].textContent || "").trim() !== p.model)
      return { ok: false, reason: "model_changed" };
    const setter = Object.getOwnPropertyDescriptor(page.HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter || typeof p.prompt !== "string") return { ok: false, reason: "composer_unavailable" };
    setter.call(editor(), p.prompt);
    editor().dispatchEvent(new page.Event("input", { bubbles: true }));
    editor().dispatchEvent(new page.Event("change", { bubbles: true }));
    return { ok: editor().value === p.prompt };
  }
  if (p.step === "click") {
    if (editor()?.value !== p.prompt) return { ok: false, reason: "draft_changed" };
    if (picker().length !== 1 || (picker()[0].textContent || "").trim() !== p.model)
      return { ok: false, reason: "model_changed" };
    if (!safe() || send().disabled) return { ok: false, kind: "busy", reason: "pre_click_busy" };
    // All target/model/draft/Stop checks and the sole Send click share one task.
    send().click();
    return { ok: true };
  }
  if (p.step !== "read") return { ok: false, reason: "unsupported_step" };
  // Visible post-click alerts can belong to a sidebar/history request.
  // They never prove that this inference was rejected; read its native run.
  const chatId = p.path.match(/^\/c\/([a-f0-9-]{12,80})$/i)?.[1];
  if (!chatId) return { ok: false, reason: "route_pending" };
  const controller = new page.AbortController(), timer = page.setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await page.fetch("/api/v1/chats/" + encodeURIComponent(chatId),
      { credentials: "same-origin", signal: controller.signal });
    if (!response.ok) return { ok: false, reason: "history_unavailable" };
    const chat = await response.json();
    if (chat.id !== chatId || !chat.user_id) return { ok: false, reason: "history_identity_mismatch" };
    const digest = async (text: string) => [...new Uint8Array(await page.crypto.subtle.digest("SHA-256", new page.TextEncoder().encode(text)))]
      .map((n: number) => n.toString(16).padStart(2, "0")).join("");
    if (await digest(String(chat.user_id)) !== p.scope) return { ok: false, reason: "account_changed" };
    const mapping = chat.chat?.history?.messages;
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return { ok: false, reason: "history_pending" };
    const ids = Object.keys(mapping);
    if (!ids.length) return { ok: false, reason: "history_pending" };
    if (ids.length > 32) return { ok: false, reason: "unexpected_conversation_history" };
    const batch = await page.fetch("/api/v1/chats/" + encodeURIComponent(chatId) + "/messages/batch", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }), signal: controller.signal,
    });
    if (!batch.ok) return { ok: false, reason: "history_unavailable" };
    const result = await batch.json();
    if (result.chat_id !== chatId || !result.data || ids.some(id => result.data[id]?.id !== id))
      return { ok: false, reason: "history_identity_mismatch" };
    const all = ids.map(id => result.data[id]);
    const text = (m: any) => typeof m.content === "string" ? m.content : (Array.isArray(m.content_blocks) ? m.content_blocks : [])
      .filter((block: any) => block.type === "text" || block.type === "markdown")
      .map((block: any) => typeof block.content === "string" ? block.content : "").join("\n");
    const users = all.filter(m => m.role === "user");
    if (users.length !== 1 || await digest(text(users[0])) !== p.promptHash)
      return { ok: false, reason: "prompt_correlation_mismatch" };
    const assistants = all.filter(m => m.role === "assistant");
    const run = chat.last_run;
    const runStatus = typeof run?.status === "string" ? run.status : undefined;
    // This newly created chat contains exactly our one unique prompt. A typed
    // failed native run is distinct from an unrelated visible rate-limit toast.
    if (["failed", "error", "rejected"].includes(runStatus ?? "")) {
      if (!safe()) return { ok: false, reason: "response_pending", userMessageId: users[0].id };
      const code = typeof run?.error?.code === "string" || typeof run?.error?.code === "number" ? String(run.error.code) : "";
      if (["1113", "1308", "1310", "1316", "1317", "1318", "1319", "1320", "1321", "quota_exceeded", "insufficient_quota"].includes(code))
        return { ok: false, kind: "quota", userMessageId: users[0].id };
      if (["1302", "1305", "rate_limit_exceeded", "overloaded", "concurrent_conversation_limit"].includes(code))
        return { ok: false, kind: "busy", userMessageId: users[0].id };
      if (["model_not_found", "model_not_supported", "unsupported_model", "invalid_model"].includes(code))
        return { ok: false, kind: "model_unavailable", userMessageId: users[0].id };
      return { ok: false, reason: "native_run_rejection_unclassified", userMessageId: users[0].id };
    }
    if (assistants.length !== 1) return { ok: false, reason: assistants.length ? "ambiguous_assistant" : "response_pending", userMessageId: users[0].id };
    const assistant = assistants[0], answer = text(assistant);
    const parent = assistant.parentId ?? assistant.parent_id ?? mapping[assistant.id]?.parentId ?? mapping[assistant.id]?.parent_id;
    if (parent && parent !== users[0].id) return { ok: false, reason: "assistant_parent_mismatch" };
    if (typeof assistant.model === "string" && assistant.model.toLowerCase() !== p.model.toLowerCase())
      return { ok: false, reason: "assistant_model_mismatch" };
    const completed = assistant.done === true || ["completed", "done", "success", "succeeded"].includes(runStatus ?? "");
    if (!safe() || !completed || assistant.done === false
      || runStatus !== undefined && !["completed", "done", "success", "succeeded"].includes(runStatus))
      return { ok: false, reason: "response_pending", userMessageId: users[0].id };
    if (!answer.trim()) return { ok: false, reason: "response_pending", userMessageId: users[0].id };
    if (new page.TextEncoder().encode(answer).length > 64 * 1024) return { ok: false, reason: "answer_too_large" };
    return { ok: true, userMessageId: users[0].id, assistantMessageId: assistant.id, text: answer };
  } finally { page.clearTimeout(timer); }
}

export function zaiBrowserJudgePageScript(input: PageOperation): string {
  return "async () => await (" + pageOperation.toString() + ")(" + JSON.stringify(input) + ")";
}

class OwnedZaiJudgeSlot implements ZaiBrowserJudgeSlot {
  private readonly owner = randomUUID();
  private pageId?: number;
  private acknowledgedNewPage = false;
  private path = "/";
  private quarantined = false;
  private reusable = false;
  private lastPrompt?: string;
  constructor(private readonly tools: ChromePageTools, private readonly scope: string, private readonly pollMs: number) {}
  private async operation(input: ZaiBrowserJudgeAttempt, step: PageOperation["step"], extra: Partial<PageOperation> = {}): Promise<PageResult> {
    await active(input);
    const result = parseChromeEvaluation<PageResult>(await this.tools.call("evaluate_script", { pageId: this.pageId,
      function: zaiBrowserJudgePageScript({ step, owner: this.owner, path: this.path, model: WEB_MODELS[input.model], scope: this.scope, acknowledgedNewPage: this.acknowledgedNewPage, ...extra }) }));
    await active(input);
    return result;
  }
  private require(result: PageResult): void {
    if (!result.ok) throw new ZaiBrowserJudgeError("zai_browser_" + (result.reason ?? "page_unavailable"));
  }
  private async prepare(input: ZaiBrowserJudgeAttempt): Promise<PageResult> {
    await active(input);
    if (this.quarantined) throw new ZaiBrowserJudgeError("zai_browser_slot_requires_reconciliation");
    if (this.pageId === undefined) {
      const before = new Set((await this.tools.call("list_pages")).split("\n").flatMap(line => {
        const match = line.match(/^\s*(\d+):/u);
        return match ? [Number(match[1])] : [];
      }));
      await active(input);
      const url = "https://chat.z.ai/?agent-herder-zai-judge=" + this.owner;
      // Exactly one allocation. Prefer the exact ID in a successful Vibe
      // receipt: the site can remove our URL query during initial hydration.
      let acknowledgedId: number | undefined;
      try {
        const receipt = await this.tools.call("new_page", { url, background: true, timeout: 12_000 });
        const match = receipt.match(/^Successfully created new background page \(ID: (\d+)\)(?:[,!.]|\s|$)/u);
        if (match) {
          const id = Number(match[1]);
          if (!Number.isSafeInteger(id) || id < 1) throw new ZaiBrowserJudgeError("zai_browser_new_page_identity_unverified");
          acknowledgedId = id;
        }
      } catch { /* A missing acknowledgement requires the original exact nonce. */ }
      await active(input);
      const listing = parseZaiPages(await this.tools.call("list_pages"));
      const pages = acknowledgedId !== undefined
        ? listing.filter(page => page.id === acknowledgedId && !before.has(page.id) && new URL(page.url).pathname === "/")
        : listing.filter(page => !before.has(page.id) && new URL(page.url).pathname === "/"
          && new URL(page.url).searchParams.get("agent-herder-zai-judge") === this.owner);
      if (pages.length !== 1) throw new ZaiBrowserJudgeError("zai_browser_new_page_identity_unverified");
      this.pageId = pages[0]!.id; this.path = "/";
      this.acknowledgedNewPage = acknowledgedId === this.pageId;
      this.require(await this.operation(input, "claim"));
    } else {
      const state = await this.operation(input, "state"); this.require(state);
      if (state.phase !== "idle") return { kind: "busy" };
      if (state.draft) {
        if (!this.reusable || !this.lastPrompt) return { kind: "busy" };
        this.require(await this.operation(input, "clear", { prompt: this.lastPrompt }));
      }
      if (state.kind === "quota") return state;
      if (this.path !== "/" || state.kind === "busy" && this.reusable) {
        if (!this.reusable) throw new ZaiBrowserJudgeError("zai_browser_slot_requires_reconciliation");
        await active(input);
        await this.tools.call("navigate_page", { pageId: this.pageId, type: "url", url: "https://chat.z.ai/?agent-herder-zai-judge=" + this.owner });
        this.path = "/";
        this.require(await this.operation(input, "claim"));
      }
    }
    if (await verifyNewChatAccountScope(this.tools, "zai", this.pageId) !== this.scope)
      throw new ZaiBrowserJudgeError("zai_browser_account_changed");
    await active(input);
    const state = await this.operation(input, "state"); this.require(state);
    if (state.phase !== "idle" || state.draft) return { kind: "busy" };
    if (state.kind) return state;
    return this.operation(input, "model");
  }
  async infer(input: ZaiBrowserJudgeAttempt): Promise<ZaiBrowserJudgeOutcome> {
    let clicked = false, changedDraft = false;
    try {
      const preparation = await this.prepare(input);
      if (preparation.kind) return { kind: preparation.kind };
      this.require(preparation);
      const filled = await this.operation(input, "fill", { prompt: input.prompt });
      if (filled.kind) return { kind: filled.kind };
      this.require(filled); changedDraft = true;
      // Account identity is rechecked after fill and directly before admission.
      if (await verifyNewChatAccountScope(this.tools, "zai", this.pageId!) !== this.scope)
        throw new ZaiBrowserJudgeError("zai_browser_account_changed");
      await active(input);
      this.lastPrompt = input.prompt; this.reusable = false;
      clicked = true; // A lost acknowledgement may have followed the sole click.
      const submission = await this.operation(input, "click", { prompt: input.prompt });
      if (!submission.ok) {
        clicked = false;
        if (submission.kind) { this.quarantined = true; return { kind: submission.kind }; }
        this.require(submission);
      }
      const promptHash = createHash("sha256").update(input.prompt).digest("hex");
      let stable = "";
      for (;;) {
        await active(input);
        // Only this already allocated exact page may transition from our blank
        // route to its first native chat. Existing/foreign conversations are not adopted.
        const pages = parseZaiPages(await this.tools.call("list_pages"));
        const current = pages.find(page => page.id === this.pageId);
        if (!current) throw new ZaiBrowserJudgeError("zai_browser_owned_page_missing");
        const path = new URL(current.url).pathname;
        if (this.path === "/" && /^\/c\/[a-f0-9-]{12,80}$/iu.test(path)) this.path = path;
        else if (path !== this.path) throw new ZaiBrowserJudgeError("zai_browser_target_changed");
        const read = await this.operation(input, "read", { promptHash });
        if (read.kind) {
          if (await verifyNewChatAccountScope(this.tools, "zai", this.pageId!) !== this.scope)
            throw new ZaiBrowserJudgeError("zai_browser_account_changed");
          await active(input);
          this.reusable = true; return { kind: read.kind };
        }
        if (read.ok && read.text && read.userMessageId && read.assistantMessageId) {
          const observation = JSON.stringify([read.userMessageId, read.assistantMessageId, read.text]);
          if (stable === observation) { this.reusable = true; return { kind: "answer", text: read.text, userMessageId: read.userMessageId, assistantMessageId: read.assistantMessageId }; }
          stable = observation;
        } else {
          stable = "";
          if (!["route_pending", "history_pending", "history_unavailable", "response_pending"].includes(read.reason ?? ""))
            throw new ZaiBrowserJudgeError("zai_browser_" + (read.reason ?? "response_unavailable"));
        }
        await wait(this.pollMs, input.signal);
      }
    } catch (error) {
      if (clicked || changedDraft || (error instanceof ZaiBrowserJudgeError
        && /account_changed|target_changed|owner_changed|identity_unverified|already_owned|model_changed|draft_changed/u.test(error.code))) this.quarantined = true;
      throw error;
    }
  }
  isQuarantined(): boolean { return this.quarantined; }
  async close(): Promise<void> {
    // UNKNOWN or foreign navigation is a reconciliation problem, not cleanup.
    if (this.pageId === undefined || this.quarantined) return;
    try {
      const result = parseChromeEvaluation<PageResult>(await this.tools.call("evaluate_script", { pageId: this.pageId,
        function: zaiBrowserJudgePageScript({ step: "state", owner: this.owner, path: this.path, model: "", scope: this.scope, acknowledgedNewPage: this.acknowledgedNewPage }) }));
      if (result.ok && result.phase === "idle" && !result.draft) await this.tools.call("close_page", { pageId: this.pageId });
    } catch { /* Leave an unverified page untouched. */ }
  }
}
