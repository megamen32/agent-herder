// Focused integration, expected 2s/max20s. Resume must preserve accepted input
// in a loaded native session, and direct cold resume must use its real workspace.
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { ZcodeAdapter } from '../src/adapters/zcode.js';
import { SessionSupervisor } from '../src/session-supervisor.js';
import { HumanStopStore } from '../src/human-stop-store.js';
import type { HarnessAdapter, AgentSession } from '../src/types/index.js';

it.each(['running', 'idle'] as const)('does not reload a loaded %s ZCode session before an explicit continuation', async status => {
 const dir=await mkdtemp(join(tmpdir(),'herder-zcode-resume-'));
 const session:AgentSession={id:'owned',harness:'zcode',status,cwd:dir,title:'fixture',lastActivity:new Date().toISOString(),meta:{nativeLoaded:true}};
 const resume=vi.fn(async()=>({ok:false,error:'Native reload discards accepted queues'}));
 const send=vi.fn(async()=>({ok:true,admitted:true,inputId:'continue-once'}));
 const adapter={type:'zcode',name:'ZCode',async init(){},async getSession(){return session},async listSessions(){return[session]},resumeSession:resume,sendMessage:send} as unknown as HarnessAdapter;
 const supervisor=new SessionSupervisor(new Map([['zcode',adapter]]),{} as any,undefined,{humanStopStore:new HumanStopStore(join(dir,'stops.json'))});
 try {
  expect(await supervisor.resumeSession('zcode','owned','Continue original goal',true,'continue-once')).toMatchObject({ok:true,admitted:true});
  expect(resume).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledExactlyOnceWith('owned',expect.objectContaining({queue:true,origin:'human',inputId:'continue-once'}));
 }finally{await rm(dir,{recursive:true,force:true});}
});

it('resolves the exact persisted workspace before direct cold resume without a preceding list/get',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'herder-zcode-cold-resume-'));const path=join(dir,'native.sqlite');
 const db=new DatabaseSync(path);db.exec('create table session(id text primary key,directory text,workspace_id text)');
 db.prepare('insert into session values(?,?,?)').run('cold-owned','/exact/project',null);db.close();
 const calls:any[]=[];
 const client={async start(){},async close(){},async call(channel:string,method:string,args:any[]){calls.push({channel,method,args});if(method==='resumeSession')return{session:{sessionId:'cold-owned'}};throw Error('Unexpected '+method)}};
 const adapter=new ZcodeAdapter({client,cwd:'/default/project',localDbPath:path,tasksIndexDbPath:'/missing'});
 try{
  expect(await adapter.resumeSession('cold-owned')).toEqual({ok:true});
  expect(calls.find(c=>c.method==='resumeSession')?.args[0]).toMatchObject({sessionId:'cold-owned',workspacePath:'/exact/project'});
  expect(calls.some(c=>['listSessions','createSession','sendPrompt','sendConversationCommandV4'].includes(c.method))).toBe(false);
 }finally{await adapter.dispose();await rm(dir,{recursive:true,force:true});}
});
