import {describe,expect,it,vi} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {MeshDeliveryLedger} from "../src/mesh/delivery-ledger.js";
describe("mesh durable no replay (focused integration; expected 5s, maximum 30s)",()=>{
 it("retains UNKNOWN across new clients and rejects changed input",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-mesh-test-"));try{
   const file=join(dir,"ledger.json"),send=vi.fn(async()=>{throw new Error("lost");});
   const request={target:{hostId:"h",harness:"codex",nativeSessionId:"n"},sender:{hostId:"s",harness:"codex",nativeSessionId:"s"},inputId:"i",message:"delta"};
   expect((await new MeshDeliveryLedger(file).once(request,send)).state).toBe("unknown");
   expect((await new MeshDeliveryLedger(file).once(request,send)).state).toBe("unknown");expect(send).toHaveBeenCalledTimes(1);
   expect((await new MeshDeliveryLedger(file).once({...request,message:"different"},send)).reason).toBe("input_id_conflict");
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});
