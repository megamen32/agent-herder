import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HerderJob } from "../src/herder-jobs.js";
import {
  DELIVERY_RESPONSE_MAX_TEXT_CHARS,
  captureDeliveryResponseBaseline,
  diffDeliveryResponse,
  readDeliveryResponseContinuation,
  validateDeliveryResponseBaseline,
  visibleHistoryText,
  waitForDeliveryResponse,
  nativeDeliveryResponseComplete,
  nativeDeliveryResponseCompleteByInput,
  type DeliveryResponseBaseline,
  type DeliveryResponseHistory,
  type DeliveryResponseTarget,
} from "../src/session-delivery-response.js";
import type { HarnessType, SendMessageResult, SessionMessageView } from "../src/types/index.js";

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const target = (harness: HarnessType = "codex"): DeliveryResponseTarget => ({ hostId: "host-a", harness, sessionId: "session-a" });
const message = (id: string, role: SessionMessageView["role"], text: string, turnId?: string): SessionMessageView => ({
  id,
  role,
  ...(turnId ? { turnId } : {}),
  text,
  parts: [{ type: "text", text }],
});
const completedJob = (jobId: string, turnId?: string): HerderJob<SendMessageResult> => ({
  id: jobId,
  kind: "delivery",
  state: "completed",
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:01.000Z",
  ownerSessionId: "session-a",
  resultRef: `herder://jobs/${jobId}`,
  result: { ok: true, admitted: true, inputId: "input-a", ...(turnId ? { turnId } : {}) },
});

let root: string;
let previousLongMessagesDirectory: string | undefined;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "herder-delivery-response-"));
  previousLongMessagesDirectory = process.env.AGENT_HERDER_LONG_MESSAGES_DIR;
  process.env.AGENT_HERDER_LONG_MESSAGES_DIR = join(root, "long-messages");
});
afterAll(() => {
  if (previousLongMessagesDirectory === undefined) delete process.env.AGENT_HERDER_LONG_MESSAGES_DIR;
  else process.env.AGENT_HERDER_LONG_MESSAGES_DIR = previousLongMessagesDirectory;
  rmSync(root, { recursive: true, force: true });
});

describe("session delivery response observer", () => {
  it("reads one asynchronous resource snapshot without polling or resending", async () => {
    const baseline = await captureDeliveryResponseBaseline({ jobId: "job-a", inputId: "input-a", target: target(),
      readMessages: async () => ({ messages: [], complete: true }) });
    let reads = 0;
    const result = await waitForDeliveryResponse({ jobId: "job-a", inputId: "input-a", target: target(), baseline,
      readJob: () => completedJob("job-a", "turn-a"), waitMs: 1_000, snapshotOnly: true,
      readHistory: async () => {
        reads++;
        await new Promise(resolve => setTimeout(resolve, 10));
        return { messages: [], turnComplete: false };
      },
      delay: async () => { throw new Error("snapshot must not poll"); },
    });
    expect(result).toMatchObject({ status: "pending" });
    expect(result.observationCancelled).not.toBe(true);
    expect(reads).toBe(1);
  });
  it("uses an exact native completed turn to finish an empty response without a resend", async () => {
    const job = completedJob("job-a", "turn-a");
    const session = { ...target(), id: "session-a", status: "idle", needsPermission: false,
      meta: { nativeLastTurn: { turnId: "turn-a", status: "completed", completedAt: "2026-10-25T00:00:01Z" } } };
    const baseline = await captureDeliveryResponseBaseline({
      jobId: "job-a", inputId: "input-a", target: target(),
      readMessages: async () => ({ messages: [message("user-old", "user", "old prompt")], complete: true }),
    });
    const result = await waitForDeliveryResponse({
      jobId: "job-a", inputId: "input-a", target: target(), baseline,
      readJob: () => job, waitMs: 0,
      readHistory: async () => ({ messages: [message("user-old", "user", "old prompt"), message("empty", "assistant", "", "turn-a")],
        turnComplete: nativeDeliveryResponseComplete(session as any, job) }),
    });
    expect(result).toMatchObject({ status: "completed", reason: "no_visible_response", text: "" });
    expect(nativeDeliveryResponseComplete({ ...session, meta: { nativeLastTurn: { ...session.meta.nativeLastTurn, turnId: "other-turn" } } } as any, job)).toBe(false);
    expect(nativeDeliveryResponseComplete({ ...session, status: "running" } as any, job)).toBe(false);
    expect(nativeDeliveryResponseComplete({ ...session, meta: {} } as any, job)).toBe(false);
    expect(nativeDeliveryResponseComplete(session as any, completedJob("job-a"))).toBe(false);
  });
  it("recovers only the exact native OpenCode input after a missing pre-send baseline",async()=>{
    const opencodeTarget=target("opencode");
    const job:HerderJob<SendMessageResult>={...completedJob("job-native-input"),result:{ok:true,admitted:true,inputId:"input-a",nativeInputMessageId:"msg-native-input"}};
    const baseline=await captureDeliveryResponseBaseline({jobId:job.id,inputId:"input-a",target:opencodeTarget,readMessages:async()=>({messages:null,complete:false})});
    const messages:SessionMessageView[]=[
      {id:"msg-native-input",role:"user",text:"bounded input",parts:[{type:"text",text:"bounded input"}]},
      {id:"msg-native-answer",role:"assistant",phase:"stop",text:"HF26_OK",parts:[{type:"text",text:"HF26_OK"}]},
    ];
    const session={id:"session-a",harness:"opencode",hostId:"host-a",status:"idle",needsPermission:false} as const;
    const complete=nativeDeliveryResponseCompleteByInput({target:opencodeTarget,inputId:"input-a",job,before:session,after:session,history:{messages,complete:false,inputTailComplete:true}});
    const result=await waitForDeliveryResponse({jobId:job.id,inputId:"input-a",target:opencodeTarget,baseline,readJob:()=>job,waitMs:0,
      readHistory:async()=>({messages,complete:false,inputTailComplete:true,turnComplete:complete})});
    expect(complete).toBe(true);
    expect(result).toMatchObject({status:"completed",correlation:"reply_to",text:"HF26_OK",totalTextLength:7,baselineCoverage:"unavailable"});
  });
  it("closes an exact empty OpenCode finish without replaying the input",async()=>{
    const opencodeTarget=target("opencode");
    const job:HerderJob<SendMessageResult>={...completedJob("job-empty-native"),result:{ok:true,admitted:true,inputId:"input-a",nativeInputMessageId:"msg-native-input"}};
    const baseline=await captureDeliveryResponseBaseline({jobId:job.id,inputId:"input-a",target:opencodeTarget,readMessages:async()=>({messages:null,complete:false})});
    const messages:SessionMessageView[]=[
      {id:"msg-native-input",role:"user",text:"bounded input",parts:[{type:"text",text:"bounded input"}]},
      {id:"msg-empty-final",role:"assistant",phase:"stop",parts:[]},
    ];
    const session={id:"session-a",harness:"opencode",hostId:"host-a",status:"idle",needsPermission:false} as const;
    const complete=nativeDeliveryResponseCompleteByInput({target:opencodeTarget,inputId:"input-a",job,before:session,after:session,history:{messages,complete:false,inputTailComplete:true}});
    const result=await waitForDeliveryResponse({jobId:job.id,inputId:"input-a",target:opencodeTarget,baseline,readJob:()=>job,waitMs:0,
      readHistory:async()=>({messages,complete:false,inputTailComplete:true,turnComplete:complete})});
    expect(result).toMatchObject({status:"completed",correlation:"reply_to",reason:"no_visible_response",text:"",baselineCoverage:"unavailable"});
  });

  it("does not treat a 49-row page without the admitted native input as a complete tail",()=>{
    const opencodeTarget=target("opencode");
    const job:HerderJob<SendMessageResult>={...completedJob("job-native-input"),result:{ok:true,admitted:true,inputId:"input-a",nativeInputMessageId:"msg-native-input"}};
    const messages:SessionMessageView[]=Array.from({length:49},(_,index)=>({id:`unrelated-${index}`,role:index%2===0?"user":"assistant",text:"unrelated",parts:[]}));
    const session={id:"session-a",harness:"opencode",hostId:"host-a",status:"idle",needsPermission:false} as const;
    expect(nativeDeliveryResponseCompleteByInput({target:opencodeTarget,inputId:"input-a",job,before:session,after:session,history:{messages,complete:false,inputTailComplete:false}})).toBe(false);
  });

  it.each([
    ["missing native input identity",(messages:SessionMessageView[])=>messages,{nativeInputMessageId:undefined}],
    ["duplicate native user IDs",(messages:SessionMessageView[])=>[messages[0]!,messages[0]!,messages[1]!],{}],
    ["a later user input",(messages:SessionMessageView[])=>[...messages,{id:"msg-next-user",role:"user" as const,text:"next",parts:[]}],{}],
    ["a nonterminal assistant",(messages:SessionMessageView[])=>[{...messages[0]!},{...messages[1]!,phase:"tool-calls"}],{}],
    ["a mismatched native turn",(messages:SessionMessageView[])=>[{...messages[0]!},{...messages[1]!,turnId:"turn-other"}],{turnId:"turn-expected"}],
  ])("keeps a baseline-less OpenCode response unknown with %s",async(_label,change,jobOptions)=>{
    const opencodeTarget=target("opencode");
    const job:HerderJob<SendMessageResult>={...completedJob("job-native-input"),result:{ok:true,admitted:true,inputId:"input-a",nativeInputMessageId:"msg-native-input",...(jobOptions as any)}};
    const baseline=await captureDeliveryResponseBaseline({jobId:job.id,inputId:"input-a",target:opencodeTarget,readMessages:async()=>({messages:null,complete:false})});
    const base:SessionMessageView[]=[
      {id:"msg-native-input",role:"user",text:"bounded input",parts:[{type:"text",text:"bounded input"}]},
      {id:"msg-native-answer",role:"assistant",phase:"stop",text:"old or unrelated",parts:[{type:"text",text:"old or unrelated"}]},
    ];
    const messages=change(base);
    const session={id:"session-a",harness:"opencode",hostId:"host-a",status:"idle",needsPermission:false} as const;
    const complete=nativeDeliveryResponseCompleteByInput({target:opencodeTarget,inputId:"input-a",job,before:session,after:session,history:{messages,complete:false,inputTailComplete:true}});
    const result=await waitForDeliveryResponse({jobId:job.id,inputId:"input-a",target:opencodeTarget,baseline,readJob:()=>job,waitMs:0,
      readHistory:async()=>({messages,complete:false,inputTailComplete:true,turnComplete:complete})});
    expect(complete).toBe(false);
    expect(result.status).not.toBe("completed");
    expect(result.baselineCoverage).toBe("unavailable");
  });
  it.each([
    ["codex", { id: "c-assistant", role: "assistant", text: "visible Codex answer", parts: [{ type: "text", text: "visible Codex answer" }] }],
    ["zcode", { id: "z-assistant", role: "assistant", text: "private reasoning\nvisible ZCode answer", parts: [{ type: "thinking", text: "private reasoning" }, { type: "text", text: "visible ZCode answer" }] }],
    ["opencode", { id: "o-assistant", role: "assistant", text: "private reasoning\nvisible OpenCode answer", parts: [{ type: "thinking", text: "private reasoning" }, { type: "text", text: "visible OpenCode answer" }] }],
    ["minimax-code", { id: "m-assistant", role: "assistant", text: "visible MiniMax answer", parts: [{ type: "text", text: "visible MiniMax answer" }] }],
  ] as const)("extracts only normalized visible text for %s", (harness, fixture) => {
    expect(visibleHistoryText(fixture as SessionMessageView)).toContain(harness === "zcode" ? "visible ZCode answer" : harness === "opencode" ? "visible OpenCode answer" : "visible");
    expect(visibleHistoryText(fixture as SessionMessageView)).not.toContain("private reasoning");
  });

  it("stores only IDs, offsets, and text hashes in a target-bound baseline", async () => {
    const old = message("assistant-old", "assistant", "old visible answer", "turn-old");
    const baseline = await captureDeliveryResponseBaseline({
      jobId: "job-a", inputId: "input-a", target: target(),
      readMessages: async () => ({ messages: [message("user-old", "user", "old prompt"), old], complete: true }),
      now: () => new Date("2026-10-25T00:00:00.000Z"),
    });
    expect(validateDeliveryResponseBaseline(baseline, { jobId: "job-a", inputId: "input-a", target: target() })).toBe(true);
    expect(baseline.messages.at(-1)).toMatchObject({ id: "assistant-old", role: "assistant", turnId: "turn-old", textOffset: 18, textPrefixSha256: hash("old visible answer") });
    expect(JSON.stringify(baseline)).not.toContain("old visible answer");
    expect(validateDeliveryResponseBaseline({ ...baseline, text: "private old transcript" })).toBe(false);
    expect(validateDeliveryResponseBaseline(baseline, { jobId: "job-other" })).toBe(false);
  });

  it("returns only a same-message append and exact-turn-correlated new answer", async () => {
    const baseline = await captureDeliveryResponseBaseline({
      jobId: "job-a", inputId: "input-a", target: target(),
      readMessages: async () => ({ messages: [message("assistant-stream", "assistant", "part one", "turn-a")], complete: false }),
    });
    const delta = diffDeliveryResponse({
      baseline,
      target: target(),
      jobId: "job-a",
      inputId: "input-a",
      turnId: "turn-a",
      history: { messages: [message("assistant-stream", "assistant", "part one and new text", "turn-a"), message("assistant-final", "assistant", "second visible message", "turn-a")] },
    });
    expect(delta).toMatchObject({ text: " and new text\nsecond visible message", correlation: "reply_to", integrity: "verified", turnId: "turn-a" });
  });

  it("does not return rewritten baseline text or old history when the prefix cannot be proven", async () => {
    const baseline = await captureDeliveryResponseBaseline({
      jobId: "job-a", inputId: "input-a", target: target(),
      readMessages: async () => ({ messages: [message("assistant-old", "assistant", "old answer")], complete: true }),
    });
    const delta = diffDeliveryResponse({
      baseline, target: target(), jobId: "job-a", inputId: "input-a",
      history: { messages: [message("assistant-old", "assistant", "rewritten old answer"), message("assistant-new", "assistant", "new observed text")] },
    });
    expect(delta).toMatchObject({ text: "new observed text", correlation: "observed_after_delivery", integrity: "baseline_prefix_changed" });
    expect(delta.text).not.toContain("rewritten old answer");
  });

  it("excludes tool, system, and reasoning-only content from observed output", async () => {
    const baseline = await captureDeliveryResponseBaseline({
      jobId: "job-a", inputId: "input-a", target: target(),
      readMessages: async () => ({ messages: [], complete: true }),
    });
    const delta = diffDeliveryResponse({
      baseline, target: target(), jobId: "job-a", inputId: "input-a",
      history: { messages: [
        { id: "tool-1", role: "tool", text: "tool output dump", parts: [{ type: "tool_result", output: "tool output dump" }] },
        { id: "system-1", role: "system", text: "hidden system content", parts: [{ type: "text", text: "hidden system content" }] },
        { id: "assistant-thinking", role: "assistant", text: "private reasoning", parts: [{ type: "thinking", text: "private reasoning" }] },
      ] },
    });
    expect(delta).toMatchObject({ text: "", correlation: "unavailable", integrity: "verified" });
  });

  it("fails closed when the baseline tail has rolled out of the bounded history window", async () => {
    const baseline = await captureDeliveryResponseBaseline({
      jobId: "job-a", inputId: "input-a", target: target(),
      readMessages: async () => ({ messages: [message("assistant-old", "assistant", "old answer")], complete: false }),
    });
    const delta = diffDeliveryResponse({
      baseline, target: target(), jobId: "job-a", inputId: "input-a",
      history: { messages: [message("assistant-new", "assistant", "new answer")] },
    });
    expect(delta).toMatchObject({ text: "", correlation: "unavailable", integrity: "baseline_gap" });
  });

  it("refuses unseen assistant rows before a partial baseline tail", async () => {
    const baseline = await captureDeliveryResponseBaseline({
      jobId: "job-a", inputId: "input-a", target: target(),
      readMessages: async () => ({ messages: [message("assistant-tail", "assistant", "old answer")], complete: false }),
    });
    const delta = diffDeliveryResponse({
      baseline, target: target(), jobId: "job-a", inputId: "input-a",
      history: { messages: [
        message("assistant-older-unseen", "assistant", "must not be returned"),
        message("assistant-tail", "assistant", "old answer"),
        message("assistant-new", "assistant", "new answer"),
      ] },
    });
    expect(delta).toMatchObject({ text: "", correlation: "unavailable", integrity: "baseline_gap" });
  });

  it("returns a pending job reference at the response window without cancelling the send", async () => {
    const baseline = await captureDeliveryResponseBaseline({
      jobId: "job-a", inputId: "input-a", target: target(),
      readMessages: async () => ({ messages: [message("user-old", "user", "old prompt")], complete: true }),
    });
    const job = { ...completedJob("job-a", "turn-a"), state: "running" as const, result: undefined };
    let now = 0;
    const result = await waitForDeliveryResponse({
      jobId: "job-a", inputId: "input-a", target: target(), baseline,
      readJob: async () => job,
      readHistory: async () => ({ messages: [message("user-old", "user", "old prompt"), message("assistant-new", "assistant", "partial answer", "turn-a")] }),
      waitMs: 0,
      now: () => now,
      delay: async (ms) => { now += ms; },
    });
    expect(result).toMatchObject({ status: "partial", correlation: "observed_after_delivery", text: "partial answer", jobId: "job-a", jobRef: "herder://jobs/job-a" });
  });

  it("cancels only observation and leaves the admitted job intact", async () => {
    const baseline = await captureDeliveryResponseBaseline({
      jobId: "job-a", inputId: "input-a", target: target(),
      readMessages: async () => ({ messages: [message("user-old", "user", "old prompt")], complete: true }),
    });
    const job = { ...completedJob("job-a", "turn-a"), state: "running" as const, result: undefined };
    const controller = new AbortController();
    let reads = 0;
    const result = await waitForDeliveryResponse({
      jobId: "job-a", inputId: "input-a", target: target(), baseline,
      readJob: () => { reads += 1; return job; },
      readHistory: async () => ({ messages: [message("user-old", "user", "old prompt"), message("assistant-new", "assistant", "partial", "turn-a")] }),
      waitMs: 5_000,
      pollIntervalMs: 50,
      signal: controller.signal,
      delay: async (_ms, signal) => { controller.abort(); signal?.throwIfAborted(); },
    });
    expect(result).toMatchObject({ status: "partial", observationCancelled: true, text: "partial", jobId: "job-a" });
    expect(job.state).toBe("running");
    expect(reads).toBe(1);
  });

  it("aborts the in-flight history reader when the bounded observation deadline expires", async () => {
    const baseline = await captureDeliveryResponseBaseline({
      jobId: "job-a", inputId: "input-a", target: target(),
      readMessages: async () => ({ messages: [message("user-old", "user", "old prompt")], complete: true }),
    });
    let readSignal: AbortSignal | undefined;
    const observed = await waitForDeliveryResponse({
      jobId: "job-a", inputId: "input-a", target: target(), baseline,
      readJob: () => ({ ...completedJob("job-a"), state: "running", result: undefined }),
      readHistory: async (_target, _limit, signal) => {
        readSignal = signal;
        return await new Promise<DeliveryResponseHistory>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      waitMs: 0,
    });
    expect(observed.status).toBe("unknown");
    expect(readSignal?.aborted).toBe(true);
  });

  it("returns a complete inline answer when the trusted history seam marks the turn complete", async () => {
    const baseline = await captureDeliveryResponseBaseline({
      jobId: "job-a", inputId: "input-a", target: target(),
      readMessages: async () => ({ messages: [], complete: true }),
    });
    const result = await waitForDeliveryResponse({
      jobId: "job-a", inputId: "input-a", target: target(), baseline,
      readJob: () => completedJob("job-a", "turn-a"),
      readHistory: async () => ({ messages: [message("assistant-new", "assistant", "full answer", "turn-a")], complete: true, turnComplete: true }),
      waitMs: 30_000,
    });
    expect(result).toMatchObject({ status: "completed", correlation: "reply_to", text: "full answer", totalTextLength: 11 });
  });

  it("stores output over 8000 chars behind a stable continuation pointer", async () => {
    const baseline = await captureDeliveryResponseBaseline({
      jobId: "job-a", inputId: "input-a", target: target(),
      readMessages: async () => ({ messages: [], complete: true }),
    });
    const longText = "x".repeat(DELIVERY_RESPONSE_MAX_TEXT_CHARS + 37);
    const responseReceipts = new Map<string, import("../src/session-delivery-response.js").DeliveryResponseReceipt>();
    const result = await waitForDeliveryResponse({
      jobId: "job-a", inputId: "input-a", target: target(), baseline,
      readJob: () => completedJob("job-a", "turn-a"),
      readHistory: async () => ({ messages: [message("assistant-new", "assistant", longText, "turn-a")], turnComplete: true }),
      waitMs: 30_000,
      recordResponseReceipt: (jobId, receipt) => { responseReceipts.set(jobId, receipt); },
    });
    expect(result.text.length).toBeGreaterThan(DELIVERY_RESPONSE_MAX_TEXT_CHARS);
    expect(result.totalTextLength).toBe(longText.length);
    expect(result.responseResourceUri).toMatch(/^herder:\/\/m\//);
    expect(result.nextOffset).toBe(DELIVERY_RESPONSE_MAX_TEXT_CHARS);
    const baselineJob = completedJob("job-a", "turn-a");
    const readPage = (offset?: number) => readDeliveryResponseContinuation({
      resourceUri: result.responseResourceUri!, jobId: "job-a", inputId: "input-a", target: target(),
      readJob: () => baselineJob, readBaseline: () => baseline,
      readReceipt: () => responseReceipts.get("job-a") ?? null,
      ...(offset !== undefined ? { offset } : {}), limit: DELIVERY_RESPONSE_MAX_TEXT_CHARS,
    });
    const firstPage = await readPage();
    const nextPage = await readPage(firstPage.nextOffset!);
    expect(firstPage.text + nextPage.text).toBe(longText);
    await expect(readDeliveryResponseContinuation({
      resourceUri: "herder://m/12345678", jobId: "job-a", inputId: "input-a", target: target(),
      readJob: () => baselineJob, readBaseline: () => baseline,
      readReceipt: () => responseReceipts.get("job-a") ?? null,
    })).rejects.toThrow("not bound to a previously returned response");
  });

  it("marks a succeeded turn with an empty assistant final as no visible response", async () => {
    const baseline = await captureDeliveryResponseBaseline({
      jobId: "job-a", inputId: "input-a", target: target(),
      readMessages: async () => ({ messages: [message("user-old", "user", "old prompt")], complete: true }),
    });
    const result = await waitForDeliveryResponse({
      jobId: "job-a", inputId: "input-a", target: target(), baseline,
      readJob: () => completedJob("job-a", "turn-a"),
      readHistory: async () => ({
        messages: [
          message("user-old", "user", "old prompt"),
          { ...message("assistant-empty", "assistant", "", "turn-a"), parts: [{ type: "text", text: "" }] },
        ],
        turnComplete: true,
      }),
      waitMs: 0,
    });
    expect(result).toMatchObject({
      status: "completed",
      reason: "no_visible_response",
      text: "",
      jobRef: "herder://jobs/job-a",
      responseFetchUri: "herder://delivery-responses/host-a/codex/session-a/job-a/input-a",
    });
  });
});
