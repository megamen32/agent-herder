import {describe,expect,it,vi} from 'vitest';
import {registerSessionTools} from '../src/mcp/session-tools.js';
import {HerderEventBus} from '../src/herder-events.js';
import type {McpServer} from '@modelcontextprotocol/server';
import type {SessionQueueControlGateway} from '../src/session-queue-control-gateway.js';

describe('session queue processing MCP tools',()=>{
 it('routes read and CAS action through the same owner gateway',async()=>{
  const handlers:Record<string,(args:any)=>Promise<any>>={};
  const server={registerTool:(name:string,_config:unknown,handler:(args:any)=>Promise<any>)=>{handlers[name]=handler;}} as unknown as McpServer;
  const target={hostId:'server-44',harness:'zcode',sessionId:'session-44'};
  const read=vi.fn(async()=>({target,state:null,canResume:false,humanStopHeld:false,error:'native queue unloaded'}));
  const submit=vi.fn(async(args:any)=>({target,inputId:args.inputId,state:'queued',nonRetryable:false,job:{id:'job-44',state:'queued',resultRef:'herder://jobs/job-44'}}));
  registerSessionTools(server,{adapters:new Map(),jobs:{} as any,events:new HerderEventBus(),sessionQueueControl:{read,submit} as unknown as SessionQueueControlGateway});
  const get=await handlers.session_queue_processing_get!(target);
  expect(get.structuredContent).toMatchObject({target,canResume:false,error:'native queue unloaded'});
  const post=await handlers.session_queue_processing_resume!({...target,inputId:'resume-44',expectedRevision:8});
  expect(post.structuredContent).toMatchObject({target,inputId:'resume-44',state:'queued',job:{id:'job-44'}});
  expect(read).toHaveBeenCalledOnce();expect(submit).toHaveBeenCalledOnce();
 });
});
