import {expect,it} from 'vitest';
import {handleDeliver} from '../src/mcp-tools/handlers.js';
import type {HarnessAdapter} from '../src/types/index.js';
// Focused integration; verifies real native IDs survive MCP formatting. Expected <1s/max5s.
it('returns native admission and stable identity for an exact target',async()=>{
 const session={id:'target',harness:'opencode' as const,status:'idle' as const,title:'owner',cwd:'/fixture',lastActivity:new Date().toISOString(),needsPermission:false};
 const adapter:HarnessAdapter={type:'opencode',name:'fixture',async init(){},async listSessions(){return[session]},async getSession(){return session},async sendMessage(){return{ok:true,admitted:true,turnId:'native-turn',inputId:'stable-one'}},async stopSession(){return{ok:true}},async respondPermission(){return{ok:true}},async setPermissions(){return{ok:true}}};
 expect(JSON.parse(await handleDeliver(new Map([['opencode',adapter]]),{harness:'opencode',sessionId:'target',message:'decision',inputId:'stable-one',mode:'queue'}))).toMatchObject({admitted:true,turnId:'native-turn',inputId:'stable-one'});
});
