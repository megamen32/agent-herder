import { describe, expect, it, vi } from 'vitest';
import { listAgentsResult } from '../src/mcp-tools/handlers.js';
import type { HarnessAdapter, AgentSession } from '../src/types/index.js';
// Unit; catches one slow harness suppressing others/incomplete result hidden by filters. <1s/max5s.
it('returns healthy harnesses within a bounded deadline and keeps incompleteness through folder/status filters',async()=>{
 vi.useFakeTimers();
 const session: AgentSession={id:'z',harness:'zcode',status:'running',title:'owner',cwd:'/repo',lastActivity:new Date().toISOString(),needsPermission:false};
 const common={async init(){},async getSession(){return null},async sendMessage(){return{ok:true}},async stopSession(){return{ok:true}},async respondPermission(){return{ok:true}},async setPermissions(){return{ok:true}}};
 const hung={...common,type:'codex',name:'hung',listSessions:()=>new Promise(()=>{})} as HarnessAdapter;
 const healthy={...common,type:'zcode',name:'healthy',async listSessions(){return[session]}} as HarnessAdapter;
 try{
  const pending=listAgentsResult(new Map([['codex',hung],['zcode',healthy]]),{harness:'all',folder:'/repo',status:'running'});
  await vi.advanceTimersByTimeAsync(3100);
  const result=await pending;
  expect(result.sessions.map(s=>s.id)).toEqual(['z']);
  expect(result).toMatchObject({complete:false,unavailable:[{harness:'codex'}]});
 }finally{vi.useRealTimers()}
});
