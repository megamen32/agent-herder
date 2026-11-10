import { afterEach, expect, it, vi } from "vitest";
const fixture=vi.hoisted(()=>({
 config:{schemaVersion:1,enabled:true,statePath:"/tmp/state",gptadminProfileFile:"/tmp/profile",profiles:[],zai:{transport:"browser",accountScope:"a".repeat(64)}},
 close:vi.fn(async()=>{}),tick:vi.fn(),settle:vi.fn(async()=>{}),
}));
vi.mock("../src/automation/v1-browser-runtime.js",()=>({
 acquireV1BrowserAutopilotLease:vi.fn(async()=>async()=>{}),
 readProtectedBrowserAutopilotJson:vi.fn(async()=>fixture.config),
 validateV1BrowserAutopilotConfig:vi.fn(()=>fixture.config),
 createV1BrowserAutopilotRuntime:vi.fn(async()=>({config:fixture.config,service:{tick:fixture.tick,settle:fixture.settle},close:fixture.close})),
}));
import { main } from "../src/browser-autopilot-main.js";
afterEach(()=>{vi.restoreAllMocks();fixture.close.mockClear();});
it("does not start a polling timer if shutdown arrives during the initial async tick",async()=>{
 let finish!:()=>void;fixture.tick.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve}));
 const signals=new Map<string,()=>void>();
 vi.spyOn(process,"once").mockImplementation(((name:string,callback:()=>void)=>{signals.set(name,callback);return process;}) as any);
 const interval=vi.spyOn(globalThis,"setInterval");
 const running=main(["/tmp/protected-config.json"]);
 for(let count=0;count<20&&!finish;count++)await Promise.resolve();
 expect(finish).toBeTypeOf("function");
 signals.get("SIGTERM")!();
 finish();
 await running;
 expect(fixture.close).toHaveBeenCalledOnce();
 expect(interval).not.toHaveBeenCalled();
});
