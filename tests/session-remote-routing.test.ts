import {expect,it,vi} from 'vitest';
import {registerSessionTools} from '../src/mcp/session-tools.js';
import {HerderEventBus} from '../src/herder-events.js';
import {HerderJobRegistry} from '../src/herder-jobs.js';
const hostId='MacBook-Pro-User.local';
function setup(call:any,adapter:any={}){
 const tools=new Map<string,any>(),events=new HerderEventBus();
 registerSessionTools({registerTool:(name:string,schema:any,handler:any)=>tools.set(name,{schema,handler})} as any,{adapters:new Map([['minimax-code',adapter]]),jobs:new HerderJobRegistry(events),events,transport:{call} as any,integratorRuntime:{adapterForSession:async()=>({kind:'ordinary'})} as any});
 return async(name:string,args:any)=>{const tool=tools.get(name);return tool.handler(tool.schema.inputSchema.parse(args));};
}
it('lists the explicitly selected canonical remote owner instead of filtering local sessions',async()=>{
 const row={id:'mvs_remote',harness:'minimax-code',hostId,status:'idle',title:'LastHumanCommit',cwd:'/Users/user',lastActivity:'now',needsPermission:false};
 const call=vi.fn(async()=>({structuredContent:{complete:true,unavailable:[],sessions:[row],total:1,limited:false,filters:{harness:'minimax-code',status:'all',includeLastMessage:false}}}));
 const run=setup(call,{type:'minimax-code',listSessions:vi.fn(()=>{throw Error('local_read_forbidden');})});
 const r=await run('list_agents',{hostId:hostId.toLowerCase(),harness:'minimax-code',status:'all',limit:30});
 expect(r.structuredContent.sessions).toEqual([row]);expect(r.structuredContent.filters.hostId).toBe(hostId);
 expect(call).toHaveBeenCalledWith('mcp:shell:'+hostId+':AgentHerder','list_agents',expect.not.objectContaining({hostId:expect.anything()}));
});
it('forwards an explicit remote user steer once with its stable input and exact receipt',async()=>{
 const receipt={content:[{type:'text',text:'Native admission receipt: admitted=true inputId=user-1'}]};const call=vi.fn(async()=>receipt),run=setup(call);
 expect(await run('send_message',{hostId:hostId.toLowerCase(),harness:'minimax-code',sessionId:'mvs_remote',humanRequested:true,inputId:'user-1',mode:'steer',message:'Поручение'})).toEqual(receipt);
 expect(call).toHaveBeenCalledTimes(1);expect(call).toHaveBeenCalledWith('mcp:shell:'+hostId+':AgentHerder','send_message',expect.objectContaining({humanRequested:true,inputId:'user-1',mode:'steer',message:'Поручение'}));
 expect(call.mock.calls[0][2]).not.toHaveProperty('hostId');
});
it('labels a human-requested local message as a relayed user instruction',async()=>{
 const session={id:'mvs_local',harness:'minimax-code',status:'idle',title:'Local',cwd:'/tmp',lastActivity:'now',needsPermission:false};
 const sendMessage=vi.fn(async()=>({ok:true,admitted:true,inputId:'human-1',turnId:'native-turn'}));
 const run=setup(vi.fn(),{type:'minimax-code',getSession:async()=>session,sendMessage});
 await run('send_message',{harness:'minimax-code',sessionId:session.id,humanRequested:true,inputId:'human-1',mode:'steer',message:'Несколько результатов'});
 expect(sendMessage.mock.calls[0][1].message).toContain('Поручение пользователя, переданное агентом');
 expect(sendMessage.mock.calls[0][1].message).not.toContain('Отправитель неизвестен');
 await run('send_message',{harness:'minimax-code',sessionId:session.id,humanRequested:true,inputId:'human-2',fromSessionId:session.id,fromHarness:'minimax-code',message:'Уточнение'});
 expect(sendMessage.mock.calls[1][1].message).toContain('Поручение пользователя, переданное агентом');
 expect(sendMessage.mock.calls[1][1].message).toContain(session.id);
});
it('does not retry an uncertain remote admission',async()=>{
 const call=vi.fn(async()=>{throw Error('direct_deadline');});const run=setup(call);
 const result=await run('send_message',{hostId,harness:'minimax-code',sessionId:'mvs_remote',humanRequested:true,inputId:'unknown-once',message:'Task'});
 expect(JSON.parse(result.content[0].text)).toMatchObject({delivery:'unknown',inputId:'unknown-once',admissionUnknown:true,nonRetryable:true});
 expect(call).toHaveBeenCalledTimes(1);
});
it('rejects a remote list with another host identity',async()=>{
 const call=vi.fn(async()=>({structuredContent:{complete:true,unavailable:[],sessions:[{id:'x',harness:'minimax-code',hostId:'other',status:'idle',title:'t',cwd:'/tmp',lastActivity:'now',needsPermission:false}],total:1,limited:false}}));
 await expect(setup(call)('list_agents',{hostId,harness:'minimax-code'})).rejects.toThrow('remote_session_identity_mismatch');
});
