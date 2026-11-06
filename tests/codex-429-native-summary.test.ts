import { expect, it } from "vitest";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";

const error = {
  message: "exceeded retry limit, last status: 429 Too Many Requests, request id: 8e065465-a4f2-4918-b94a-30d138157787",
  codexErrorInfo: { response_too_many_failed_attempts: { http_status_code: 429 } },
};
const header = { id: "failed-turn", status: "failed", completedAt: 1792699000, error };
const summary = { ...header, itemsView: "summary", items: [{id:"native-input",type:"userMessage"}] };

it("recovers one bounded native input from a matching failed summary page after reconnect", async () => {
  const adapter = new CodexAppServerAdapter({socketPath:"/unused-codex-429"});
  const native = adapter as any;
  native.threads.set("target", { id: "target", model: "gpt-6.1-terra" });
  const calls: string[] = [];
  native.request = async (method: string, input: any) => {
    calls.push(`${method}:${input.itemsView}`);
    return {data:[input.itemsView==="summary" ? summary : header]};
  };
  try {
    await native.refreshActiveTurnId("target");
    const state = native.toSession(native.threads.get("target"));
    expect(state.meta.nativeLastTurn.quotaFailure).toMatchObject({
      classification:"retry_limited",nativeTurnId:"failed-turn",inputId:"native-input",
    });
    expect(calls).toEqual(["thread/turns/list:notLoaded","thread/turns/list:summary"]);
  } finally { await adapter.dispose(); }
});

it("defers the failed event until native summary proves the original input; no speculative replay", async () => {
  const adapter = new CodexAppServerAdapter({socketPath:"/unused-codex-429"});
  const native = adapter as any;
  native.threads.set("target", { id: "target", model: "gpt-6.1-terra" });
  const events:any[]=[];
  native.emitEvent = (event:any) => events.push(event);
  native.request = async (_method:string,_input:any) => ({data:[summary]});
  try {
    native.consumeMessage({ method:"turn/completed",params:{threadId:"target",turn:header}});
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(events.filter(x=>x.kind==="turn.failed")).toHaveLength(1);
    expect(events[0].data).toMatchObject({turnId:"failed-turn",
      inputId:"native-input",quotaFailure:{classification:"retry_limited",inputId:"native-input"}});
  } finally { await adapter.dispose(); }
});

it("a mismatched native summary never authorizes 429 recovery", async () => {
  const adapter = new CodexAppServerAdapter({socketPath:"/unused-codex-429"});
  const native = adapter as any;
  native.threads.set("target", { id: "target", model: "gpt-6.1-terra" });
  const events:any[]=[];
  native.emitEvent = (event:any) => events.push(event);
  native.request = async () => ({data:[{...summary,id:"different-turn"}]});
  try {
    native.consumeMessage({ method:"turn/completed",params:{threadId:"target",turn:header}});
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(events.filter(x=>x.kind==="turn.failed")).toHaveLength(1);
    expect(events[0].data.quotaFailure).toBeUndefined();
  } finally { await adapter.dispose(); }
});
