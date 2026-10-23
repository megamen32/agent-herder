import {describe,it,expect,vi} from 'vitest';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {McpServer} from '@modelcontextprotocol/server';
import {hostname} from 'node:os';
import {registerFleetNodeTools} from '../src/mesh/fleet-node.js';

const readiness={
  state:'ready' as const,projectId:'Олег и Никита',projectRoot:'/work/integrator',rootIdentity:'["/work/integrator",1,2]',
  policyRevision:'etag-1',hostId:hostname(),harness:'codex' as const,harnessVersion:'codex-cli 0.162.1',model:'gpt-6-luna',
  requiredTools:['web_search'],availableTools:['web_search'],availableModels:['gpt-6-luna'],resourceReady:true,
  runtimeInstanceId:'runtime-1',cwd:'/work/integrator',
  pathResolution:{requestedCwd:'/work/integrator',canonicalCwd:'/work/integrator',rootPath:'/work/integrator',contained:true,identityMatches:true},
  observedAtMs:Date.now(),
};

async function connect(runtime:unknown,ownerJournal:unknown){
  const server=new McpServer({name:'local-herder',version:'1'});
  registerFleetNodeTools(server,{adapters:new Map(),integratorRuntime:runtime as any,ownerJournal:ownerJournal as any});
  const client=new Client({name:'fleet-consumer',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();
  await server.connect(st);await client.connect(ct);
  return {client,server};
}

describe('fleet_create_session routes the selected harness (harness-aware project create)',()=>{
  it('hands the selected harness to the runtime and skips the codex readiness contract for another harness',async()=>{
    const create=vi.fn(async(input:any)=>({state:'not_attempted',inputId:input.inputId,retryable:false,reason:'project_route_harness_unavailable'}));
    const runtime={readiness:vi.fn(async()=>readiness),validateReadiness:vi.fn(async()=>true),create};
    const ownerJournal={once:vi.fn(async(_request:any,operation:any)=>operation())};
    const {client,server}=await connect(runtime,ownerJournal);
    try{
      const result=await client.callTool({name:'fleet_create_session',arguments:{inputId:'c'.repeat(64),harness:'opencode',name:'research',cwd:'/work/integrator',project:'Олег и Никита'}});
      expect(create,JSON.stringify(result)).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][0].harness).toBe('opencode');
      expect(runtime.validateReadiness).not.toHaveBeenCalled();
      // An unprepared harness is refused with the concrete reason of the runtime, not silently.
      expect(result.structuredContent).toMatchObject({state:'not_attempted',reason:'project_route_harness_unavailable'});
    }finally{await client.close();await server.close();}
  });
  it('keeps the codex readiness gate and hands codex to the runtime',async()=>{
    const create=vi.fn(async(input:any)=>({state:'created',inputId:input.inputId,address:{hostId:hostname(),harness:'codex',nativeSessionId:'sess-1'},launchCwd:'/work/integrator',retryable:false}));
    const runtime={readiness:vi.fn(async()=>readiness),validateReadiness:vi.fn(async()=>true),create};
    const ownerJournal={once:vi.fn(async(_request:any,operation:any)=>operation())};
    const {client,server}=await connect(runtime,ownerJournal);
    try{
      const result=await client.callTool({name:'fleet_create_session',arguments:{inputId:'d'.repeat(64),harness:'codex',name:'research',cwd:'/work/integrator',model:'gpt-6-luna',project:'Олег и Никита',projectReadinessContract:'integrator-host-readiness-v1',projectReadiness:readiness}});
      expect(result.structuredContent).toMatchObject({ok:true,created:true,harness:'codex',sessionId:'sess-1'});
      expect(create.mock.calls[0][0].harness).toBe('codex');
    }finally{await client.close();await server.close();}
  });
  it('refuses a codex project create before durable intent when the readiness is not validated',async()=>{
    const runtime={readiness:vi.fn(async()=>readiness),validateReadiness:vi.fn(async()=>false),create:vi.fn()};
    const ownerJournal={once:vi.fn()};
    const {client,server}=await connect(runtime,ownerJournal);
    try{
      const result=await client.callTool({name:'fleet_create_session',arguments:{inputId:'e'.repeat(64),harness:'codex',name:'research',cwd:'/work/integrator',model:'gpt-6-luna',project:'Олег и Никита',projectReadinessContract:'integrator-host-readiness-v1',projectReadiness:readiness}});
      expect(result.structuredContent).toMatchObject({state:'not_attempted',reason:'project_readiness_not_validated'});
      expect(ownerJournal.once).not.toHaveBeenCalled();
      expect(runtime.create).not.toHaveBeenCalled();
    }finally{await client.close();await server.close();}
  });
  it('names the missing project runtime instead of refusing a harness silently',async()=>{
    const ownerJournal={once:vi.fn(async(_request:any,operation:any)=>operation())};
    const {client,server}=await connect(undefined,ownerJournal);
    try{
      const result=await client.callTool({name:'fleet_create_session',arguments:{inputId:'f'.repeat(64),harness:'opencode',name:'research',cwd:'/work/integrator',project:'Олег и Никита'}});
      expect(result.structuredContent).toMatchObject({state:'not_attempted',reason:'project_scoped_create_unavailable'});
    }finally{await client.close();await server.close();}
  });
  it('accepts a readiness snapshot of the selected harness instead of refusing it on the codex literal',async()=>{
    const create=vi.fn(async(input:any)=>({state:'not_attempted',inputId:input.inputId,retryable:false,reason:'project_route_harness_unavailable'}));
    const runtime={readiness:vi.fn(async()=>readiness),validateReadiness:vi.fn(async()=>true),create};
    const ownerJournal={once:vi.fn(async(_request:any,operation:any)=>operation())};
    const {client,server}=await connect(runtime,ownerJournal);
    try{
      const result=await client.callTool({name:'fleet_create_session',arguments:{inputId:'a'.repeat(64),harness:'opencode',name:'research',cwd:'/work/integrator',project:'Олег и Никита',projectReadinessContract:'integrator-host-readiness-v1',projectReadiness:{...readiness,harness:'opencode',model:'glm-5'}}});
      expect(create,JSON.stringify(result)).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][0].harness).toBe('opencode');
      expect(result.structuredContent).toMatchObject({state:'not_attempted',reason:'project_route_harness_unavailable'});
    }finally{await client.close();await server.close();}
  });
});
