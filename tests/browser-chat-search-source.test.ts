import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {scanSessionSearchSources,type SearchSourceStatus} from '../src/session-search-sources.js';

const roots:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});

async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'browser-inventory-'));roots.push(root);
 for(const key of ['CODEX_HOME','MINIMAX_CODE_SESSION_STORE','OPENCODE_DB_PATH','ZCODE_DB_PATH','HERMES_STATE_DB','CLAUDE_PROJECTS_DIR','AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT'])vi.stubEnv(key,join(root,key));
 return join(root,'AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT');
}

describe('browser chat inventory search source',()=>{
 it('indexes real account scopes with provider-scoped route ids and skips synthetic scopes',async()=>{
  const root=await fixture();
  const zaiScope=join(root,'zai','1aa02989cb1349edca3ce1f9edae68a068369e5de570e9a6be3a53916595df0a');
  await mkdir(zaiScope,{recursive:true});
  await writeFile(join(zaiScope,'inventory.json'),JSON.stringify({scope:'1aa02989cb1349edca3ce1f9edae68a068369e5de570e9a6be3a53916595df0a',scannedAt:0,chats:[
   {id:'6aa1dd0e-4f11-4fc9-a633-94fa95566c2f',title:'Problems with Herder Agent Delivery',updatedAt:1793676429,lastRunStatus:'running',seenAt:1793677075440},
   {id:'4f49ca6b-7141-4500-ad18-703d8d0df906',title:'Идея военного маркетплейса',updatedAt:1793675264,seenAt:1793677075440},
  ]}));
  const syntheticScope=join(root,'zai','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  await mkdir(syntheticScope,{recursive:true});
  await writeFile(join(syntheticScope,'inventory.json'),JSON.stringify({chats:[{id:'123e4567-e89b-12d3-a456-426614174000',title:'fixture chat'}]}));
  const chatgptScope=join(root,'chatgpt','b3f35cdebc0da7360763bc2c80426ee6e86e15d3239d581616ba35c634d055f1');
  await mkdir(chatgptScope,{recursive:true});
  await writeFile(join(chatgptScope,'inventory.json'),JSON.stringify({chats:[{id:'6ae7ada6-17a0-83eb-b765-6816447a573d',title:'Ветка',updatedAt:'2026-11-03T03:22:48.308505Z'}]}));

  const statuses:SearchSourceStatus[]=[];const sessions:any[]=[];
  for await(const s of scanSessionSearchSources({onStatus:s=>statuses.push(s)})){sessions.push(s);for await(const _ of s.chunks){}}
  const zai=sessions.filter(s=>s.harness==='zai');
  const chatgpt=sessions.filter(s=>s.harness==='chatgpt');
  expect(zai).toHaveLength(2);
  expect(zai.map(s=>s.nativeSessionId)).toContain('zai::route%3A6aa1dd0e-4f11-4fc9-a633-94fa95566c2f');
  expect(zai.every(s=>s.nativeSessionId.startsWith('zai::route%3A'))).toBe(true);
  expect(zai.every(s=>s.contentUnavailable===true)).toBe(true);
  expect(zai.every(s=>s.cwd.endsWith('/.browser-chat/zai'))).toBe(true);
  expect(chatgpt).toHaveLength(1);
  expect(chatgpt[0].nativeSessionId).toBe('chatgpt::6ae7ada6-17a0-83eb-b765-6816447a573d');
  expect(chatgpt[0].title).toBe('Ветка');
  expect(statuses.find(s=>s.harness==='zai')?.state).toBe('complete');
  expect(statuses.find(s=>s.harness==='chatgpt')?.state).toBe('complete');
 });
 it('stays silent when the inventory root does not exist',async()=>{
  await fixture();
  const statuses:SearchSourceStatus[]=[];
  for await(const s of scanSessionSearchSources({onStatus:s=>statuses.push(s)}))for await(const _ of s.chunks){}
  expect(statuses.find(s=>s.harness==='zai')).toMatchObject({state:'partial'});
  expect(statuses.find(s=>s.harness==='chatgpt')).toMatchObject({state:'partial'});
 });
});
