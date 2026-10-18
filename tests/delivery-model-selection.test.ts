import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {handleDeliver,handleNewOrResume} from '../src/mcp-tools/handlers.js';
import type {HarnessAdapter,AgentSession} from '../src/types/index.js';

describe('existing deliver model selection',()=>{
 for(const named of [false,true]) {
  function fixture(){
   const id='model-check-'+randomUUID();
   const session:AgentSession={id,harness:'codex',title:id,cwd:process.cwd(),model:'old-model',status:'idle',lastActivity:new Date().toISOString(),needsPermission:false};
   const order:string[]=[];
   const changeModel=vi.fn(async(_id:string,model:string)=>{order.push('model:'+model);session.model=model;return{ok:true};});
   const sendMessage=vi.fn(async()=>{order.push('send:'+session.model);return{ok:true,admitted:true};});
   const adapter:HarnessAdapter={type:'codex',name:'test',init:async()=>{},listSessions:async()=>[session],getSession:async sid=>sid===id?session:null,changeModel,sendMessage,stopSession:async()=>({ok:true}),respondPermission:async()=>({ok:true}),setPermissions:async()=>({ok:true})};
   const args={...(named?{name:id,cwd:process.cwd(),create:'never'}:{sessionId:id}),harness:'codex',activation:'always',mode:'sync',message:'bounded read-only test',model:'chosen-model',inputId:randomUUID()};
   return{adapter,args,session,order,changeModel,sendMessage};
  }
  it(`applies the selected model before ${named?'named':'exact'} delivery`,async()=>{
   const f=fixture();const r=JSON.parse(await handleDeliver(new Map([['codex',f.adapter]]),f.args));
   expect(r.ok).toBe(true);expect(f.order).toEqual(['model:chosen-model','send:chosen-model']);expect(r.requestedModel).toBe('chosen-model');expect(f.sendMessage).toHaveBeenCalledWith(f.session.id,expect.objectContaining({model:'chosen-model'}));
  });
  if (named) it('new_or_resume also sends the explicit model to native inference',async()=>{
   const f=fixture();f.adapter.createSession=vi.fn(async()=>{throw new Error('must reuse exact session');});const result=JSON.parse(await handleNewOrResume(new Map([['codex',f.adapter]]),{
    harness:'codex',name:f.session.title,cwd:f.session.cwd,message:'existing task',model:'chosen-model',mode:'sync',inputId:randomUUID(),
   }));
   expect(result.ok).toBe(true);expect(f.sendMessage).toHaveBeenCalledWith(f.session.id,expect.objectContaining({model:'chosen-model'}));
  });
  it(`does not deliver on failed ${named?'named':'exact'} model selection`,async()=>{
   const f=fixture();f.changeModel.mockResolvedValueOnce({ok:false,error:'model unavailable'} as any);
   const r=JSON.parse(await handleDeliver(new Map([['codex',f.adapter]]),f.args));
   expect(r.ok).toBe(false);expect(r.delivery).toBe('not_attempted');expect(f.sendMessage).not.toHaveBeenCalled();
  });
  it(`does not retune an active ${named?'named':'exact'} target silently`,async()=>{
   const f=fixture();f.session.status='running';
   const r=JSON.parse(await handleDeliver(new Map([['codex',f.adapter]]),f.args));
   expect(r.ok).toBe(false);expect(f.changeModel).not.toHaveBeenCalled();expect(f.sendMessage).not.toHaveBeenCalled();
  });
 }
});
