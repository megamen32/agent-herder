import { createHash, webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createZaiBrowserJudgeFetch, ZAI_BROWSER_JUDGE_BASE_URL, zaiBrowserJudgePageScript, type ZaiBrowserJudgeSlot } from "../src/autopilot/zai-browser-judge.js";
import { runZaiModelCycle } from "../src/autopilot/zai-failover.js";
import { JudgeRequestTrace } from "../src/autopilot/judge-request.js";

const scope = createHash("sha256").update("account").digest("hex");
const endpoint = ZAI_BROWSER_JUDGE_BASE_URL + "/chat/completions";
const body = (model = "glm-5.3", text = "latest human request and complete assistant answer") => ({
  method: "POST",
  body: JSON.stringify({ model, messages: [{ role: "system", content: "Return only JSON" }, { role: "user", content: text }] }),
});
const answer = () => ({ kind: "answer" as const, text: '{"kind":"done","summary":"Done"}', userMessageId: "u", assistantMessageId: "a" });
function factory(infer: ZaiBrowserJudgeSlot["infer"]) {
  const slots: ZaiBrowserJudgeSlot[] = [];
  const createSlot = () => {
    const slot = { infer: vi.fn(infer), close: vi.fn(async () => {}) };
    slots.push(slot); return slot;
  };
  return { slots, createSlot };
}
async function cycle(pool: ReturnType<typeof createZaiBrowserJudgeFetch>, text?: string) {
  return runZaiModelCycle({
    attempt: async model => {
      const trace = new JudgeRequestTrace({ model, endpoint, operation: "stop" });
      const response = await trace.fetch(pool.fetchImpl, endpoint, body(model, text));
      return response.json();
    },
    sleep: async () => {},
  });
}

describe("Z.AI browser judge fetch transport", () => {
  it("requires a protected account identity and rejects unexpected inference routes", async () => {
    expect(() => createZaiBrowserJudgeFetch({ accountScope: "display name" })).toThrow("account_scope");
    const f = factory(async () => answer());
    const pool = createZaiBrowserJudgeFetch({ accountScope: scope, createSlot: f.createSlot });
    await expect(pool.fetchImpl("https://example.com/chat/completions", body())).rejects.toThrow("invalid_inference");
    await expect(pool.fetchImpl(endpoint, body("glm-4"))).rejects.toThrow("invalid_inference");
    expect(f.slots.every(slot => vi.mocked(slot.infer).mock.calls.length === 0)).toBe(true);
    await pool.close();
  });

  it("cycles through the exact three browser models and returns to the first", async () => {
    const attempts: string[] = [];
    const f = factory(async input => {
      attempts.push(input.model);
      return attempts.length < 4 ? { kind: "busy" } : answer();
    });
    const pool = createZaiBrowserJudgeFetch({ accountScope: scope, createSlot: f.createSlot });
    const result = await cycle(pool);
    expect(attempts).toEqual(["glm-5.3", "glm-5.2", "glm-5.3-flash", "glm-5.3"]);
    expect(result.choices[0].message.content).toContain('"kind":"done"');
    await pool.close();
  });

  it("does not queue an independent target behind an occupied model slot", async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const f = factory(async input => { if (input.model === "glm-5.3") await waiting; return answer(); });
    const pool = createZaiBrowserJudgeFetch({ accountScope: scope, createSlot: f.createSlot });
    const first = pool.fetchImpl(endpoint, body());
    await vi.waitFor(() => expect(vi.mocked(f.slots[0]!.infer)).toHaveBeenCalledTimes(1));
    expect((await pool.fetchImpl(endpoint, body())).status).toBe(503);
    expect((await pool.fetchImpl(endpoint, body("glm-5.2"))).status).toBe(200);
    expect(vi.mocked(f.slots[0]!.infer)).toHaveBeenCalledTimes(1);
    release(); expect((await first).status).toBe(200);
    await pool.close();
  });

  it("does not cycle or resend after a post-click UNKNOWN", async () => {
    const f = factory(async () => { throw new Error("click acknowledgement lost"); });
    const pool = createZaiBrowserJudgeFetch({ accountScope: scope, createSlot: f.createSlot });
    await expect(cycle(pool)).rejects.toMatchObject({ diagnostic: { kind: "network" } });
    expect(vi.mocked(f.slots[0]!.infer)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.slots[1]!.infer)).not.toHaveBeenCalled();
    await pool.close();
  });

  it("keeps an UNKNOWN request blocked while unrelated targets use a healthy model slot", async () => {
    let quarantined = false;
    const observed: string[] = [];
    const pool = createZaiBrowserJudgeFetch({ accountScope: scope, createSlot: model => ({
      infer: async input => {
        observed.push(input.model);
        if (model === "glm-5.3") { quarantined = true; throw new Error("lost post-click receipt"); }
        return answer();
      },
      isQuarantined: () => model === "glm-5.3" && quarantined,
      close: async () => {},
    }) });
    await expect(cycle(pool, "target A")).rejects.toMatchObject({ diagnostic: { kind: "network" } });
    await expect(pool.fetchImpl(endpoint, body("glm-5.2", "target A"))).rejects.toThrow("request_requires_reconciliation");
    expect((await cycle(pool, "target B")).choices[0].message.content).toContain("done");
    expect(observed).toEqual(["glm-5.3", "glm-5.2"]);
    await pool.close();
  });

  it("stops instead of cycling forever when every private slot requires reconciliation", async () => {
    const infer = vi.fn(async () => answer());
    const pool = createZaiBrowserJudgeFetch({ accountScope: scope, createSlot: () => ({
      infer, close: async () => {}, isQuarantined: () => true,
    }) });
    await expect(pool.fetchImpl(endpoint, body())).rejects.toThrow("pool_requires_reconciliation");
    expect(infer).not.toHaveBeenCalled();
    await pool.close();
  });

  it("keeps full long context and rejects an oversized complete prompt before browser use", async () => {
    let supplied = "";
    const f = factory(async input => { supplied = input.prompt; return answer(); });
    const pool = createZaiBrowserJudgeFetch({ accountScope: scope, createSlot: f.createSlot });
    const large = "USER_START\n" + "Ж".repeat(80_000) + "\nUSER_END\nASSISTANT_END";
    expect((await pool.fetchImpl(endpoint, body("glm-5.3", large))).status).toBe(200);
    expect(supplied).toContain(large);
    await expect(pool.fetchImpl(endpoint, body("glm-5.3", "Ж".repeat(262_144)))).rejects.toThrow("prompt_too_large");
    expect(vi.mocked(f.slots[0]!.infer)).toHaveBeenCalledTimes(1);
    await pool.close();
  });

  it("never converts a browser quota boundary into a transient busy retry", async () => {
    const f = factory(async () => ({ kind: "quota" }));
    const pool = createZaiBrowserJudgeFetch({ accountScope: scope, createSlot: f.createSlot });
    await expect(cycle(pool)).rejects.toMatchObject({ diagnostic: { kind: "access_denied", httpStatus: 403 } });
    expect(vi.mocked(f.slots[0]!.infer)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.slots[1]!.infer)).not.toHaveBeenCalled();
    await pool.close();
  });

  it("honors a withdrawn target guard before admission and after provider completion", async () => {
    let allowed = false;
    const f = factory(async () => { allowed = false; return answer(); });
    const pool = createZaiBrowserJudgeFetch({ accountScope: scope, createSlot: f.createSlot });
    const fetch = pool.withGuard(() => allowed);
    await expect(fetch(endpoint, body())).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.mocked(f.slots[0]!.infer)).not.toHaveBeenCalled();
    allowed = true;
    await expect(fetch(endpoint, body())).rejects.toMatchObject({ name: "AbortError" });
    await pool.close();
  });

  it("cancels active inference on shutdown and closes only the allocated slot ports", async () => {
    const f = factory(input => new Promise((_resolve, reject) => {
      input.signal.addEventListener("abort", () => reject(new DOMException("stop", "AbortError")), { once: true });
    }));
    const pool = createZaiBrowserJudgeFetch({ accountScope: scope, createSlot: f.createSlot });
    const running = pool.fetchImpl(endpoint, body());
    const rejected = expect(running).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(vi.mocked(f.slots[0]!.infer)).toHaveBeenCalledTimes(1));
    await pool.close(); await rejected;
    expect(f.slots.every(slot => vi.mocked(slot.close).mock.calls.length === 1)).toBe(true);
    await expect(pool.fetchImpl(endpoint, body())).rejects.toThrow("pool_closed");
  });

  it("uses a unique prompt receipt so an older identical inference cannot be accepted", async () => {
    const prompts: string[] = [];
    const f = factory(async input => { prompts.push(input.prompt); return answer(); });
    const pool = createZaiBrowserJudgeFetch({ accountScope: scope, createSlot: f.createSlot });
    await pool.fetchImpl(endpoint, body()); await pool.fetchImpl(endpoint, body());
    expect(prompts[0]).not.toEqual(prompts[1]);
    expect(prompts.every(text => text.includes("Inference receipt:"))).toBe(true);
    await pool.close();
  });
});

function browserFixture() {
  let generating = false, selectedModel = "GLM-5.3", clickCount = 0;
  let alerts = "";
  class Textarea {
    current = "";
    get value() { return this.current; }
    set value(value: string) { this.current = value; }
    getClientRects() { return [1]; }
    dispatchEvent() {}
  }
  const editor = new Textarea();
  const send = { disabled: false, getClientRects: () => [1], querySelector: () => null, click: () => { clickCount++; generating = true; } };
  const stop = { getClientRects: () => generating ? [1] : [], querySelector: () => ({}) };
  let open = false;
  const picker = { get textContent() { return selectedModel; }, getClientRects: () => [1],
    getAttribute: () => open ? "open" : "closed", click: () => { open = !open; }, querySelector: () => null };
  const options = ["GLM-5.3", "GLM-5.2", "GLM-5.3-Flash"].map(model => ({
    textContent: model, getClientRects: () => [1], click: () => { selectedModel = model; open = false; },
  }));
  const doc = {
    querySelector: (selector: string) => selector.includes("textarea") ? editor : selector === "#send-message-button" ? send : null,
    querySelectorAll: (selector: string) => {
      if (selector === "button") return [send, stop, picker];
      if (selector.includes('aria-label="Select a model"')) return [picker];
      if (selector.includes('[role="menu"]')) return open ? options : [];
      if (selector.includes('[role="alert"]')) return alerts ? [{ getClientRects: () => [1], textContent: alerts }] : [];
      return [];
    },
  };
  const owner = "test-owner", chatId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const location = { origin: "https://chat.z.ai", pathname: "/", href: "https://chat.z.ai/?agent-herder-zai-judge=" + owner };
  const window: any = {
    document: doc, location, name: "agent-herder-zai-judge:" + owner, HTMLTextAreaElement: Textarea, Event: class {},
    setTimeout: (fn: () => void) => { fn(); return 1; }, clearTimeout: () => {}, crypto: webcrypto, TextEncoder, AbortController,
  };
  const execute = (step: "claim" | "state" | "model" | "fill" | "click" | "read" | "clear", extra: Record<string, unknown> = {}) => {
    const script = zaiBrowserJudgePageScript({ step, owner, path: location.pathname, model: "GLM-5.3", scope, ...extra });
    return runInNewContext("(" + script + ")()", { globalThis: window, URL, Uint8Array, Object, Promise });
  };
  const history = (prompt: string, overrides: Record<string, unknown> = {}, run: Record<string, unknown> | null = { status: "completed" }) => {
    location.pathname = "/c/" + chatId; location.href = location.origin + location.pathname;
    const user = { id: "u", role: "user", content: prompt };
    const assistant = { id: "a", role: "assistant", content: '{"kind":"done","summary":"complete"}', parentId: "u", done: true, ...overrides };
    window.fetch = async (url: string) => ({
      ok: true, json: async () => url.endsWith("/messages/batch")
        ? { chat_id: chatId, data: { u: user, a: assistant } }
        : { id: chatId, user_id: "account", ...(run ? { last_run: run } : {}), chat: { history: { messages: { u: {}, a: {} } } } },
    });
  };
  return { execute, window, editor, location, history, clicks: () => clickCount,
    busy: (value: boolean) => { generating = value; }, alerts: (value: string) => { alerts = value; } };
}

describe("owned Z.AI page admission and native correlation", () => {
  it("selects the exact model before filling and clicking once", async () => {
    const f = browserFixture();
    expect(await f.execute("model", { model: "GLM-5.2" })).toEqual({ ok: true });
    expect(await f.execute("fill", { model: "GLM-5.2", prompt: "full context" })).toEqual({ ok: true });
    expect(await f.execute("click", { model: "GLM-5.2", prompt: "full context" })).toEqual({ ok: true });
    expect(f.clicks()).toBe(1);
    expect((await f.execute("click", { model: "GLM-5.2", prompt: "full context" })).ok).toBe(false);
    expect(f.clicks()).toBe(1);
  });

  it("preserves foreign drafts, changed owners and changed native paths", async () => {
    const f = browserFixture(); f.editor.value = "human draft";
    expect((await f.execute("fill", { prompt: "judge" })).ok).toBe(false);
    expect(f.editor.value).toBe("human draft");
    f.window.name = "foreign-owner";
    expect((await f.execute("click", { prompt: "human draft" })).reason).toBe("page_owner_changed");
    f.window.name = "agent-herder-zai-judge:test-owner";
    expect((await f.execute("click", { path: "/c/other", prompt: "human draft" })).reason).toBe("target_changed");
    expect(f.clicks()).toBe(0);
  });

  it("clears only its own exact rejected prompt and refuses a changed draft", async () => {
    const f = browserFixture(); f.editor.value = "own prompt";
    expect(await f.execute("clear", { prompt: "own prompt" })).toEqual({ ok: true });
    f.editor.value = "new human draft";
    expect((await f.execute("clear", { prompt: "own prompt" })).ok).toBe(false);
    expect(f.editor.value).toBe("new human draft");
  });

  it("accepts only the exact new user prompt and its completed assistant", async () => {
    const f = browserFixture(); f.history("full prompt with unique receipt");
    const promptHash = createHash("sha256").update("full prompt with unique receipt").digest("hex");
    const result = await f.execute("read", { promptHash });
    expect(result).toMatchObject({ ok: true, userMessageId: "u", assistantMessageId: "a" });
    expect((await f.execute("read", { promptHash: "0".repeat(64) })).reason).toBe("prompt_correlation_mismatch");
    expect((await f.execute("read", { promptHash, scope: "f".repeat(64) })).reason).toBe("account_changed");
  });

  it("rejects a different assistant parent and waits while generation continues", async () => {
    const f = browserFixture(); f.history("prompt", { parentId: "old-user" });
    const promptHash = createHash("sha256").update("prompt").digest("hex");
    expect((await f.execute("read", { promptHash })).reason).toBe("assistant_parent_mismatch");
    f.history("prompt"); f.busy(true);
    expect((await f.execute("read", { promptHash })).reason).toBe("response_pending");
  });

  it("requires positive native completion even when a partial JSON answer looks stable and idle", async () => {
    const f = browserFixture(); f.history("prompt", { done: undefined }, null);
    const promptHash = createHash("sha256").update("prompt").digest("hex");
    expect((await f.execute("read", { promptHash })).reason).toBe("response_pending");
    expect((await f.execute("read", { promptHash })).reason).toBe("response_pending");
    f.history("prompt", { done: true, model: "GLM-5.2" });
    expect((await f.execute("read", { promptHash })).reason).toBe("assistant_model_mismatch");
  });

  it("does not treat a sidebar rate-limit alert as rejection of the admitted inference", async () => {
    const f = browserFixture(); f.history("prompt", { done: undefined }, { status: "running" });
    const promptHash = createHash("sha256").update("prompt").digest("hex");
    f.alerts("Too many requests");
    const pending = await f.execute("read", { promptHash });
    expect(pending.reason).toBe("response_pending"); expect(pending.kind).toBeUndefined();
    f.history("prompt");
    expect((await f.execute("read", { promptHash })).ok).toBe(true);
  });

  it("retries only a correlated typed native capacity rejection and keeps quota terminal", async () => {
    const f = browserFixture(); f.history("prompt", { done: false }, { status: "failed", error: { code: "1305" } });
    const promptHash = createHash("sha256").update("prompt").digest("hex");
    expect((await f.execute("read", { promptHash })).kind).toBe("busy");
    expect((await f.execute("read", { promptHash: "f".repeat(64) })).kind).toBeUndefined();
    f.history("prompt", { done: false }, { status: "failed", error: { code: "1113" } });
    expect((await f.execute("read", { promptHash })).kind).toBe("quota");
    f.history("prompt", { done: false }, { status: "failed", error: { message: "too many requests" } });
    expect((await f.execute("read", { promptHash })).reason).toBe("native_run_rejection_unclassified");
  });
});

describe("concrete private-tab Z.AI transport", () => {
  function chrome(config: { stripQuery?: boolean; receipt?: "success" | "missing" | "unknown" | "existing"; draft?: string } = {}) {
    const pages = new Map<number, ReturnType<typeof browserFixture>>();
    let next = 10, newPages = 0, navigations = 0;
    const touched: number[] = [];
    const prompts: string[] = [];
    let interfere = false;
    const list = () => "9: User Z.AI (https://chat.z.ai/c/old-user-conversation)\n"
      + [...pages].map(([id, f]) => String(id) + ": Judge (" + f.location.href + ")").join("\n");
    const tools = {
      async call(name: string, args: Record<string, unknown> = {}) {
        if (name === "list_pages") return list();
        if (name === "new_page") {
          newPages++;
          const f = browserFixture(), url = new URL(String(args.url));
          if (config.stripQuery) url.search = "";
          f.window.name = ""; Object.assign(f.location, { origin: url.origin, pathname: url.pathname, href: url.href });
          if (config.draft) f.editor.value = config.draft;
          const created = next++; pages.set(created, f);
          if (config.receipt === "unknown") throw new Error("new_page response lost");
          if (config.receipt === "success") return "Successfully created new background page (ID: " + created + "), navigated to " + String(args.url);
          if (config.receipt === "existing") return "Successfully created new background page (ID: 9), navigated to " + String(args.url);
          return list();
        }
        const id = Number(args.pageId), f = pages.get(id);
        touched.push(id);
        if (!f) throw new Error("foreign page");
        if (name === "navigate_page") {
          navigations++;
          const url = new URL(String(args.url));
          if (config.stripQuery) url.search = "";
          Object.assign(f.location, { origin: url.origin, pathname: url.pathname, href: url.href });
          f.alerts(""); f.editor.value = ""; f.busy(false);
          return "navigated";
        }
        if (name === "close_page") { pages.delete(id); return "closed"; }
        if (name !== "evaluate_script") throw new Error("unexpected tool");
        const source = String(args.function);
        if (source.includes("__herderZaiHook")) return "\u0060\u0060\u0060json\n" + JSON.stringify({ scope, chats: [] }) + "\n\u0060\u0060\u0060";
        const result = await runInNewContext("(" + source + ")()", {
          globalThis: f.window, URL, Uint8Array, Object, Promise,
        });
        if (source.includes('"step":"model"') && result.ok && interfere)
          Object.assign(f.location, { pathname: "/c/other-existing-chat", href: "https://chat.z.ai/c/other-existing-chat" });
        if (source.includes('"step":"click"') && result.ok) {
          prompts.push(f.editor.value);
          f.history(f.editor.value); f.editor.value = ""; f.busy(false);
        }
        return "\u0060\u0060\u0060json\n" + JSON.stringify(result) + "\n\u0060\u0060\u0060";
      },
    };
    return { tools, touched, prompts, counts: () => ({ newPages, navigations }), interfere: () => { interfere = true; } };
  }

  it("allocates and reuses only its own tab after correlated completion", async () => {
    const c = chrome();
    const pool = createZaiBrowserJudgeFetch({ accountScope: scope, tools: c.tools, pollIntervalMs: 100 });
    expect((await pool.fetchImpl(endpoint, body())).status).toBe(200);
    expect((await pool.fetchImpl(endpoint, body())).status).toBe(200);
    expect(c.counts()).toEqual({ newPages: 1, navigations: 1 });
    expect(c.prompts).toHaveLength(2);
    expect(c.prompts[0]).not.toEqual(c.prompts[1]);
    expect(c.touched).not.toContain(9);
    await pool.close();
  });

  it("uses the exact successful new_page receipt when Z.AI removes the query during hydration", async () => {
    const c = chrome({ stripQuery: true, receipt: "success" });
    const pool = createZaiBrowserJudgeFetch({ accountScope: scope, tools: c.tools, pollIntervalMs: 100 });
    expect((await pool.fetchImpl(endpoint, body())).status).toBe(200);
    expect((await pool.fetchImpl(endpoint, body())).status).toBe(200);
    expect(c.counts()).toEqual({ newPages: 1, navigations: 1 });
    expect(c.prompts).toHaveLength(2); expect(c.touched).not.toContain(9);
    await pool.close();
  });

  it.each(["missing", "unknown"] as const)("does not adopt a query-stripped page after a %s creation receipt", async receipt => {
    const c = chrome({ stripQuery: true, receipt });
    const pool = createZaiBrowserJudgeFetch({ accountScope: scope, tools: c.tools, pollIntervalMs: 100 });
    await expect(pool.fetchImpl(endpoint, body())).rejects.toThrow("new_page_identity_unverified");
    expect(c.counts().newPages).toBe(1);
    expect(c.prompts).toEqual([]); expect(c.touched).toEqual([]);
    await pool.close();
  });

  it("rejects a receipt pointing at a preexisting page instead of substituting a new list difference", async () => {
    const c = chrome({ stripQuery: true, receipt: "existing" });
    const pool = createZaiBrowserJudgeFetch({ accountScope: scope, tools: c.tools, pollIntervalMs: 100 });
    await expect(pool.fetchImpl(endpoint, body())).rejects.toThrow("new_page_identity_unverified");
    expect(c.prompts).toEqual([]); expect(c.touched).toEqual([]);
    await pool.close();
  });

  it("includes non-Z.AI tabs in the preallocation ID fence", async () => {
    let listed = false;
    const evaluations = vi.fn();
    const tools = { async call(name: string) {
      if (name === "list_pages") {
        if (!listed) { listed = true; return "7: Human page (https://example.com/)"; }
        return "7: Z.AI (https://chat.z.ai/)";
      }
      if (name === "new_page") return "Successfully created new background page (ID: 7), navigated to https://chat.z.ai/";
      evaluations(); throw new Error("must not access an existing page");
    } };
    const pool = createZaiBrowserJudgeFetch({ accountScope: scope, tools, pollIntervalMs: 100 });
    await expect(pool.fetchImpl(endpoint, body())).rejects.toThrow("new_page_identity_unverified");
    expect(evaluations).not.toHaveBeenCalled(); await pool.close();
  });

  it("does not claim an acknowledged page that acquired a human draft", async () => {
    const c = chrome({ stripQuery: true, receipt: "success", draft: "human draft" });
    const pool = createZaiBrowserJudgeFetch({ accountScope: scope, tools: c.tools, pollIntervalMs: 100 });
    await expect(pool.fetchImpl(endpoint, body())).rejects.toThrow("new_page_not_blank");
    expect(c.prompts).toEqual([]); expect(c.touched).not.toContain(9);
    await pool.close();
  });

  it("quarantines foreign navigation between model selection and fill without clicking", async () => {
    const c = chrome(); c.interfere();
    const pool = createZaiBrowserJudgeFetch({ accountScope: scope, tools: c.tools, pollIntervalMs: 100 });
    await expect(pool.fetchImpl(endpoint, body())).rejects.toThrow("target_changed");
    expect(c.prompts).toEqual([]);
    await expect(pool.fetchImpl(endpoint, body())).rejects.toThrow("requires_reconciliation");
    expect(c.counts().newPages).toBe(1);
    await pool.close();
    expect(c.touched).not.toContain(9);
  });
});
