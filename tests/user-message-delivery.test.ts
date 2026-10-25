import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { UserMessageDelivery, verifyDurableUserDeliveryClaim, type UserMessageInput } from "../src/user-message-delivery.js";
import { MinimaxExecPolicyStore } from "../src/permission-control/minimax-exec-policy.js";
import { MINIMAX_CLI_TIMEOUT_MS } from "../src/adapters/minimax-code-control.js";
import type { HarnessAdapter, SendMessageResult } from "../src/types/index.js";

const fixtureRoots:string[]=[];
afterEach(()=>{for(const root of fixtureRoots.splice(0))rmSync(root,{recursive:true,force:true});});

function fixture(options?: { jobs?: HerderJobRegistry; harness?: string; result?: SendMessageResult; maxWaitMs?: number }) {
  let status = "running";
  const harness = options?.harness || "codex";
  const root=options?.jobs?undefined:mkdtempSync(join(tmpdir(),"herder-user-message-fixture-"));
  if(root)fixtureRoots.push(root);
  const getSession = vi.fn(async () => ({ id: "thread", harness, status, cwd: "/workspace" }));
  const sendMessage = vi.fn(async () => { status = "running"; return options?.result || { ok: true, admitted: true, turnId: "native-turn" }; });
  const adapter = { getSession } as unknown as HarnessAdapter;
  const jobs = options?.jobs || new HerderJobRegistry(new HerderEventBus(),{persistencePath:join(root!,"jobs.json")});
  const delivery = new UserMessageDelivery(new Map([[harness, adapter]]), { sendMessage }, jobs, { pollMs: 5, maxWaitMs: options?.maxWaitMs ?? 1_000, maxPending: 4 });
  const input = (id: string, mode: "queue" | "steer" = "queue"): UserMessageInput => ({ harness, sessionId: "thread", inputId: id, message: id, mode });
  return { delivery, jobs, getSession, sendMessage, input, idle: () => { status = "idle"; } };
}

const completed = async (f: ReturnType<typeof fixture>, id: string) => {
  await vi.waitFor(() => expect(f.delivery.get(f.input(id).harness, "thread", id)?.job?.state).toBe("completed"), { interval: 5, timeout: 500 });
};

describe("actual human message queue admission", () => {
  it("durably freezes visible response baseline in the same job before native submit",async()=>{
    const root=await mkdtemp(join(tmpdir(),"herder-response-baseline-"));
    const jobs=new HerderJobRegistry(new HerderEventBus(),{persistencePath:join(root,"jobs.json")});
    const previous={id:"assistant-before",role:"assistant" as const,text:"old visible answer",parts:[{type:"text" as const,text:"old visible answer"}]};
    const session={id:"mvs-response-target",harness:"minimax-code",hostId:"target-host",status:"idle",cwd:"/workspace"};
    const adapter={getSession:vi.fn(async()=>session),getSessionMessages:vi.fn(async()=>[previous])} as unknown as HarnessAdapter;
    const order:string[]=[];
    const sender=vi.fn(async(_harness:string,sessionId:string,options:any)=>{
      const target={hostId:"target-host",harness:"minimax-code" as const,sessionId};
      const baseline=jobs.readDeliveryResponseBaseline(options.durableUserDelivery.jobId,{inputId:options.inputId,target});
      order.push("native");
      expect(baseline.messages).toMatchObject([{id:"assistant-before",role:"assistant",textOffset:18}]);
      expect(JSON.stringify(baseline)).not.toContain("old visible answer");
      return {ok:true,admitted:true,turnId:"response-turn",inputId:options.inputId};
    });
    const delivery=new UserMessageDelivery(new Map([["minimax-code",adapter]]),{sendMessage:sender},jobs,{pollMs:1,maxWaitMs:2_000,maxPending:4},new MinimaxExecPolicyStore(join(root,"policy")),{
      afterBaselinePersist:()=>{order.push("baseline");},afterNativeReceipt:()=>{order.push("receipt");},
    });
    try{
      const receipt=await delivery.submitMinimaxAgent({harness:"minimax-code",sessionId:session.id,inputId:"response-input",message:"new request",mode:"queue"},{hostId:"source",harness:"opencode",nativeSessionId:"source-session"});
      expect(receipt.job?.durableOnce).toBe(true);
      await vi.waitFor(()=>expect(jobs.get(receipt.job!.id)?.state).toBe("completed"));
      await vi.waitFor(()=>expect(order).toEqual(["baseline","native","receipt"]));
      expect(jobs.get(receipt.job!.id)).not.toHaveProperty("deliveryResponseBaseline");
      const responseTarget={hostId:"target-host",harness:"minimax-code" as const,sessionId:session.id};
      const responseReceipt={inputId:"response-input",target:responseTarget,responseResourceUri:"herder://m/abcdef1234567890",responseSha256:"a".repeat(64),totalTextLength:9_001};
      jobs.recordDeliveryResponseReceipt(receipt.job!.id,responseReceipt);
      expect(jobs.readDeliveryResponseReceipt(receipt.job!.id,{inputId:"response-input",target:responseTarget,responseResourceUri:responseReceipt.responseResourceUri})).toEqual(responseReceipt);
      expect(jobs.get(receipt.job!.id)).not.toHaveProperty("deliveryResponseReceipt");
      expect(()=>jobs.readDeliveryResponseReceipt(receipt.job!.id,{inputId:"response-input",target:{...responseTarget,hostId:"other-host"},responseResourceUri:responseReceipt.responseResourceUri})).toThrow(/unavailable_or_unbound/);
      await expect(delivery.readDeliveryResponseBaseline(receipt.job!.id,"response-input",{hostId:"other-host",harness:"minimax-code",sessionId:session.id})).rejects.toThrow(/target_mismatch|unavailable_or_unbound/);
    }finally{delivery.close();await delivery.getMinimaxExecPolicy({hostId:"target-host",harness:"minimax-code",sessionId:session.id});await delivery.getMinimaxExecPolicy({hostId:"target-host",harness:"minimax-code",sessionId:session.id});await rm(root,{recursive:true,force:true});}
  });

  it("keeps queue edit CAS target and policy bindings in the same job before native admission",async()=>{
    const root=await mkdtemp(join(tmpdir(),"herder-minimax-edit-cas-"));
    const target={hostId:"target-host",harness:"minimax-code" as const,sessionId:"mvs-edit-target"};
    const store=new MinimaxExecPolicyStore(join(root,"policy"));
    const jobs=new HerderJobRegistry(new HerderEventBus(),{persistencePath:join(root,"jobs.json")});
    const session={id:target.sessionId,harness:target.harness,hostId:target.hostId,status:"running",cwd:"/workspace"};
    const adapter={getSession:vi.fn(async()=>session),getSessionMessages:vi.fn(async()=>[])} as unknown as HarnessAdapter;
    let sent:any,releaseSend!:(result:SendMessageResult)=>void;
    const sender=vi.fn((_harness:string,_sessionId:string,options:any)=>{sent=options;return new Promise<SendMessageResult>(resolve=>{releaseSend=resolve;});});
    const delivery=new UserMessageDelivery(new Map([["minimax-code",adapter]]),{sendMessage:sender},jobs,{pollMs:1,maxWaitMs:2_000,maxPending:4},store);
    const input={harness:target.harness,sessionId:target.sessionId,inputId:"edit-cas-input",message:"old queued text",mode:"queue" as const};
    try{
      const created=await delivery.submitMinimaxExecPolicy(input);
      const originalFingerprint=created.job!.requestFingerprint;
      const edit=delivery.editQueuedMessage(input.harness,input.sessionId,input.inputId,input.message,"edited queued text");
      const edited=delivery.get(input.harness,input.sessionId,input.inputId)!.job!;
      expect(edit).toMatchObject({jobId:created.job!.id,inputId:input.inputId,message:"edited queued text",editable:true});
      expect(edited.id).toBe(created.job!.id);
      expect(edited.createdAt).toBe(created.job!.createdAt);
      expect(edited.requestFingerprint).not.toBe(originalFingerprint);
      expect(()=>delivery.editQueuedMessage(input.harness,input.sessionId,input.inputId,input.message,"stale second edit")).toThrow(/уже изменён/);
      session.status="idle";
      await vi.waitFor(()=>expect(sender).toHaveBeenCalledOnce());
      expect(sent.message).toBe("edited queued text");
      expect(sent.durableUserDelivery.requestFingerprint).toBe(edited.requestFingerprint);
      expect(verifyDurableUserDeliveryClaim(sent.durableUserDelivery,{jobId:edited.id,inputId:input.inputId,requestFingerprint:edited.requestFingerprint,
        harness:target.harness,sessionId:target.sessionId,targetHostId:target.hostId,mode:"queue",minimaxExecPolicy:sent.durableUserDelivery.minimaxExecPolicy},"edited queued text")).toBe(true);
      expect(()=>delivery.editQueuedMessage(input.harness,input.sessionId,input.inputId,"edited queued text","too late")).toThrow(/уже передаётся/);
      releaseSend({ok:true,admitted:true,turnId:"edit-turn",inputId:input.inputId});
      await vi.waitFor(()=>expect(delivery.get(input.harness,input.sessionId,input.inputId)?.job?.state).toBe("completed"));
      expect(sender).toHaveBeenCalledOnce();
    }finally{releaseSend?.({ok:true,admitted:true,turnId:"edit-turn-cleanup",inputId:input.inputId});delivery.close();await delivery.getMinimaxExecPolicy(target);await delivery.getMinimaxExecPolicy(target);await rm(root,{recursive:true,force:true});}
  });

  it("does not replay a restored legacy job whose target-bound fingerprint cannot be proven",async()=>{
    const root=await mkdtemp(join(tmpdir(),"herder-minimax-legacy-job-"));
    const jobsPath=join(root,"jobs.json");
    const session={id:"mvs-legacy-target",harness:"minimax-code",hostId:"target-host",status:"idle",cwd:"/workspace"};
    const input={harness:"minimax-code",sessionId:session.id,inputId:"legacy-input",message:"old queued text",mode:"queue" as const};
    const idempotencyKey=`user-message\0${input.harness}\0${input.sessionId}\0${input.inputId}`;
    const first=new HerderJobRegistry(new HerderEventBus(),{persistencePath:jobsPath});
    const oldJob=first.start({kind:"Доставка сообщения (minimax-code)",ownerSessionId:session.id,idempotencyKey,requestFingerprint:"b".repeat(64),durableOnce:true,run:async()=>({ok:true,admitted:true,turnId:"legacy-native-turn"})});
    await vi.waitFor(()=>expect(first.get(oldJob.id)?.state).toBe("completed"));
    const restored=new HerderJobRegistry(new HerderEventBus(),{persistencePath:jobsPath});
    const send=vi.fn(async()=>({ok:true,admitted:true,turnId:"must-not-run"}));
    const adapter={getSession:vi.fn(async()=>session)} as unknown as HarnessAdapter;
    const delivery=new UserMessageDelivery(new Map([["minimax-code",adapter]]),{sendMessage:send},restored,{pollMs:1,maxWaitMs:2_000,maxPending:4},new MinimaxExecPolicyStore(join(root,"policy")));
    try{
      await expect(delivery.submitMinimaxExecPolicy(input)).rejects.toThrow(/уже использован/);
      expect(send).not.toHaveBeenCalled();
      expect(restored.get(oldJob.id)?.result).toMatchObject({ok:true,turnId:"legacy-native-turn"});
    }finally{delivery.close();await delivery.getMinimaxExecPolicy({hostId:"target-host",harness:"minimax-code",sessionId:session.id});await rm(root,{recursive:true,force:true});}
  });

  it("uses the same durable job for an explicitly non-human MiniMax mesh delivery",async()=>{
    const root=await mkdtemp(join(tmpdir(),"herder-agent-delivery-"));
    const jobs=new HerderJobRegistry(new HerderEventBus(),{persistencePath:join(root,"jobs.json")});
    const session={id:"mvs-agent-target",harness:"minimax-code",hostId:"host-target",status:"idle",cwd:"/workspace"};
    const adapter={getSession:vi.fn(async()=>session)} as unknown as HarnessAdapter;
    let observedOptions:any;
    const sendMessage=vi.fn(async(_harness:string,_sessionId:string,options:any)=>{observedOptions=options;return {ok:true,admitted:true,turnId:"native-agent-turn"} as SendMessageResult;});
    const delivery=new UserMessageDelivery(new Map([["minimax-code",adapter]]),{sendMessage},jobs,{pollMs:1,maxWaitMs:2_000,maxPending:4});
    const input={harness:"minimax-code",sessionId:session.id,inputId:"agent-input-1",message:"bounded agent delta",mode:"queue" as const};
    const sender={hostId:"host-source",harness:"opencode",nativeSessionId:"session-source"};
    try{
      const first=await delivery.submitMinimaxAgent(input,sender);
      expect(first.job).toBeDefined();
      await vi.waitFor(()=>expect(delivery.get(input.harness,input.sessionId,input.inputId)).toMatchObject({ok:true,admitted:true,turnId:"native-agent-turn"}));
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(observedOptions).toMatchObject({origin:"automation",inputId:input.inputId,message:input.message});
      expect(observedOptions.humanRequestedAt).toBeUndefined();
      const claim=observedOptions.durableUserDelivery;
      const binding={jobId:first.job!.id,inputId:input.inputId,requestFingerprint:first.job!.requestFingerprint,harness:input.harness,sessionId:input.sessionId,targetHostId:"host-target",mode:"queue" as const,actor:{kind:"agent" as const,principal:"agent-herder-mesh" as const,senderAssertion:sender},minimaxExecPolicy:claim.minimaxExecPolicy};
      expect(verifyDurableUserDeliveryClaim(claim,binding,input.message)).toBe(true);
      expect(verifyDurableUserDeliveryClaim(claim,{...binding,actor:{kind:"human"}},input.message)).toBe(false);
      expect(verifyDurableUserDeliveryClaim(claim,{...binding,targetHostId:"other-host"},input.message)).toBe(false);
      const replay=await delivery.submitMinimaxAgent(input,sender);
      expect(replay.job?.id).toBe(first.job?.id);
      await expect(delivery.submitMinimaxAgent(input,{...sender,nativeSessionId:"forged-source"})).rejects.toThrow(/другого текста, режима или политики/);
      expect(sendMessage).toHaveBeenCalledOnce();
    }finally{delivery.close();await rm(root,{recursive:true,force:true});}
  });

  it("waits for a native MiniMax CLI turn that completes after thirty seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture({ harness: "minimax-code", maxWaitMs: 10 * 60_000 });
    let started!: () => void;
    const sendStarted = new Promise<void>(resolve => { started = resolve; });
    f.sendMessage.mockImplementationOnce(() => new Promise(resolve => {
      started();
      setTimeout(() => resolve({ ok: true, admitted: true, turnId: "late-minimax-turn" }), 31_500);
    }));
    try {
      f.idle();
      const receipt = f.delivery.submit(f.input("minimax-late-completion"));
      await sendStarted;
      await vi.advanceTimersByTimeAsync(31_500);
      await Promise.resolve();
      expect(f.jobs.get(receipt.job!.id)).toMatchObject({
        state: "completed",
        result: { ok: true, admitted: true, turnId: "late-minimax-turn", inputId: "minimax-late-completion" },
      });
      expect(f.delivery.submit(f.input("minimax-late-completion"))).toMatchObject({ admitted: true, turnId: "late-minimax-turn" });
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      f.delivery.close();
      vi.useRealTimers();
    }
  });

  it("returns terminal UNKNOWN after a hung MiniMax CLI deadline and never replays", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture({ harness: "minimax-code", maxWaitMs: 10 * 60_000 });
    let started!: () => void;
    let finishLate!: (result: SendMessageResult) => void;
    const sendStarted = new Promise<void>(resolve => { started = resolve; });
    f.sendMessage.mockImplementationOnce(() => new Promise(resolve => {
      started();
      finishLate = resolve;
    }));
    try {
      f.idle();
      const receipt = f.delivery.submit(f.input("minimax-hung-completion"));
      await sendStarted;
      await vi.advanceTimersByTimeAsync(MINIMAX_CLI_TIMEOUT_MS + 5_000);
      await Promise.resolve();
      expect(f.jobs.get(receipt.job!.id)).toMatchObject({
        state: "completed",
        result: { ok: false, admissionUnknown: true, nonRetryable: true, inputId: "minimax-hung-completion" },
      });
      expect(f.delivery.submit(f.input("minimax-hung-completion"))).toMatchObject({ admissionUnknown: true, nonRetryable: true });
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
      finishLate({ ok: true, admitted: true, turnId: "late-after-unknown" });
      await Promise.resolve();
      expect(f.jobs.get(receipt.job!.id)?.result).toMatchObject({ admissionUnknown: true, nonRetryable: true });
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      f.delivery.close();
      vi.useRealTimers();
    }
  });

  it("rejects editing while a native call is still in flight",async()=>{
    const f=fixture();let release!:(value:SendMessageResult)=>void;
    f.sendMessage.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    try{
      f.idle();f.delivery.submit(f.input('in-flight'));
      await vi.waitFor(()=>expect(f.sendMessage).toHaveBeenCalledTimes(1));
      expect(()=>f.delivery.editQueuedMessage('codex','thread','in-flight','in-flight','changed')).toThrow(/передаётся/);
      release({ok:true,admitted:true,turnId:'native-turn'});await completed(f,'in-flight');
      expect(f.sendMessage.mock.calls[0][2].message).toBe('in-flight');
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
    }finally{f.delivery.close();}
  });
  it("edits the same waiting item without changing its identity or place in the queue", async () => {
    const f=fixture();
    try {
      const before=f.delivery.submit(f.input('edit-one'));
      f.delivery.submit(f.input('edit-two'));
      await vi.waitFor(()=>expect(f.delivery.get('codex','thread','edit-one')?.job?.state).toBe('waiting'));
      const changed=f.delivery.editQueuedMessage('codex','thread','edit-one','edit-one','changed text');
      expect(changed).toMatchObject({inputId:'edit-one',message:'changed text',jobId:before.job?.id,createdAt:before.job?.createdAt});
      expect(()=>f.delivery.editQueuedMessage('codex','thread','edit-one','edit-one','stale edit')).toThrow(/изменён/);
      f.idle();await completed(f,'edit-one');
      f.idle();await completed(f,'edit-two');
      expect(f.sendMessage.mock.calls.map(call=>[call[2].inputId,call[2].message])).toEqual([['edit-one','changed text'],['edit-two','edit-two']]);
      expect(()=>f.delivery.editQueuedMessage('codex','thread','edit-one','changed text','too late')).toThrow(/передаётся|передано/);
      expect(f.sendMessage).toHaveBeenCalledTimes(2);
    } finally {f.delivery.close();}
  });

  it("refuses an edit once native submission has started, including an unknown outcome",async()=>{
    const f=fixture({result:{ok:false,admissionUnknown:true,nonRetryable:true,error:'lost reply'}});
    try {
      f.idle();f.delivery.submit(f.input('native-unknown'));await completed(f,'native-unknown');
      expect(()=>f.delivery.editQueuedMessage('codex','thread','native-unknown','native-unknown','replacement')).toThrow(/передаётся|передано/);
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
    }finally{f.delivery.close();}
  });

  it("waits for native idle, starts each distinct message in order, and deduplicates a retry", async () => {
    const f = fixture();
    try {
      const first = f.delivery.submit(f.input("one"));
      expect(f.delivery.submit(f.input("one")).job?.id).toBe(first.job?.id);
      f.delivery.submit(f.input("two"));
      await vi.waitFor(() => expect(f.getSession).toHaveBeenCalled());
      expect(f.sendMessage).not.toHaveBeenCalled();
      f.idle(); await completed(f, "one");
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
      expect(f.sendMessage.mock.calls[0][2]).toMatchObject({ message: "one", inputId: "one", origin: "human", queue: true, steer: false });
      f.idle(); await completed(f, "two");
      expect(f.sendMessage.mock.calls.map(call => call[2].message)).toEqual(["one", "two"]);
      expect(f.delivery.submit(f.input("one"))).toMatchObject({ admitted: true, turnId: "native-turn" });
      expect(f.sendMessage).toHaveBeenCalledTimes(2);
    } finally { f.delivery.close(); }
  });

  it("steers immediately while the human queue waits for the current turn", async () => {
    const f = fixture();
    try {
      f.delivery.submit(f.input("after"));
      f.delivery.submit(f.input("now", "steer"));
      await completed(f, "now");
      expect(f.sendMessage.mock.calls.map(call => call[2].message)).toEqual(["now"]);
      expect(f.sendMessage.mock.calls[0][2].steer).toBe(true);
      f.idle(); await completed(f, "after");
    } finally { f.delivery.close(); }
  });

  it("delivers intentionally repeated human text once per distinct input identity", async () => {
    const f = fixture();
    const first = { ...f.input("intent-one"), message: "Продолжи эту задачу" };
    const second = { ...f.input("intent-two"), message: first.message };
    try {
      f.delivery.submit(first);
      f.delivery.submit(second);
      f.idle(); await completed(f, first.inputId);
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
      f.idle(); await completed(f, second.inputId);
      expect(f.sendMessage.mock.calls.map(call => [call[2].inputId, call[2].message])).toEqual([
        [first.inputId, first.message], [second.inputId, second.message],
      ]);
      f.delivery.submit(first); f.delivery.submit(second);
      expect(f.sendMessage).toHaveBeenCalledTimes(2);
    } finally { f.delivery.close(); }
  });

  it("does not replay uncertain native admission or reuse an identity for different text", async () => {
    const f = fixture({ result: { ok: false, admissionUnknown: true, nonRetryable: true, error: "lost receipt" } });
    try {
      f.idle(); f.delivery.submit(f.input("unknown")); await completed(f, "unknown");
      expect(f.delivery.submit(f.input("unknown"))).toMatchObject({ ok: false, admissionUnknown: true });
      expect(() => f.delivery.submit({ ...f.input("unknown"), message: "other text" })).toThrow(/другого текста/);
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
    } finally { f.delivery.close(); }
  });

  it("keeps an interrupted durable job visible after restart and never silently resubmits it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herder-human-queue-"));
    const path = join(dir, "jobs.json");
    const first = fixture({ jobs: new HerderJobRegistry(new HerderEventBus(), { persistencePath: path }) });
    let second: ReturnType<typeof fixture> | undefined;
    try {
      const record = first.delivery.submit(first.input("restart"));
      second = fixture({ jobs: new HerderJobRegistry(new HerderEventBus(), { persistencePath: path }) });
      const replay = second.delivery.submit(second.input("restart"));
      expect(replay.job?.id).toBe(record.job?.id);
      expect(replay).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true, job: { state: "interrupted" } });
      expect(second.sendMessage).not.toHaveBeenCalled();
    } finally { first.delivery.close(); second?.delivery.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("does not silently expose Codex steer semantics through ZCode sendPrompt", () => {
    const f = fixture({ harness: "zcode" });
    try {
      expect(() => f.delivery.submit(f.input("not-supported", "steer"))).toThrow(/пока не поддерживается/);
      expect(f.sendMessage).not.toHaveBeenCalled();
    } finally { f.delivery.close(); }
  });

  it("finishes a timed out native read without declaring admission or blocking another session", async () => {
    const f = fixture({ maxWaitMs: 20 });
    let release!: () => void;
    f.getSession.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ id: "thread", harness: "codex", cwd: "/workspace", status: "idle" });
    }));
    try {
      f.delivery.submit(f.input("unavailable"));
      await vi.waitFor(() => expect(f.getSession).toHaveBeenCalled());
      await completed(f, "unavailable");
      expect(f.delivery.get("codex", "thread", "unavailable")).toMatchObject({ ok: false, nonRetryable: true });
      expect(f.sendMessage).not.toHaveBeenCalled();
      f.delivery.submit({ ...f.input("other", "steer"), sessionId: "another-thread" });
      await vi.waitFor(() => expect(f.delivery.get("codex", "another-thread", "other")?.admitted).toBe(true));
      release();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
    } finally { release?.(); f.delivery.close(); }
  });

  it("keeps late native admission unknown after cancellation and never repeats that input", async () => {
    const f = fixture();
    let release!: () => void;
    f.sendMessage.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ ok: true, admitted: true, turnId: "late-turn" });
    }));
    try {
      f.idle(); f.delivery.submit(f.input("late"));
      await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledTimes(1));
      f.delivery.cancelSession("codex", "thread");
      await completed(f, "late");
      expect(f.delivery.submit(f.input("late"))).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true });
      release();
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(f.delivery.get("codex", "thread", "late")?.admissionUnknown).toBe(true);
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
    } finally { release?.(); f.delivery.close(); }
  });
});

// Fast unit expected1s/max5s: image identity cannot change under an existing queued input.
it("retains image input through delayed delivery and refuses a changed retry", async () => {
  const f = fixture();
  const image = { id: "a".repeat(64), path: "/protected/image.png", fileName: "figure.png", mimeType: "image/png", bytes: 90 };
  const input = { ...f.input("image-input"), images: [image] };
  try {
    f.delivery.submit(input);
    expect(() => f.delivery.submit({ ...input, images: [{ ...image, id: "b".repeat(64) }] })).toThrow('другого');
    f.idle(); await completed(f, "image-input");
    expect(f.sendMessage.mock.calls[0][2].images).toEqual([image]);
  } finally { f.delivery.close(); }
});

// Focused integration expected1s/max5s: actual job cancellation preserves the dispatch boundary.
it("records that a waiting message was never submitted when its job is cancelled", async () => {
 const f=fixture();
 try {
  const receipt=f.delivery.submit(f.input("cancel-before"));
  await vi.waitFor(() => expect(f.getSession).toHaveBeenCalled());
  f.jobs.cancel(receipt.job!.id);
  await vi.waitFor(() => expect(f.jobs.get(receipt.job!.id)?.state).toBe("cancelled"));
  expect(f.jobs.get(receipt.job!.id)?.result).toMatchObject({ notSubmitted: true });
  expect(f.sendMessage).not.toHaveBeenCalled();
 } finally {f.delivery.close();}
});

// Focused integration expected1s/max5s: normal ZCode queue must use native V4 admission, not legacy prompt wait.
it("uses native queue admission for a ZCode human message", async()=>{
 const f=fixture({harness:"zcode"});
 try{f.delivery.submit(f.input("zcode-queue"));f.idle();await completed(f,"zcode-queue");expect(f.sendMessage.mock.calls[0][2]).toMatchObject({queue:true,steer:false});}
 finally{f.delivery.close();}
});
