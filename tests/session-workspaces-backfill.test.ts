import { describe,it,expect } from "vitest";
import { workspaceEvidenceFromNativeMessages, workspaceEvidenceFromLegacyDeclarations } from "../src/session-workspaces-backfill.js";
const identity={runtimeHostId:"mac-m1",harness:"minimax-code",nativeSessionId:"mvs_one",workHostId:"server-100"};
describe("bounded native evidence",()=>{
 it("extracts actual execution workdirs, never GUI request cwd or arbitrary title/content paths",()=>{
 const rows=workspaceEvidenceFromNativeMessages({...identity,messages:[{timestamp:1792778992973,msg_id:"native-msg",msg_content:"/home/roomhacker/fake",title:"/home/roomhacker/title",tool_calls:[{tool_name:"bash",tool_call_id:"actual",tool_call_args:JSON.stringify({command:"ssh server100 'cd /home/roomhacker/agents-projects/exmanager && git status'"})},{tool_name:"mcp__noticeplace__send_message",tool_call_args:{cwd:"/Users/user/launch"}}]}]});
 expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({hostId:"server-100",absolutePath:"/home/roomhacker/agents-projects/exmanager",evidenceRef:"native-message:native-msg:tool:actual"});
 });
 it("leaves unknown paths unknown",()=>expect(workspaceEvidenceFromNativeMessages({...identity,messages:[{timestamp:1792778992973,tool_calls:[{tool_name:"bash",tool_call_args:{command:"pwd"}}]}]})).toEqual([]));
});

it("migrates only unambiguous live legacy declarations, not colliding native IDs",()=>{const declaration={sessionId:identity.nativeSessionId,harness:identity.harness,hostId:"server-100",cwd:"/repo/actual",expiresAt:"2026-10-24T00:00:00Z"};const args={identities:[identity],declarations:[declaration],observedAt:"2026-10-23T18:00:00Z"};expect(workspaceEvidenceFromLegacyDeclarations(args)).toHaveLength(1);expect(workspaceEvidenceFromLegacyDeclarations({...args,identities:[identity,{...identity,runtimeHostId:"another-host"}]})).toEqual([]);});
