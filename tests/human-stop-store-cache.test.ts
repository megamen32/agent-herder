import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile,utimes} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const {reads}=vi.hoisted(()=>({reads:{} as Record<string,number>}));

// Count only the reads of the store file itself; everything else passes through.
vi.mock('node:fs/promises',async()=>{
 const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
 return {
  ...actual,
  readFile:(...args:any[])=>{const target=String(args[0]);reads[target]=(reads[target]??0)+1;return (actual.readFile as any)(...args);},
 };
});

import {getHumanStopStore} from '../src/human-stop-store.js';

const roots:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const key of Object.keys(reads))delete reads[key];await Promise.all(roots.splice(0).map(p=>rm(p,{recursive:true,force:true})));});

async function storeFixture(){
 const root=await mkdtemp(join(tmpdir(),'human-stop-cache-'));
 roots.push(root);
 const path=join(root,'human-stops.json');
 vi.stubEnv('AGENT_HERDER_HUMAN_STOP_STORE',path);
 return {root,path,store:getHumanStopStore()};
}

describe('human stop store serves repeat reads from a stat cache',()=>{
 it('parses the store file once for many reads and sees external writes',async()=>{
  const {path,store}=await storeFixture();
  await store.hold({harness:'codex',id:'ses-a'},{id:'stop-1',at:new Date().toISOString(),reason:'test stop'});
  expect(await store.isHeld('codex','ses-a')).toBe(true);
  const readsAfterFirst=reads[path]??0;
  expect(readsAfterFirst).toBeGreaterThan(0);

  // A burst of reads (the observation tick pattern) must not re-read the file.
  for(let n=0;n<20;n++){
   expect(await store.isHeld('codex','ses-a')).toBe(true);
   expect(await store.isHeld('codex','ses-b')).toBe(false);
  }
  expect(reads[path]??0).toBe(readsAfterFirst);

  // An external write with a fresh mtime must invalidate the cache.
  const external={version:1,sessions:[
   {harness:'codex',id:'ses-b',active:true,stop:{id:'stop-2',at:new Date().toISOString(),reason:'external'},ignoredStopIds:[]},
  ]};
  await writeFile(path,JSON.stringify(external),{encoding:'utf8',mode:0o600});
  // mtime must visibly move so the stat stamp differs.
  const later=new Date(Date.now()+5000);
  await utimes(path,later,later);
  expect(await store.isHeld('codex','ses-b')).toBe(true);
  expect(await store.isHeld('codex','ses-a')).toBe(false);
  expect((reads[path]??0)).toBeGreaterThan(readsAfterFirst);

  // A write through the store itself is immediately visible to the next read.
  await store.hold({harness:'codex',id:'ses-c'},{id:'stop-3',at:new Date().toISOString(),reason:'after write'});
  expect(await store.isHeld('codex','ses-c')).toBe(true);
  expect(await store.isHeld('codex','ses-b')).toBe(true);
 });

 it('serves mutate flows through the cache: hold, release and re-hold stay consistent',async()=>{
  const {path,store}=await storeFixture();
  await store.hold({harness:'codex',id:'ses-a'},{id:'stop-1',at:new Date().toISOString(),reason:'test stop'});
  expect(await store.isHeld('codex','ses-a')).toBe(true);
  const readsAfterHold=reads[path]??0;
  expect(readsAfterHold).toBeGreaterThan(0);

  // Release mutates the file and clears the cache; the next read re-parses
  // once and then the cache serves again.
  expect(await store.release('codex','ses-a')).toBe(true);
  expect(await store.isHeld('codex','ses-a')).toBe(false);
  const readsAfterRelease=reads[path]??0;
  expect(readsAfterRelease).toBeGreaterThan(readsAfterHold);
  for(let n=0;n<10;n++)expect(await store.isHeld('codex','ses-a')).toBe(false);
  expect(reads[path]??0).toBe(readsAfterRelease);

  // A re-hold writes again and is visible immediately.
  await store.hold({harness:'codex',id:'ses-a'},{id:'stop-2',at:new Date().toISOString(),reason:'test stop again'});
  expect(await store.isHeld('codex','ses-a')).toBe(true);
 });
});
