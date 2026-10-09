import { expect,it } from 'vitest';
import { createWebServer } from '../src/web/server.js';
import { coordinationNotes } from '../src/coordination-notes.js';
import { deferredMessages } from '../src/deferred-messages.js';
import { listAgentsResult } from '../src/mcp-tools/handlers.js';
// Focused integration; actual HTTP flow preserves workspace and inbox until ack. <1s/max5s.
it('preserves tool workspace across prompt touch and only removes an explicitly acknowledged inbox',async()=>{
 const server=createWebServer({adapters:new Map(),converter:{convert:async()=>({})} as any,supervisor:{isAutomationHeld:async()=>false} as any});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const sessionId='fixture-current-workspace';
 try{
  await fetch(base+'/api/coordination/activity',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({harness:'codex',sessionId,cwd:'/actual',paths:[]})});
  const message=await deferredMessages.add(sessionId,'one needed decision');
  const r=await fetch(base+`/api/coordination/context?harness=codex&sessionId=${sessionId}&cwd=/launch&touch=1&consume=1`);
  const body=await r.json();
  expect(coordinationNotes.activeWorkspaceForSession(sessionId)).toBe('/actual');
  expect(body.inboxIds).toEqual([message.id]);
  expect(await deferredMessages.list(sessionId)).toHaveLength(1);
  await fetch(base+'/api/coordination/inbox-ack',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId,ids:body.inboxIds})});
  expect(await deferredMessages.list(sessionId)).toHaveLength(0);
 }finally{await coordinationNotes.endSession(sessionId);await new Promise<void>(resolve=>server.close(()=>resolve()))}
});
