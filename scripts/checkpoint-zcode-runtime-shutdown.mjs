#!/usr/bin/env node
// First-upgrade and future ExecStop seam: existing HTTP observation + existing
// locked stop-attribution store. No input/resume/control/phone operations.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2);
const deadline=Date.now()+30000;
const checkDeadline=()=>{if(Date.now()>deadline)throw Error('Checkpoint incomplete: 30 second deadline');};
const value=name=>{const at=args.indexOf(name);return at<0?undefined:args[at+1];};
const dryRun=args.includes('--dry-run');
const moduleRoot=resolve(value('--module-root')??'dist');
const {HumanStopStore}=await import(pathToFileURL(join(moduleRoot,'human-stop-store.js')).href);
const {ownedZcodeActiveInput}=await import(pathToFileURL(join(moduleRoot,'adapters/zcode-recovery-boundary.js')).href);
const pid=Number(execFileSync('systemctl',['--user','show','agent-herder.service','-p','MainPID','--value'],{encoding:'utf8',timeout:5000}).trim());
if(!Number.isSafeInteger(pid)||pid<=0)throw Error('Existing Herder controller is not active');
const environment=Object.fromEntries((await readFile(`/proc/${pid}/environ`)).toString().split('\0').filter(v=>v.includes('=')).map(v=>{const i=v.indexOf('=');return[v.slice(0,i),v.slice(i+1)];}));
const base=environment.AGENT_HERDER_AUTOPILOT_STATE_DIR;
if(!base&&!environment.AGENT_HERDER_UNFINISHED_SESSION_STORE)throw Error('Existing durable state path is unknown');
const unfinished=JSON.parse(await readFile(environment.AGENT_HERDER_UNFINISHED_SESSION_STORE??join(base,'unfinished-sessions.json'),'utf8'));
const stopPath=environment.AGENT_HERDER_HUMAN_STOP_STORE??join(environment.HOME??'/home/roomhacker','.local/state/agent-herder/human-stops.json');
const store=new HumanStopStore(stopPath);
const nativeDb=environment.ZCODE_DB_PATH??join(environment.HOME??'/home/roomhacker','.zcode/cli/db/db.sqlite');
const runtimePids=[];
const {readdir}=await import('node:fs/promises');
for(const item of await readdir('/proc')){
 checkDeadline();
 if(!/^\d+$/.test(item))continue;
 try{
  const cmd=(await readFile(`/proc/${item}/cmdline`)).toString().split('\0');
  if(!cmd.some(x=>x===(environment.ZCODE_SERVER_ENTRY??'/home/roomhacker/.zcode/server/zcode-server.cjs')))continue;
  let parent=Number(item),owned=false;
  for(let i=0;i<20&&parent>1;i++){
   const status=await readFile(`/proc/${parent}/status`,'utf8');parent=Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);
   if(parent===pid){owned=true;break;}
  }
  if(owned)runtimePids.push(Number(item));
 }catch{}
}
if(runtimePids.length!==1)throw Error('Exact owned runtime identity is unknown or ambiguous');
const result={dryRun,controllerPid:pid,runtimePid:runtimePids[0],observedAt:new Date().toISOString(),coverage:'existing-durable-session-identities-only',idleProof:false,checkpointed:[],excluded:[]};
const endpoint=`http://127.0.0.1:${environment.AGENT_HERDER_WEB_PORT??18787}`;
for(const row of unfinished.sessions??[]){
 checkDeadline();
 if(row.harness!=='zcode')continue;
 let reason='native_or_input_ownership_unconfirmed';
 try{
  const response=await fetch(`${endpoint}/api/sessions/zcode/${encodeURIComponent(row.sessionId)}`,{signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw Error('Native observation failed');
  const {session}=await response.json();const m=session?.meta??{};
  if(session?.id===row.sessionId&&session.status==='running'&&m.nativeLoaded===true
    &&typeof m.nativeActiveTurnId==='string'&&(!row.activeTurnId||m.nativeActiveTurnId===row.activeTurnId)&&m.humanStopHeld===false
    &&Array.isArray(m.pendingRequestIds)&&m.pendingRequestIds.length===0
    &&ownedZcodeActiveInput(nativeDb,row.sessionId)){
   const proof={turnId:m.nativeActiveTurnId,controllerPid:pid,runtimePid:runtimePids[0],at:Date.now()};
   if(dryRun||await store.checkpointOwnedZcodeShutdown(row.sessionId,proof)){result.checkpointed.push({sessionId:row.sessionId,...proof});continue;}
   reason='human_hold';
  }
 }catch{}
 result.excluded.push({sessionId:row.sessionId,...(row.activeTurnId?{turnId:row.activeTurnId}:{}),reason});
}
if(Number(execFileSync('systemctl',['--user','show','agent-herder.service','-p','MainPID','--value'],{encoding:'utf8',timeout:5000}).trim())!==pid)throw Error('Controller generation changed during checkpoint');
const receipt=value('--receipt');
if(receipt){await mkdir(dirname(receipt),{recursive:true});await writeFile(receipt,JSON.stringify(result,null,2),{mode:0o600});}
console.log(JSON.stringify(result));
