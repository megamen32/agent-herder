#!/usr/bin/env node
// First-upgrade and future ExecStop seam: existing HTTP observation + existing
// locked stop-attribution store. No input/resume/control/phone operations.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,dirname,resolve,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const args=process.argv.slice(2);
const deadline=Date.now()+30000;
const checkDeadline=()=>{if(Date.now()>deadline)throw Error('Checkpoint incomplete: 30 second deadline');};
const value=name=>{const at=args.indexOf(name);return at<0?undefined:args[at+1];};
const dryRun=args.includes('--dry-run');
const moduleRoot=resolve(value('--module-root')??'dist');
const {HumanStopStore}=await import(pathToFileURL(join(moduleRoot,'human-stop-store.js')).href);
const {zcodeShutdownObservation,zcodeConfirmedCrashBoundary}=await import(pathToFileURL(join(moduleRoot,'adapters/zcode-recovery-boundary.js')).href);
const pid=Number(execFileSync('systemctl',['--user','show','agent-herder.service','-p','MainPID','--value'],{encoding:'utf8',timeout:5000}).trim());
if(!Number.isSafeInteger(pid)||pid<=0)throw Error('Existing Herder controller is not active');
const environment=Object.fromEntries((await readFile(`/proc/${pid}/environ`)).toString().split('\0').filter(v=>v.includes('=')).map(v=>{const i=v.indexOf('=');return[v.slice(0,i),v.slice(i+1)];}));
const base=environment.AGENT_HERDER_AUTOPILOT_STATE_DIR;
if(!base&&!environment.AGENT_HERDER_UNFINISHED_SESSION_STORE)throw Error('Existing durable state path is unknown');
const unfinished=JSON.parse(await readFile(environment.AGENT_HERDER_UNFINISHED_SESSION_STORE??join(base,'unfinished-sessions.json'),'utf8'));
const stopPath=environment.AGENT_HERDER_HUMAN_STOP_STORE??join(environment.HOME??'/home/roomhacker','.local/state/agent-herder/human-stops.json');
const store=new HumanStopStore(stopPath);
const nativeDb=environment.ZCODE_DB_PATH??join(environment.HOME??'/home/roomhacker','.zcode/cli/db/db.sqlite');
const crashFile=value('--confirmed-parent-crash');
if(crashFile){
 const {sessionId,proof,boundary,context,ownerReceipt}=JSON.parse(await readFile(crashFile,'utf8'));
 const owner=JSON.parse(await readFile(ownerReceipt,'utf8'));
 if(owner.controllerPid!==proof.controllerPid||owner.runtimePid!==proof.runtimePid||owner.controllerStartedAt!==context.controllerStartedAt)throw Error('Exact historical owned-parent generation receipt missing');
 const journal=execFileSync('journalctl',['--no-pager','-o','json',`--cursor=${context.journalCursor}`,'-n','1'],{encoding:'utf8',timeout:5000});
 const entry=JSON.parse(journal.trim());
 if(entry.__CURSOR!==context.journalCursor||Number(entry._PID)!==proof.controllerPid||!String(entry.MESSAGE).includes(context.errorCode)
   ||Math.floor(Number(entry.__REALTIME_TIMESTAMP)/1000)!==proof.at||context.kind!=='parent-crash')throw Error('Exact parent crash journal evidence changed');
 const response=await fetch(`http://127.0.0.1:${environment.AGENT_HERDER_WEB_PORT??18787}/api/sessions/zcode/${encodeURIComponent(sessionId)}`,{signal:AbortSignal.timeout(5000)});
 const session=response.ok?(await response.json()).session:undefined;
 if(session?.id!==sessionId||session.meta?.humanStopHeld!==false||session.status==='running'||session.meta?.nativeActiveTurnId
   ||(Array.isArray(session.meta?.pendingRequestIds)&&session.meta.pendingRequestIds.length)||!zcodeConfirmedCrashBoundary(nativeDb,sessionId,proof,boundary,context.controllerStartedAt))throw Error('Native state/input/hold changed; crash attribution refused');
 if(!dryRun&&!await store.checkpointOwnedZcodeShutdown(sessionId,proof,context))throw Error('Human hold appeared; crash attribution refused');
 const result={dryRun,controllerPid:pid,sessionId,proof,context,attributionRecorded:!dryRun,noInputSent:true,idleProof:false};
 const receipt=value('--receipt');if(receipt){await mkdir(dirname(receipt),{recursive:true});await writeFile(receipt,JSON.stringify(result,null,2),{mode:0o600});}
 console.log(JSON.stringify(result));process.exit(0);
}
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
const {DatabaseSync}=await import('node:sqlite');
const rawControllerStat=await readFile(`/proc/${pid}/stat`,'utf8');
const controllerStat=rawControllerStat.slice(rawControllerStat.lastIndexOf(')')+2).split(' ');
const boot=Number((await readFile('/proc/stat','utf8')).match(/^btime (\d+)$/m)?.[1]);
const clockTicks=Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8',timeout:1000}).trim());
const controllerStartedAt=Math.floor((boot+Number(controllerStat[19])/clockTicks)*1000);
if(!Number.isFinite(controllerStartedAt))throw Error('Controller start generation is unknown');
const activityAudit=args.includes('--audit-native-activity');
if(args.includes('--audit-all-native-sessions'))throw Error('Historical bootstrap is unsupported; use --audit-native-activity for bounded existing activity');
const rows=new Map((unfinished.sessions??[]).filter(row=>row.harness==='zcode').map(row=>[row.sessionId,row]));
let nativeSessionCount;
if(activityAudit){
 const db=new DatabaseSync(nativeDb,{readOnly:true});
 try{
  nativeSessionCount=db.prepare('select count(*) as count from session').get().count;
  const candidates=db.prepare('select id from session where time_updated>=? order by time_updated desc').all(controllerStartedAt);
  for(const {id} of candidates)if(!rows.has(id))rows.set(id,{sessionId:id,harness:'zcode'});
 }finally{db.close();}
}
const ownedWorkspaceClients=[];
for(const item of await readdir('/proc')){
 checkDeadline();if(!/^\d+$/.test(item))continue;
 try{
  const status=await readFile(`/proc/${item}/status`,'utf8');
  if(Number(status.match(/^PPid:\s+(\d+)/m)?.[1])!==runtimePids[0])continue;
  const cmd=(await readFile(`/proc/${item}/cmdline`)).toString().split('\0');
  if(basename(cmd[0])!=='zcode-cli')continue;
  const {readlink}=await import('node:fs/promises');
  ownedWorkspaceClients.push({pid:Number(item),cwd:await readlink(`/proc/${item}/cwd`)});
 }catch{}
}
const result={dryRun,controllerPid:pid,runtimePid:runtimePids[0],controllerStartedAt,observedAt:new Date().toISOString(),
 coverage:activityAudit?'native-activity-since-controller-start-plus-durable-identities':'existing-durable-session-identities-only',
 ownedWorkspaceClients,nativeSessionCount,candidateCount:rows.size,candidateScanComplete:false,loadedSessionCoverage:"unknown",idleProof:false,checkpointed:[],excluded:[]};
const endpoint=`http://127.0.0.1:${environment.AGENT_HERDER_WEB_PORT??18787}`;
let observed=0;
for(const row of rows.values()){
 if(Date.now()>deadline){result.incompleteReason='deadline';break;}
 let observation;
 try{
  const response=await fetch(`${endpoint}/api/sessions/zcode/${encodeURIComponent(row.sessionId)}`,{signal:AbortSignal.timeout(Math.min(5000,Math.max(1,deadline-Date.now())))});
  if(!response.ok)observation={owned:false,reason:`native_http_${response.status}`};
  else observation=zcodeShutdownObservation(nativeDb,row.sessionId,(await response.json()).session,row.activeTurnId);
 }catch{observation={owned:false,reason:'native_http_observation_unavailable'};}
 observed++;
 if(observation.owned){
  const proof={turnId:observation.turnId,controllerPid:pid,runtimePid:runtimePids[0],at:Date.now()};
  if(dryRun||await store.checkpointOwnedZcodeShutdown(row.sessionId,proof)){result.checkpointed.push({sessionId:row.sessionId,...proof});continue;}
  observation={...observation,owned:false,reason:'human_hold_at_checkpoint'};
 }
 result.excluded.push({sessionId:row.sessionId,...(observation.turnId?{turnId:observation.turnId}:{}),reason:observation.reason});
}
result.observedCount=observed;result.candidateScanComplete=observed===rows.size;
// Snapshot reads are not an atomic admission fence. Unknown/hidden native IDs
// and concurrent Desktop work must remain explicit; this never authorizes stop.
result.unknownCount=result.excluded.filter(row=>row.reason!=='observed_idle').length;
if(Number(execFileSync('systemctl',['--user','show','agent-herder.service','-p','MainPID','--value'],{encoding:'utf8',timeout:5000}).trim())!==pid)throw Error('Controller generation changed during checkpoint');
const receipt=value('--receipt');
if(receipt){await mkdir(dirname(receipt),{recursive:true});await writeFile(receipt,JSON.stringify(result,null,2),{mode:0o600});}
console.log(JSON.stringify(result));
if(!result.candidateScanComplete)process.exitCode=2;
