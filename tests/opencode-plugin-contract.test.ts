import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import {expect,it,vi,afterEach} from 'vitest';
import * as diagnosticModule from '../integrations/opencode/agent-herder-diagnostic.js';
// Fast unit, expected<1s/max3. Native loader/transform invocation remains Root's live proof.
afterEach(()=>vi.restoreAllMocks());
it('legacy loader has one function export and diagnostics delegate exact hooks without leaking context',async()=>{
 expect(Object.values(diagnosticModule)).toHaveLength(1);expect(typeof diagnosticModule.default).toBe('function');
 const root=await mkdtemp(join(tmpdir(),'opencode-plugin-'));try{
  const hooks=await diagnosticModule.default({directory:root,$:undefined},{diagnostics:true,diagnosticSessionId:'native-sid'});
  const config:any={};await hooks.config(config);expect(config.command.autopilot).toBeDefined();
  vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:true,status:200,json:async()=>({activeInboxIds:['scoped-once'],activeInboxContext:'unpredictable private context'})} as any);
  const out={messages:[{info:{sessionID:'native-sid',id:'native-user',role:'user'},parts:[{type:'text',text:'original private prompt'}]}]};
  await hooks['experimental.chat.messages.transform']({},out);
  expect(out.messages[0].parts[0].text).toContain('unpredictable private context');
  const log=await readFile(join(root,'.agent-herder-opencode-diagnostic.jsonl'),'utf8');
  expect(log).not.toContain('unpredictable private context');expect(log).not.toContain('original private prompt');
  expect(log).toContain('"phase":"fetch"');expect(log).toContain('"status":200');
  expect(log).toContain('"phase":"factory"');expect(log).toContain('"rootUserId":"native-user"');expect(log).toContain('"textChanged":true');
 }finally{await rm(root,{recursive:true,force:true})}
});
it('probe is opt-in and excludes other session events while keeping native delegation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'opencode-probe-'));try{
  const ordinary=await diagnosticModule.default({directory:root,$:undefined});await ordinary.config({});
  await expect(readFile(join(root,'.agent-herder-opencode-diagnostic.jsonl'))).rejects.toMatchObject({code:'ENOENT'});
  const hooks=await diagnosticModule.default({directory:root,$:undefined},{diagnostics:true,diagnosticSessionId:'own'});
  await hooks['tool.execute.before']({sessionID:'foreign',tool:'read'},{args:{}});
  const lines=(await readFile(join(root,'.agent-herder-opencode-diagnostic.jsonl'),'utf8')).trim().split('\n');expect(lines).toHaveLength(1);
 }finally{await rm(root,{recursive:true,force:true})}
});

it('event flood cannot consume critical slots and fetch diagnostics distinguish refusal from timeout without private error text',async()=>{
 const root=await mkdtemp(join(tmpdir(),'opencode-fetch-'));try{
  const hooks=await diagnosticModule.default({directory:root,$:undefined},{diagnostics:true,diagnosticSessionId:'own'});
  for(let i=0;i<200;i++)await hooks.event({event:{type:'message.updated',properties:{sessionID:'own'}}});
  const output=()=>({messages:[{info:{sessionID:'own',id:'root-user',role:'user'},parts:[{type:'text',text:'private prompt'}]}]});
  vi.spyOn(globalThis,'fetch').mockResolvedValueOnce({ok:false,status:503} as any).mockRejectedValueOnce(Object.assign(new Error('private secret'),{name:'TimeoutError'}));
  await hooks['experimental.chat.messages.transform']({},output());
  await hooks['experimental.chat.messages.transform']({},output());
  const log=await readFile(join(root,'.agent-herder-opencode-diagnostic.jsonl'),'utf8');
  expect(log).toContain('"stage":"http_refused"');expect(log).toContain('"status":503');
  expect(log).toContain('"stage":"error"');expect(log).toContain('"errorName":"TimeoutError"');
  expect(log).not.toContain('private secret');expect(log).not.toContain('private prompt');expect(log).not.toContain('"hook":"event"');
 }finally{await rm(root,{recursive:true,force:true})}
});

it('probe can use the exact physically versioned implementation file rather than a cached parent import',async()=>{
 const root=await mkdtemp(join(tmpdir(),'opencode-versioned-'));try{
  const artifact=join(root,'herder-source-unique.mjs');
  await writeFile(artifact,await readFile(new URL('../integrations/opencode/agent-herder-autopilot.js',import.meta.url)));
  const hooks=await diagnosticModule.default({directory:root,$:undefined},{diagnostics:true,diagnosticSessionId:'own',implementationUrl:pathToFileURL(artifact).href});
  vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:true,status:200,json:async()=>({activeInboxIds:[],humanStopHeld:false})} as any);
  await hooks['experimental.chat.messages.transform']({},{messages:[{info:{sessionID:'own',id:'root-user',role:'user'},parts:[{type:'text',text:'initial'}]}]});
  const log=await readFile(join(root,'.agent-herder-opencode-diagnostic.jsonl'),'utf8');expect(log).toContain('"phase":"fetch"');expect(log).toContain('"activeInboxCount":0');
 }finally{await rm(root,{recursive:true,force:true})}
});
