// Reuse existing native credentials through the explicit Herder catalog seam.
// Never print credentials or create/rotate OmniRoute credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCliToken } from '/home/roomhacker/agents-projects/omniroute-zcode/bin/cli/utils/cliToken.mjs';
const home=os.homedir();
const saltPath=path.join(home,'.omniroute/cli-token-salt.json');
const salt=JSON.parse(fs.readFileSync(saltPath,'utf8')).salt;
if(!/^[0-9a-f]{64}$/.test(salt)||fs.statSync(saltPath).mode&0o077)throw Error('Existing private local credential required');
const key=JSON.parse(fs.readFileSync(path.join(home,'.local/share/opencode/auth.json'),'utf8')).omniroute?.key;
const token=await getCliToken();
if(!key||!token||[key,token].some(v=>typeof v!=='string'||/[\r\n\0]/.test(v)))throw Error('Invalid existing credential');
const inference=await fetch('http://127.0.0.1:20128/v1/models',{headers:{Authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(5000)});
const management=await fetch('http://127.0.0.1:20128/api/combos',{headers:{'X-OmniRoute-CLI-Token':token},redirect:'error',signal:AbortSignal.timeout(5000)});
if(!inference.ok||!management.ok)throw Error('Read-only catalog authentication failed');
await inference.body?.cancel();await management.body?.cancel();
const envPath=path.join(home,'.config/agent-herder/herder.env');
const before=fs.readFileSync(envPath,'utf8');
const backup=envPath+'.before-catalog-auth-20261027';
if(fs.existsSync(backup))throw Error('Already attempted; inspect receipts instead of replaying');
fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
let next=before;
for(const [name,value] of Object.entries({OMNIROUTE_API_KEY:key,AGENT_HERDER_OMNIROUTE_CLI_TOKEN:token})){
 const line=`${name}=${JSON.stringify(value)}`;
 const pattern=new RegExp(`^${name}=.*$`,'m');
 next=pattern.test(next)?next.replace(pattern,()=>line):next.replace(/\n?$/,'\n')+line+'\n';
}
const tmp=envPath+'.catalog-auth.tmp';fs.writeFileSync(tmp,next,{mode:0o600,flag:'wx'});fs.renameSync(tmp,envPath);
console.log(JSON.stringify({inferenceCatalog:inference.status,managementCatalog:management.status,credentialSource:'existing native OpenCode auth and machine-bound local CLI',configKeys:['OMNIROUTE_API_KEY','AGENT_HERDER_OMNIROUTE_CLI_TOKEN'],restartPerformed:false}));
