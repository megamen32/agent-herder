import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { readMinimaxActiveSessions } from "../src/adapters/minimax-code-active.js";
it.skipIf(!process.env.MINIMAX_ACTIVE_PROBE_URL)("reads fresh native activity repeatedly without historical metadata enumeration", async () => {
  const paths:string[]=[],cycles:unknown[]=[];
  const control={call:async(method:string,path:string)=>{
    paths.push(path);const r=await fetch(process.env.MINIMAX_ACTIVE_PROBE_URL+path,{method});
    return {ok:r.ok,status:r.status,body:await r.json()};
  }};
  const readRuntimeCandidateIds=async()=>process.env.MINIMAX_ACTIVE_PROBE_SSH ? JSON.parse(execFileSync("ssh",["-o","BatchMode=yes","-p","2222","user@127.0.0.1", "python3 -c \"import sqlite3,os,json;d=sqlite3.connect('file:'+os.path.expanduser('~/.minimax/v2/sqlite/runtime-state.sqlite')+'?mode=ro',uri=True);print(json.dumps([r[0] for r in d.execute(\\\"select distinct session_id from local_runtime_turn_ingress where status='accepted'\\\")]))\""],{encoding:"utf8",timeout:5000})) : JSON.parse(await readFile(process.env.MINIMAX_ACTIVE_PROBE_CANDIDATES!,"utf8"));
  for(let pass=0;pass<4;pass++){
    const started=performance.now(),before=paths.length;
    const result=await readMinimaxActiveSessions(control,{readRuntimeCandidateIds});
    expect(result.receipt.exhaustive).toBe(true);expect(result.sessions.every(s=>s.status==="running")).toBe(true);
    const elapsedMs=Math.round(performance.now()-started);expect(elapsedMs).toBeLessThan(5000);
    cycles.push({receipt:result.receipt,elapsedMs,count:result.sessions.length,metadataReads:paths.slice(before).filter(p=>!p.endsWith("turn-continuation")).length,ids:result.sessions.map(s=>s.id)});
  }
  expect(paths.some(p=>p.startsWith("/agent"))).toBe(false);
  await writeFile("/home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261023-fleet-session-search/minimax-active-metadata-cache-live.json",JSON.stringify({cycles},null,2));
},30000);
