import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ZcodeAdapter} from '../src/adapters/zcode.js';
it('current official supervisor run overrides historical completed in active, historical and exact-ID reads without starting old stdio',async()=>{
 const root=await mkdtemp(join(tmpdir(),'zcode-official-'));const path=join(root,'tasks.sqlite');
 const db=new DatabaseSync(path);db.exec('create table tasks(task_id text,workspace_path text,title text,task_status text,model text,created_at integer,updated_at integer,deleted integer,archived integer)');
 db.prepare('insert into tasks values(?,?,?,?,?,?,?,?,?)').run('known',root,'Current task','completed',null,1,2,0,0);db.close();
 const native=new DatabaseSync(join(root,'absent.sqlite'));native.exec('create table session(id text,directory text,parent_id text,time_updated integer)');native.prepare('insert into session values(?,?,?,?)').run('known',root,null,2);native.close();
 let reads=0;let running=true;const at=new Date().toISOString();
 const adapter=new ZcodeAdapter({client:{start:async()=>{throw Error('must not start old instance')},call:async()=>{throw Error('must not call old instance')},close:async()=>{}},tasksIndexDbPath:path,localDbPath:join(root,'absent.sqlite'),readOfficialRunningTasks:async()=>{reads++;return {observedAt:at,expiresAt:new Date(Date.now()+15000).toISOString(),pid:123,generation:1,tasks:running?[{sessionId:'known',workspacePath:root,workspaceIdentity:'remote:server:serverid:'+root}]:[]}}});
 try {
  expect(await adapter.listActiveSessions()).toMatchObject([{id:'known',status:'running',meta:{activityEvidence:'zcode-official-supervisor-running-tasks',nativeRuntimePid:123,deliveryRoute:'official-server-unverified'}}]);
  expect((await adapter.listSessions()).find(s=>s.id==='known')?.status).toBe('running');
  expect((await adapter.getSession('known'))?.status).toBe('running');
  expect(reads).toBe(1);
  running=false;expect(await adapter.listActiveSessions()).toEqual([]);
  expect((await adapter.listSessions()).find(s=>s.id==='known')?.status).toBe('stopped');
  // query readers use owner cache, not socket/history scans
 }finally{await adapter.dispose();await rm(root,{recursive:true,force:true})}
});

it('uses only documented readonly control commands and rejects changing owner generations',async()=>{
 const {createServer}=await import('node:net');const {readZcodeOfficialRunning}=await import('../src/adapters/zcode-server-control.js');
 const root=await mkdtemp(join(tmpdir(),'zctl-'));const path=join(root,'s');let generation=1,changing=false;const seen:string[]=[];
 const server=createServer(socket=>{socket.once('data',raw=>{const r=JSON.parse(String(raw));seen.push(r.command);const result=r.command==='running-tasks'?[{sessionId:'live',workspacePath:'/repo',workspaceIdentity:'remote:server:id:/repo'}]:{state:'ready',pid:123,generation:changing?generation++:generation};socket.end(JSON.stringify({id:r.id,ok:true,result})+'\n');});});
 await new Promise<void>(resolve=>server.listen(path,resolve));
 try{expect(await readZcodeOfficialRunning(path)).toMatchObject({pid:123,tasks:[{sessionId:'live',workspacePath:'/repo'}]});expect(seen).toEqual(['status','running-tasks','status']);changing=true;await expect(readZcodeOfficialRunning(path)).rejects.toThrow('generation_changed');}
 finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true})}
});

it.skipIf(!process.env.ZCODE_OFFICIAL_PROBE)('reads the actual official owner without starting or sending to any native runtime',async()=>{
 const {readZcodeOfficialRunning}=await import('../src/adapters/zcode-server-control.js');const {writeFile}=await import('node:fs/promises');
 const snapshot=await readZcodeOfficialRunning();const adapter=new ZcodeAdapter({client:{start:async()=>{throw Error('activation forbidden')},call:async()=>{throw Error('native call forbidden')},close:async()=>{}},tasksIndexDbPath:process.env.HOME+'/.zcode/v2/tasks-index.sqlite',localDbPath:process.env.HOME+'/.zcode/cli/db/db.sqlite',readOfficialRunningTasks:async()=>snapshot});
 try{const active=await adapter.listActiveSessions();const listed=await adapter.listSessions();const target='session_b38b92e45be8939782ee5863251407b4';
  for(const task of snapshot.tasks)expect(active.some(s=>s.id===task.sessionId)).toBe(true);
  const selected=listed.find(s=>s.id===target);if(snapshot.tasks.some(t=>t.sessionId===target))expect(selected?.status).toBe('running');
  await writeFile(process.env.ZCODE_OFFICIAL_PROBE_RECEIPT!,JSON.stringify({observedAt:snapshot.observedAt,pid:snapshot.pid,generation:snapshot.generation,nativeIds:snapshot.tasks.map(t=>t.sessionId),activeIds:active.map(s=>s.id),target:selected?{id:selected.id,status:selected.status,title:selected.title,cwd:selected.cwd,meta:selected.meta}:null,receipt:adapter.getActiveSessionSnapshotReceipt()},null,2));
 }finally{await adapter.dispose();}
});
