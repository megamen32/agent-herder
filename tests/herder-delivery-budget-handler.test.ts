import { expect,it,vi } from 'vitest';
import { handleDeliver, handleSendMessage } from '../src/mcp-tools/handlers.js';
import type { AgentSession,HarnessAdapter } from '../src/types/index.js';
// Focused integration; catches cached inactive result suppressing activation; expected <1s/max5s.
it('rechecks a skipped input and admits it once when activation changes',async()=>{
 const session:AgentSession={id:'target',harness:'opencode',status:'idle',title:'owner',cwd:'/fixture',lastActivity:new Date().toISOString(),needsPermission:false};
 const send=vi.fn(async()=>({ok:true,admitted:true,inputId:'one'}));
 const adapter:HarnessAdapter={type:'opencode',name:'fixture',async init(){},async listSessions(){return[session]},async getSession(){return session},sendMessage:send,async stopSession(){return{ok:true}},async respondPermission(){return{ok:true}},async setPermissions(){return{ok:true}}};
 const adapters=new Map([['opencode',adapter]]);
 const input={sessionId:'target',harness:'opencode',message:'decision',inputId:'one',mode:'queue'};
 expect(JSON.parse(await handleDeliver(adapters,{...input,activation:'if_running'})).delivery).toBe('skipped_inactive');
 expect(JSON.parse(await handleDeliver(adapters,{...input,activation:'always'}))).toMatchObject({ok:true});
 expect(send).toHaveBeenCalledTimes(1);
});
it('returns a compact receipt without echoing the prompt through the registered handler',async()=>{
 const session:AgentSession={id:'target',harness:'opencode',status:'idle',title:'owner',cwd:'/fixture',lastActivity:new Date().toISOString(),needsPermission:false};
 const adapter:HarnessAdapter={type:'opencode',name:'fixture',async init(){},async listSessions(){return[session]},async getSession(){return session},async sendMessage(){return{ok:true,admitted:true,inputId:'one'}},async stopSession(){return{ok:true}},async respondPermission(){return{ok:true}},async setPermissions(){return{ok:true}}};
 const prompt='sensitive-work-context-'.repeat(100);
 const result=await handleSendMessage(new Map([['opencode',adapter]]),{sessionId:'target',harness:'opencode',message:prompt,inputId:'compact',mode:'queue'});
 expect(result).not.toContain(prompt);expect(result.length).toBeLessThan(250);
});
