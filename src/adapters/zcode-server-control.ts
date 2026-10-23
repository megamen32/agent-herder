import {connect} from 'node:net';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
export interface ZcodeOfficialTask {sessionId:string;workspacePath:string;workspaceIdentity?:string}
export interface ZcodeOfficialRunning {observedAt:string;expiresAt:string;pid:number;generation:number;tasks:ZcodeOfficialTask[]}
/** Supported supervisor control, read-only commands only. Never starts a server,
 * attaches a Desktop, loads a workspace or sends an input. */
export async function readZcodeOfficialRunning(socketPath=join(homedir(),'.zcode/server/run/control.sock')):Promise<ZcodeOfficialRunning>{
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
 const observedAt=new Date().toISOString();
 return {observedAt,expiresAt:new Date(Date.now()+15000).toISOString(),pid:after.pid,generation:after.generation,tasks:tasks.map(t=>({sessionId:t.sessionId,workspacePath:t.workspacePath,...(t.workspaceIdentity?{workspaceIdentity:t.workspaceIdentity}:{})}))};
}
