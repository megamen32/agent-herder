#!/usr/bin/env node
// Prepare only. Root invokes the resulting callback on the unique EXISTING
// live registry. Never import herder-jobs or write jobs.json from this process.
import {readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

export function prepareFirstUpgradeCallback(capture, expected, retainedMethod) {
 if(!/^retainZcodeInput\(capture\)\s*\{/.test(retainedMethod.trim()))throw Error('Compiled self-contained retain method is missing');
 const retainedDeclaration='function '+retainedMethod.trim();
 // Parse, never execute/import a jobs singleton in this preparation process.
 Function('return ('+retainedDeclaration+')');
 return `function() {
  const expected=${JSON.stringify(expected)}, capture=${JSON.stringify(capture)};
  const fs=process.getBuiltinModule('fs'),crypto=process.getBuiltinModule('crypto');
  const stat=pid=>fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ');
  if(process.pid!==expected.controllerPid || stat(process.pid)[19]!==expected.controllerTick
    || stat(expected.sdkPid)[19]!==expected.sdkTick || Number(stat(expected.sdkPid)[1])!==process.pid
    || stat(expected.cliPid)[19]!==expected.cliTick || Number(stat(expected.cliPid)[1])!==expected.sdkPid
    || fs.realpathSync('/proc/'+expected.cliPid+'/cwd')!==capture.cwd)throw Error('Exact controller/SDK/CLI generation changed');
  if(!(this.jobs instanceof Map)||this.persistencePath!==expected.jobsPath||typeof this.persist!=='function'
    || !['get','list','cancel'].every(name=>typeof this[name]==='function'))throw Error('Exact live owned registry was not selected');
  const db=new (process.getBuiltinModule('node:sqlite').DatabaseSync)(expected.nativeDb,{readOnly:true});
  try {
   db.exec('begin');
   const input=db.prepare('select * from session_input where session_id=? and id=?').get(capture.sessionId,capture.queueItemId);
   if(!input||input.status!=='admitted'||input.promoted_message_id!==null||input.promoted_sequence!==null
     || input.payload!==capture.nativePayload||input.time_created!==capture.createdAt||input.admitted_sequence!==capture.admittedSequence)throw Error('Original input changed or executed before checkpoint');
   const session=db.prepare('select directory,parent_id from session where id=?').get(capture.sessionId);
   if(!session||session.parent_id!==null||session.directory!==capture.cwd)throw Error('Native session identity changed');
   for(const table of ['message','part'])if(db.prepare('select count(*) as n from '+table+' where session_id=? and (not json_valid(data) or instr(data,?)>0 or instr(data,?)>0)').get(capture.sessionId,capture.logicalInputId,capture.queueItemId).n!==0)throw Error('Original native execution evidence exists or is unknown');
   const user=db.prepare("select id,sequence from message where session_id=? and json_valid(data) and json_extract(data,'$.role')='user' and not(coalesce(json_extract(data,'$.synthetic'),0)=1 and coalesce(json_extract(data,'$.semantics.origin'),'')='agent_runtime') order by sequence desc limit 1").get(capture.sessionId);
   if(JSON.stringify(user?{id:user.id,sequence:user.sequence}:null)!==JSON.stringify(capture.latestUser))throw Error('New Desktop/native user input before checkpoint');
  } finally {db.close();}
  for(const file of capture.attachments)if(fs.realpathSync(file.ref)!==file.realPath||fs.statSync(file.ref).size!==file.contentBytes||crypto.createHash('sha256').update(fs.readFileSync(file.ref)).digest('hex')!==file.sha256)throw Error('Attachment content changed before checkpoint');
  // Install every old read-return bridge synchronously BEFORE storing payload.
  // One wrapper preserves each original method's null/limit/cancel semantics.
  for(const name of ['get','list','cancel']) {
   if(this[name].zcodeRetentionRedacting===true)continue;
   const original=this[name];
   const wrapped=function(...args){const value=original.call(this,...args);if(value===null||value===undefined)return value;
    const copy=JSON.parse(JSON.stringify(value));for(const record of Array.isArray(copy)?copy:[copy])if(record&&typeof record==='object')delete record.zcodeInput;return copy;};
   wrapped.zcodeRetentionRedacting=true;this[name]=wrapped;
  }
  const retain=(${retainedDeclaration});
  const receipt=retain.call(this,capture);
  const stored=JSON.parse(fs.readFileSync(expected.jobsPath,'utf8')).jobs.find(job=>job.id===receipt.jobId);
  if(stored?.zcodeInput?.capture?.fingerprint!==capture.fingerprint||stored.durableOnce!==true)throw Error('Strict persisted checkpoint receipt not verified');
  return {...receipt,retained:true,exposureBridge:{get:true,list:true,cancel:true},controllerPid:process.pid,sdkPid:expected.sdkPid,cliPid:expected.cliPid,stopAuthorized:false};
 }`;
}

export async function prepareCheckpoint(argv) {
 const values=new Map();for(let i=0;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||argv[i+1]===undefined)throw Error('Use named flag/value pairs');values.set(argv[i],argv[i+1]);}
 const get=name=>{const value=values.get('--'+name);if(!value)throw Error('Missing --'+name);return value;};
 const compiled=resolve(get('compiled-root'));
 const helper=await import(pathToFileURL(join(compiled,'adapters/zcode-undelivered.js')).href);
 const nativeDb=resolve(get('native-db'));
 const capture=helper.captureZcodeInput(nativeDb,get('session-id'),get('input-id'),resolve(get('cwd')));
 const jobsSource=readFileSync(join(compiled,'herder-jobs.js'),'utf8');
 const start=jobsSource.indexOf('retainZcodeInput(capture) {'),end=jobsSource.indexOf('readZcodeInput(jobId)',start);
 if(start<0||end<0)throw Error('Reviewed compiled retention method not found');
 // Remove following documentation; retain the complete method body only.
 const section=jobsSource.slice(start,end),lastBrace=section.lastIndexOf('}');
 const method=section.slice(0,lastBrace+1);
 const expected={controllerPid:Number(get('controller-pid')),controllerTick:get('controller-tick'),sdkPid:Number(get('sdk-pid')),sdkTick:get('sdk-tick'),cliPid:Number(get('cli-pid')),cliTick:get('cli-tick'),jobsPath:resolve(get('jobs-path')),nativeDb};
 if(![expected.controllerPid,expected.sdkPid,expected.cliPid].every(Number.isSafeInteger))throw Error('Invalid exact process IDs');
 const functionDeclaration=prepareFirstUpgradeCallback(capture,expected,method);
 const output=resolve(get('output'));
 const artifact={version:1,controllerPid:expected.controllerPid,sessionId:capture.sessionId,logicalInputId:capture.logicalInputId,fingerprint:capture.fingerprint,
  functionDeclaration,compiledJobsSHA256:createHash('sha256').update(jobsSource).digest('hex'),stopAuthorized:false};
 writeFileSync(output,JSON.stringify(artifact,null,2)+'\n',{mode:0o600});chmodSync(output,0o600);
 return {prepared:output,sessionId:capture.sessionId,fingerprint:capture.fingerprint,compiledJobsSHA256:artifact.compiledJobsSHA256,stopAuthorized:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try {console.log(JSON.stringify(await prepareCheckpoint(process.argv.slice(2))));}
 catch(error){console.error(error instanceof Error?error.message:'Checkpoint preparation failed');process.exitCode=1;}
}
