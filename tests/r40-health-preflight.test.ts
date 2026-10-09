import { it, expect } from 'vitest';
import { createWebServer } from '../src/web/server.js';
import type { HarnessAdapter } from '../src/types/index.js';
it('rejects unavailable native subscription model before creating a session',async()=>{
 let creates=0;
 const adapter={type:'opencode',name:'OpenCode',async init(){},async listSessions(){return []},async listModels(){return ['omniroute/auto/minimax']},async createSession(){creates++;throw new Error('must not create')}} as unknown as HarnessAdapter;
 const server=createWebServer({adapters:new Map([['opencode',adapter]]),converter:{async convert(){throw new Error('unused')}}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try {const addr=server.address();if(!addr||typeof addr==='string')throw Error('bind');
 const response=await fetch(`http://127.0.0.1:${addr.port}/api/health/remediation`,{method:'POST',body:JSON.stringify({incident_id:'r40-preflight',plan_id:'repair',harness:'opencode',name:'r40',cwd:'/tmp',message:'Read only.',execution:{runtime:'opencode',provider:'minimax-coding-plan',model:'MiniMax-M3.1-Flash-Preview',reasoning:'default',topic:'health'}})});
 expect(response.status).toBe(409);expect((await response.json()).error).toContain('no provider fallback');expect(creates).toBe(0);
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
