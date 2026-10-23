import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { readMinimaxActiveSessions } from "../src/adapters/minimax-code-active.js";
it.skipIf(!process.env.MINIMAX_ACTIVE_PROBE_URL)("reads the actual native metadata endpoint without changing sessions", async () => {
  const started=performance.now();
  const result=await readMinimaxActiveSessions({call:async(method,path)=>{
    const r=await fetch(process.env.MINIMAX_ACTIVE_PROBE_URL+path,{method});
    return {ok:r.ok,status:r.status,body:await r.json()};
  }});
  expect(result.receipt.exhaustive).toBe(true);
  expect(result.sessions.every(s=>s.status==="running")).toBe(true);
  await writeFile("/tmp/minimax-active-helper-live-20261023.json", JSON.stringify({receipt:result.receipt,elapsedMs:Math.round(performance.now()-started),count:result.sessions.length,roots:result.sessions.filter(s=>s.meta?.lineageKind==="root").length,children:result.sessions.filter(s=>s.meta?.lineageKind==="subagent").length,ids:result.sessions.map(s=>s.id)}));
},15000);
