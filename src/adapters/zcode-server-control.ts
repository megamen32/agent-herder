import {connect} from 'node:net';
import {readFile} from 'node:fs/promises';
import WebSocket from 'ws';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
export interface ZcodeOfficialTask {sessionId:string;workspacePath:string;workspaceIdentity?:string;parentSessionId?:string;parentKnown?:boolean}
export interface ZcodeOfficialRunning {observedAt:string;expiresAt:string;pid:number;generation:number;tasks:ZcodeOfficialTask[]}
/** Supported supervisor control, read-only commands only. Never starts a server,
 * attaches a Desktop, loads a workspace or sends an input. */
export async function readZcodeOfficialRunning(socketPath=join(homedir(),'.zcode/server/run/control.sock'),nativeDbPath=process.env.ZCODE_DB_PATH||join(homedir(),'.zcode/cli/db/db.sqlite')):Promise<ZcodeOfficialRunning>{
 const request=(command:'status'|'running-tasks')=>new Promise<any>((resolve,reject)=>{
  const id=randomUUID(),socket=connect(socketPath);let buffer='';
  const timer=setTimeout(()=>socket.destroy(new Error('zcode_official_control_deadline')),1500);
  const done=()=>{clearTimeout(timer);socket.destroy();};
  socket.once('error',error=>{done();reject(error);});
  socket.once('connect',()=>socket.write(JSON.stringify({id,command})+'\n'));
  socket.setEncoding('utf8');socket.on('data',chunk=>{
   buffer+=chunk;if(Buffer.byteLength(buffer)>1024*1024){done();reject(new Error('zcode_official_control_response_limit'));return;}
   const end=buffer.indexOf('\n');if(end<0)return;
   try{const value=JSON.parse(buffer.slice(0,end));if(value.id!==id||value.ok!==true)throw Error('zcode_official_control_rejected');done();resolve(value.result);}catch(error){done();reject(error);}
  });
  socket.once('close',()=>{done();reject(new Error('zcode_official_control_closed'));});
 });
 const before=await request('status');
 if(before?.state!=='ready'||!Number.isSafeInteger(before.pid)||before.pid<=0||!Number.isSafeInteger(before.generation))throw Error('zcode_official_runtime_not_ready');
 const tasks=await request('running-tasks');const after=await request('status');
 if(after.state!=='ready'||after.pid!==before.pid||after.generation!==before.generation)throw Error('zcode_official_runtime_generation_changed');
 if(!Array.isArray(tasks)||tasks.some(t=>!t||typeof t.sessionId!=='string'||!t.sessionId||typeof t.workspacePath!=='string'||!t.workspacePath.startsWith('/')||(t.workspaceIdentity!==undefined&&typeof t.workspaceIdentity!=='string')))throw Error('zcode_official_running_tasks_invalid');
 const lineage=new Map<string,{parent_id:string|null;directory:string}>();
 try{const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(nativeDbPath,{readOnly:true});
  try{for(const row of db.prepare('select id,parent_id,directory from session where id in (select value from json_each(?))').all(JSON.stringify(tasks.map(t=>t.sessionId))) as Array<{id:string;parent_id:string|null;directory:string}>)lineage.set(row.id,row);}finally{db.close();}
 }catch{/* Missing lineage is unknown; it never erases current running proof. */}
 const observedAt=new Date().toISOString();
 return {observedAt,expiresAt:new Date(Date.now()+15000).toISOString(),pid:after.pid,generation:after.generation,tasks:tasks.map(t=>{const parent=lineage.get(t.sessionId);const known=parent&&typeof parent.directory==='string'&&resolve(parent.directory)===resolve(t.workspacePath);return {sessionId:t.sessionId,workspacePath:t.workspacePath,...(t.workspaceIdentity?{workspaceIdentity:t.workspaceIdentity}:{}),...(known?{parentKnown:true,...(typeof parent.parent_id==='string'&&parent.parent_id?{parentSessionId:parent.parent_id}:{})}:{parentKnown:false})};})};
}

/** Official authenticated attach seam. Capability lifetime is native-owned;
 * secrets stay in memory and no session input is sent by this connection. */
export async function connectZcodeOfficialWebSocket():Promise<WebSocket>{
 const root=join(homedir(),'.zcode/server/run');
 const status=JSON.parse(await readFile(join(root,'status.json'),'utf8'));
 if(status.state!=='ready'||status.host!=='127.0.0.1'||!Number.isInteger(status.port)||status.port<1||status.port>65535)throw Error('zcode_official_server_not_ready');
 const token=(await readFile(join(root,'ingress-token'),'utf8')).trim();
 const response=await fetch(`http://127.0.0.1:${status.port}/api/rpc-host-capability`,{method:'POST',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(1500)});
 if(!response.ok)throw Error('zcode_official_host_capability_unavailable');
 const capability=await response.json() as {capability?:string};if(!capability.capability)throw Error('zcode_official_host_capability_invalid');
 return new WebSocket(`ws://127.0.0.1:${status.port}/ws/host`,{headers:{Authorization:'Bearer '+token,'x-zcode-rpc-host-capability':capability.capability}});
}
