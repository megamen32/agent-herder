import {describe,expect,it,vi} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {deliverSharedCodex} from "../src/mesh/shared-delivery.js";
import {MeshDeliveryLedger} from "../src/mesh/delivery-ledger.js";
import {HumanStopStore} from "../src/human-stop-store.js";
const request={target:{hostId:"88",harness:"codex",nativeSessionId:"n"},sender:{hostId:"100",harness:"codex",nativeSessionId:"s"},inputId:"i",message:"delta"};
async function fixture(run:(deps:any)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),"herder-mesh-shared-"));try{
 const client={connect:vi.fn(async()=>{}),request:vi.fn(async(method:string,args:any)=>method==="thread/read"?{thread:{id:"n"}}:method==="thread/turns/list"?{data:[{id:"t",status:"inProgress"}]}:{turnId:"t"})};
 await run({client,ledger:new MeshDeliveryLedger(join(dir,"ledger.json")),stopStore:new HumanStopStore(join(dir,"stop.json")),observe:vi.fn(async()=>({nativeSessionId:"n",status:"running"}))});
}finally{await rm(dir,{recursive:true,force:true});}}
describe("shared native writer fence (focused integration; expected 5s, maximum 30s)",()=>{
 it("uses identity without turns, one bounded metadata page and expected current turn",async()=>fixture(async deps=>{
  expect((await deliverSharedCodex(request,deps)).state).toBe("admitted");
  expect(deps.client.request.mock.calls).toEqual([["thread/read",{threadId:"n",includeTurns:false}],["thread/turns/list",{threadId:"n",limit:1,sortDirection:"desc",itemsView:"notLoaded"}],["turn/steer",expect.objectContaining({threadId:"n",expectedTurnId:"t"})]]);
 }));
 it("never controls an unknown foreign writer, even if private thread/read would look idle",async()=>fixture(async deps=>{
  deps.observe.mockResolvedValue({nativeSessionId:"n",status:"unknown"});expect((await deliverSharedCodex(request,deps)).state).toBe("not_attempted");expect(deps.client.connect).not.toHaveBeenCalled();
 }));
 it("honors durable manual stop even with completed latest turn",async()=>fixture(async deps=>{
  await deps.stopStore.hold({harness:"codex",id:"n"},{id:"stop",at:new Date().toISOString(),reason:"human"});
  deps.client.request.mockResolvedValue({thread:{id:"n",turns:[{status:"completed"}]}});
  expect((await deliverSharedCodex(request,deps)).reason).toBe("human_stopped_native_session");expect(deps.client.connect).not.toHaveBeenCalled();expect(deps.observe).not.toHaveBeenCalled();
 }));
 it("does not hide durable UNKNOWN when the target disappears or becomes stopped",async()=>fixture(async deps=>{
  deps.client.request.mockImplementation(async(method:string)=>{if(method==="thread/read")return {thread:{id:"n"}};if(method==="thread/turns/list")return {data:[{id:"t",status:"inProgress"}]};throw new Error("lost admission");});
  expect((await deliverSharedCodex(request,deps)).state).toBe("unknown");
  deps.observe.mockRejectedValue(new Error("gone"));await deps.stopStore.hold({harness:"codex",id:"n"},{id:"later-stop",at:new Date().toISOString(),reason:"human"});
  expect((await deliverSharedCodex(request,deps)).state).toBe("unknown");expect(deps.observe).toHaveBeenCalledTimes(1);expect(deps.client.request).toHaveBeenCalledTimes(3);
 }));
});
