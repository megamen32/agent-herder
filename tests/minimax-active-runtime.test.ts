import { describe, expect, it, vi } from "vitest";
import { readMinimaxActiveSessions } from "../src/adapters/minimax-code-active.js";

describe("native MiniMax active metadata", () => {
  it("follows every owner/page, keeps Started despite historical errors, and preserves child identity", async () => {
    const call = vi.fn(async (_method: string, path: string) => ({ ok: true, status: 200, body: path === "/agent" ? { agents: [{ name: "mavis" }, { name: "worker" }] } : path.includes("worker") ? {sessions:[{session_id:"child",parent_session_id:"root",status:{status_type:1}}],has_more:false} : path.includes("cursor=") ? {sessions:[{session_id:"idle",status:{status_type:0}}],has_more:false} : {sessions:[{session_id:"root",status:{status_type:1,error_code:50113}}],has_more:true,next_cursor:"page2"} }));
    const result = await readMinimaxActiveSessions({call});
    expect(result.sessions.map(s=>s.id).sort()).toEqual(["child","root"]);
    expect(result.sessions.find(s=>s.id==="root")?.status).toBe("running");
    expect(result.sessions.find(s=>s.id==="child")?.lineage).toMatchObject({kind:"subagent",parentId:"root"});
    expect(result.receipt).toMatchObject({exhaustive:true,totalSessions:3,pages:3});
    expect(call.mock.calls.every(([method])=>method==="GET")).toBe(true);
  });
  it("does not report an empty complete result on unavailable, malformed, or unknown native state", async () => {
    await expect(readMinimaxActiveSessions({call:async()=>({ok:false,status:0,body:null})})).rejects.toThrow();
    await expect(readMinimaxActiveSessions({call:async()=>({ok:true,status:200,body:{}})})).rejects.toThrow();
    const call=async(_m:string,p:string)=>({ok:true,status:200,body:p==="/agent"?{agents:[{name:"mavis"}]}:{sessions:[{session_id:"x",status:{status_type:99}}],has_more:false}});
    await expect(readMinimaxActiveSessions({call})).rejects.toThrow("status_unknown");
  });
  it("rejects repeating pagination instead of silently truncating active sessions", async () => {
    const call=async(_m:string,p:string)=>({ok:true,status:200,body:p==="/agent"?{agents:[{name:"mavis"}]}:{sessions:[],has_more:true,next_cursor:"repeat"}});
    await expect(readMinimaxActiveSessions({call})).rejects.toThrow("cursor_invalid");
  });
});
