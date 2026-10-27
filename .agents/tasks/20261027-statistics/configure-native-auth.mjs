// Correct only Herder's stale credential for the already running official OpenCode.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const unit='agent-herder.service';
const nativePid=execFileSync('systemctl',['--user','show','opencode.service','-p','MainPID','--value'],{encoding:'utf8'}).trim();
if(!/^[1-9]\d*$/.test(nativePid))throw Error('No existing OpenCode process');
const env=Object.fromEntries(fs.readFileSync(`/proc/${nativePid}/environ`,'utf8').split('\0').filter(Boolean).map(value=>{const at=value.indexOf('=');return[value.slice(0,at),value.slice(at+1)];}));
const password=env.OPENCODE_SERVER_PASSWORD,username=env.OPENCODE_SERVER_USERNAME||'opencode';
if(!password||/[\r\n\0]/.test(password+username))throw Error('No valid existing native credential');
const headers={Authorization:'Basic '+Buffer.from(`${username}:${password}`).toString('base64')};
const probe=await fetch('http://127.0.0.1:4095/api/config',{headers,redirect:'error',signal:AbortSignal.timeout(5000)});
if(!probe.ok||!probe.headers.get('content-type')?.includes('json'))throw Error('Native credential not confirmed');
await probe.body?.cancel();
const read=async endpoint=>{const r=await fetch('http://127.0.0.1:18787'+endpoint,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Herder read unavailable');return{value:await r.json(),etag:r.headers.get('etag')};};
const beforePolicy=await read('/api/automation/launch-policy'),beforeSettings=await read('/api/session-autostart');
const envPath=path.join(os.homedir(),'.config/agent-herder/herder.env'),backup=envPath+'.before-native-auth-20261027';
if(fs.existsSync(backup))throw Error('Already attempted; inspect without replay');
const before=fs.readFileSync(envPath,'utf8');fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
let next=before;
for(const [name,value]of Object.entries({OPENCODE_SERVER_PASSWORD:password,OPENCODE_SERVER_USERNAME:username})){
 const line=`${name}=${JSON.stringify(value)}`,pattern=new RegExp(`^${name}=.*$`,'m');
 next=pattern.test(next)?next.replace(pattern,()=>line):next.replace(/\n?$/,'\n')+line+'\n';
}
const tmp=envPath+'.native-auth.tmp';fs.writeFileSync(tmp,next,{mode:0o600,flag:'wx'});fs.renameSync(tmp,envPath);
execFileSync('systemctl',['--user','restart',unit]);
let afterPolicy;
for(let n=0;n<30;n++){try{afterPolicy=await read('/api/automation/launch-policy');break;}catch{await new Promise(r=>setTimeout(r,1000));}}
if(!afterPolicy||JSON.stringify(afterPolicy)!==JSON.stringify(beforePolicy))throw Error('Policy continuity not confirmed');
const afterSettings=await read('/api/session-autostart');
if(JSON.stringify(afterSettings)!==JSON.stringify(beforeSettings))throw Error('Settings continuity not confirmed');
console.log(JSON.stringify({nativePid:Number(nativePid),nativeCredentialProbe:probe.status,herderPid:Number(execFileSync('systemctl',['--user','show',unit,'-p','MainPID','--value'],{encoding:'utf8'}).trim()),policyPreserved:true,settingsPreserved:true,nativeRestarted:false}));
