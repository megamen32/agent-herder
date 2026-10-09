import { describe, expect, it } from "vitest";
import { addressKey, projectObservation, compactSession, parseNativeReceipt } from "../src/mesh/protocol.js";

describe("mesh address and current project (fast unit; expected 2s, maximum 30s)", () => {
  it("keeps equal native IDs on different hosts distinct without project as identity", () => {
    expect(addressKey({hostId:"mac",harness:"codex",nativeSessionId:"same"})).not.toBe(addressKey({hostId:"100",harness:"codex",nativeSessionId:"same"}));
    expect(addressKey({hostId:"mac",harness:"codex",nativeSessionId:"same"})).not.toBe(addressKey({hostId:"mac",harness:"zcode",nativeSessionId:"same"}));
  });
  it("never relabels a launch directory as an observed current directory", () => {
    expect(projectObservation({cwd:"/launch",meta:{launchCwd:"/launch"}})).toEqual({launchCwd:"/launch",currentCwd:null,source:"unverified"});
    expect(projectObservation({cwd:"/launch",meta:{launchCwd:"/launch",activeCwd:"/actual",projectSource:"coordination_activity"}})).toEqual({launchCwd:"/launch",currentCwd:"/actual",source:"coordination_activity"});
  });
  it("compacts session without transcript or arbitrary metadata", () => {
    const input={id:"wrapper",harness:"codex",cwd:"/x",title:"test",status:"idle",lastActivity:"2026-10-09T18:00:00Z",needsPermission:false,lastMessage:"secret transcript",meta:{nativeSessionId:"native",token:"secret"}};
    const s=compactSession("mac",input);
    expect(s.address.nativeSessionId).toBe("native"); expect(JSON.stringify(s)).not.toMatch(/secret|lastMessage|token/);
  });
  it("requires explicit native admission and matching input ID; text ACK cannot prove it", () => {
    expect(parseNativeReceipt({content:[{type:"text",text:'Message sent. Native admission receipt: {"admitted":true,"turnId":"t","inputId":"i"}'}]},"i").state).toBe("admitted");
    expect(parseNativeReceipt({content:[{type:"text",text:"Message sent."}]},"i").state).toBe("unknown");
    expect(parseNativeReceipt({admitted:true,inputId:"other",turnId:"t"},"i").state).toBe("unknown");
  });
});
