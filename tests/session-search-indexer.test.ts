import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startSessionSearchIndexer} from '../src/session-search-indexer.js';
import {SessionSearchIndex} from '../src/session-search.js';

it('claims one owner and reports persistent scan progress to independent readers',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'herder-indexer-')),path=join(dir,'index.sqlite');let release!:()=>void;
 const pending=new Promise<void>(resolve=>release=resolve);
 const owner=await startSessionSearchIndexer(async function*(options){await pending;options.onStatus?.({harness:'codex',source:'fixture',state:'complete',sessions:0});},{path,intervalMs:60000});
 let reader:SessionSearchIndex|undefined;
 try{
  expect(owner).toBeDefined();reader=new SessionSearchIndex(path);
  expect(reader.status().indexing).toBe(true);
  expect(await startSessionSearchIndexer(async function*(){throw new Error('second_owner_must_not_run');},{path})).toBeUndefined();
  release();await owner!.close();expect(reader.status().indexing).toBe(false);
 }finally{release();reader?.close();rmSync(dir,{recursive:true,force:true});}
});

it('retries one transient changed-source scan promptly instead of waiting a minute',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'herder-indexer-retry-')),path=join(dir,'index.sqlite');let scans=0;
 const owner=await startSessionSearchIndexer(async function*(options){
  scans++;options.onStatus?.({harness:'opencode',source:'fixture',state:scans===1?'partial':'complete',sessions:0,...(scans===1?{reason:'native_source_changed_during_scan'}:{})});
 },{path,intervalMs:60000});
 try {
  const deadline=Date.now()+3500;
  while(scans<2 && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
  expect(scans).toBe(2);
 } finally {await owner?.close();rmSync(dir,{recursive:true,force:true});}
});
