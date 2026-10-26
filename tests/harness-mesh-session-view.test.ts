import {it,expect,vi} from 'vitest';
import {registerFleetNodeTools} from '../src/mesh/fleet-node.js';
import {hostname} from 'node:os';
function fixture(supervisor:any,adapters=new Map([["codex",{} as any]]),extra:any={}){const callbacks=new Map<string,any>();registerFleetNodeTools({registerTool:(name:string,_schema:any,cb:any)=>{callbacks.set(name,cb);}} as any,{adapters,readSupervisor:supervisor,...extra});return callbacks.get('fleet_session_view');}
it('reads only an explicitly selected exact native ID, latest3/acp, with structured receipt and no history replication',async()=>{const supervisor={getSession:vi.fn(async()=>({id:'n',harness:'codex',title:'t',cwd:'/work'})),getSessionDetails:vi.fn(async()=>({session:{id:'n',harness:'codex',title:'t',cwd:'/work'},history:{source:'acp-load'},messages:[{role:'assistant',text:'answer',meta:{private:'not metadata'}}]}))};const r=await fixture(supervisor)({harness:'codex',sessionId:'n'});expect(r.structuredContent.hostId).toBe(hostname());expect(supervisor.getSessionDetails).toHaveBeenCalledWith('codex','n',{limit:3,quick:true,history:'acp'});expect(JSON.stringify(r)).not.toContain('private');});
it('does not turn history failure into an empty session; exact native metadata is required',async()=>{const supervisor={getSession:vi.fn(async()=>({id:'n',harness:'codex',title:'t',cwd:'/work'})),getSessionDetails:vi.fn(async()=>{throw new Error('unavailable');})};const r=await fixture(supervisor)({harness:'codex',sessionId:'n'});expect(r.structuredContent.details.historyUnavailable).toBe(true);supervisor.getSession.mockResolvedValue({id:'foreign',harness:'codex'} as any);await expect(fixture(supervisor)({harness:'codex',sessionId:'n'})).rejects.toThrow('identity');});

it('distinguishes an absent native session from a conflicting native identity',async()=>{
 const supervisor={getSession:vi.fn(async()=>null),getSessionDetails:vi.fn()};
 await expect(fixture(supervisor)({harness:'codex',sessionId:'missing'})).resolves.toMatchObject({structuredContent:{hostId:hostname(),found:false,reason:'native_session_not_found'}});
 supervisor.getSession.mockResolvedValue({id:'foreign',harness:'codex'} as any);
 await expect(fixture(supervisor)({harness:'codex',sessionId:'requested'})).rejects.toThrow('fleet_session_identity_mismatch');
});

it('routes only the exact explicitly selected host and reports an absent host with its scope',async()=>{
 const call=vi.fn(async()=>({hostId:'MacBook-Pro-User.local',details:{session:{id:'n',harness:'codex',title:'t',cwd:'/work'},historyUnavailable:true,messages:[]}}));
 const read=fixture({getSession:vi.fn(),getSessionDetails:vi.fn()},new Map([["codex",{} as any]]),{
  sessionReadTransport:{call},sessionReadPeers:[{hostId:'MacBook-Pro-User.local',target:'mcp:shell:MacBook-Pro-User.local:AgentHerder'}],
 });
 await expect(read({hostId:'MacBook-Pro-User.local',harness:'codex',sessionId:'n'})).resolves.toMatchObject({structuredContent:{hostId:'MacBook-Pro-User.local',details:{session:{id:'n',harness:'codex'}}}});
 expect(call).toHaveBeenCalledWith('mcp:shell:MacBook-Pro-User.local:AgentHerder','fleet_session_view',{harness:'codex',sessionId:'n'});
 await expect(read({hostId:'MacBook-Pro-User.local.evil',harness:'codex',sessionId:'n'})).resolves.toMatchObject({structuredContent:{hostId:'MacBook-Pro-User.local.evil',available:false,found:null,harness:'codex',sessionId:'n',reason:'native_host_unavailable'}});
 expect(call).toHaveBeenCalledTimes(1);
});

it('fails closed on a cold lazy adapter before any discovery/read/start activation',async()=>{const supervisor={getSession:vi.fn(),getSessionDetails:vi.fn()};const start=vi.fn();const read=fixture(supervisor,new Map([["zcode",{lazyStart:true,isReady:()=>false,start} as any]]));await expect(read({harness:'zcode',sessionId:'n'})).rejects.toThrow('native_not_ready');expect(supervisor.getSession).not.toHaveBeenCalled();expect(supervisor.getSessionDetails).not.toHaveBeenCalled();expect(start).not.toHaveBeenCalled();});
