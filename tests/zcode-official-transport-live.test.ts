import {it,expect} from 'vitest';
import {ZcodeAppServerClient} from '../src/adapters/zcode-protocol.js';
import {connectZcodeOfficialWebSocket,readZcodeOfficialRunning} from '../src/adapters/zcode-server-control.js';
import {ZcodeAdapter} from '../src/adapters/zcode.js';
import {writeFile,readFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
it.skipIf(!process.env.ZCODE_OFFICIAL_WS_READ)('reads exact working session through the reused protocol client and closes only its connection',async()=>{
 const client=new ZcodeAppServerClient({command:'must-not-run',connectWebSocket:connectZcodeOfficialWebSocket});
 const id='session_b38b92e45be8939782ee5863251407b4';const current=await readZcodeOfficialRunning();const task=current.tasks.find(t=>t.sessionId===id);expect(task).toBeDefined();
 try{await client.start();const x=await client.callIfReady('zcode-agent','readSession',[{...task,workspaceKey:task!.workspaceIdentity,runtimePolicy:'existing-only',messageLimit:1}]) as any;expect(x.session.sessionId).toBe(id);expect(x.runtime.activeTurnId).toBeTruthy();expect(client.getOwnedProcessId()).toBeUndefined();}
 finally{await client.close();}
 expect((await readZcodeOfficialRunning()).tasks.some(t=>t.sessionId===id)).toBe(true);
});
it.skipIf(!process.env.ZCODE_OFFICIAL_WS_CANARY)('admits one harmless marker in an isolated own native session and never replays it',async()=>{
 const receiptPath=process.env.ZCODE_OFFICIAL_WS_CANARY_RECEIPT!;
 try{await readFile(receiptPath);throw Error('Existing canary receipt: do not repeat');}catch(e){if((e as any).code!=='ENOENT')throw e;}
 const cwd=await mkdtemp(join(tmpdir(),'herder-zcode-ws-'));const inputId='herder-ws-'+randomUUID();const marker='HERDER_ZCODE_WS_20261023_OK';
 const receipt:any={at:new Date().toISOString(),cwd,inputId,phase:'before_create',marker};const save=()=>writeFile(receiptPath,JSON.stringify(receipt,null,2),{mode:0o600});await save();
 const client=new ZcodeAppServerClient({command:'must-not-run',connectWebSocket:connectZcodeOfficialWebSocket});
 const adapter=new ZcodeAdapter({client,cwd});
 try{const session=await adapter.createSession({name:'health_herder_ws_transport_20261023',cwd});receipt.sessionId=session.id;receipt.phase='created_before_send';await save();
  const sent=await adapter.sendMessage(session.id,{message:`Ответь ровно ${marker}. Не используй инструменты и не меняй файлы.`,queue:true,inputId,origin:'human'});receipt.sendReceipt=sent;receipt.phase='send_returned_no_replay';await save();
  expect(sent.ok).toBe(true);
  for(let i=0;i<45;i++){await new Promise(r=>setTimeout(r,1000));const x=await client.callIfReady('zcode-agent','readSession',[{workspacePath:cwd,workspaceIdentity:cwd,workspaceKey:cwd,sessionId:session.id,runtimePolicy:'existing-only',messageLimit:10}]) as any;
   const messages=Array.isArray(x.messages)?x.messages:[];const matched=messages.some((m:any)=>(m.info?.role??m.role)==='assistant'&&JSON.stringify(m).includes(marker));
   if(matched&&!x.runtime?.activeTurnId){receipt.phase='consumer_marker_observed';receipt.completedAt=new Date().toISOString();receipt.runtime={eventSeq:x.runtime?.eventSeq,stateRevision:x.runtime?.stateRevision,activeTurnId:x.runtime?.activeTurnId};await save();break;}
  }
  expect(receipt.phase).toBe('consumer_marker_observed');
 }catch(e){receipt.errorType=(e as any).name;receipt.phase+=':failed';await save();throw e;}
 finally{await adapter.dispose();}
},60000);
