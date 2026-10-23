import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SessionSearchIndex,lexicalMatch} from '../src/session-search.js';

const dirs:string[]=[];
const indexes:SessionSearchIndex[]=[];
function fixture(){const dir=mkdtempSync(join(tmpdir(),'herder-search-'));dirs.push(dir);const index=new SessionSearchIndex(join(dir,'index.sqlite'),'host-a');indexes.push(index);return index;}
async function* chunks(text:string){yield{id:'message-1',text};}
function session(text:string,revision='1'){return{harness:'codex',nativeSessionId:'same-id',title:'Русский заголовок',cwd:'/project',revision,chunks:chunks(text)};}
afterEach(()=>{for(const index of indexes.splice(0))index.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
describe('disposable lexical session mirror',()=>{
 it('finds Unicode title and persisted words, distinguishes harness identity and survives reopen',async()=>{
  const index=fixture();await index.ingest(session('Старинное сообщение с анаконда'),'scan-1');
  await index.ingest({...session('different content'),harness:'zcode'},'scan-1');
  expect(index.search({query:'заголовок'}).results).toHaveLength(2);
  expect(index.search({query:'анаконда'}).results[0]).toMatchObject({hostId:'host-a',harness:'codex',nativeSessionId:'same-id'});
  expect(index.search({query:'анаконда'}).results[0].snippet).toContain('анаконда');
  const second=new SessionSearchIndex(index.path,'host-a');try{expect(second.search({query:'анаконда'}).results).toHaveLength(1);}finally{second.close();}
 });
 it('atomically replaces edits and retains old transcript when a source fails',async()=>{
  const index=fixture();await index.ingest(session('oldword'),'a');
  async function* broken(){yield{id:'x',text:'badword'};throw new Error('source_unavailable');}
  await expect(index.ingest({...session('', '2'),chunks:broken()},'b')).rejects.toThrow('source_unavailable');
  expect(index.search({query:'oldword'}).results).toHaveLength(1);expect(index.search({query:'badword'}).results).toHaveLength(0);
  await index.ingest(session('newword','3'),'c');
  expect(index.search({query:'oldword'}).results).toHaveLength(0);expect(index.search({query:'newword'}).results).toHaveLength(1);
 });
 it('does not delete on partial scan and deletes only after exhaustive successful scan',async()=>{
  const index=fixture();await index.ingest(session('preservedword'),'a');
  index.finishSource({harness:'codex',source:'fixture',state:'partial',sessions:0},'b');
  expect(index.search({query:'preservedword'}).results).toHaveLength(1);
  index.finishSource({harness:'codex',source:'fixture',state:'complete',sessions:0},'c');
  expect(index.search({query:'preservedword'}).results).toHaveLength(0);
 });
 it('continues later sessions and harnesses after lazy content failure',async()=>{
  const index=fixture();await index.ingest(session('previousword'),'old');
  async function* broken(){throw new Error('bad_json_after_first_user');yield{id:'x',text:''};}
  async function* sources(){yield{...session('','2'),chunks:broken()};yield{...session('laterword'),harness:'zcode'};}
  await index.scan(sources(),[{harness:'codex',source:'fixture',state:'complete',sessions:1},{harness:'zcode',source:'fixture',state:'complete',sessions:1}]);
  expect(index.search({query:'previousword'}).results).toHaveLength(1);expect(index.search({query:'laterword'}).results).toHaveLength(1);
  expect(index.status().sources.find(source=>source.harness==='codex').state).toBe('partial');
 });
 it('preserves previously indexed content when native content disappears, while updating title',async()=>{
  const index=fixture();await index.ingest(session('preservedhistory'),'a');
  await index.ingest({...session('','missing'),title:'Новый заголовок',contentUnavailable:true},'b');
  expect(index.search({query:'preservedhistory'}).results).toHaveLength(1);expect(index.search({query:'Новый'}).results).toHaveLength(1);
 });
 it('lets consumer timers and index queries run during synchronous source ingestion',async()=>{
  const index=fixture();await index.ingest(session('availableword'),'a');let served=false;
  const timer=new Promise<void>(resolve=>setTimeout(()=>{served=index.search({query:'availableword'}).results.length===1;resolve();},0));
  async function* many(){for(let i=0;i<2048;i++)yield{id:String(i),text:'large synchronous source batch'};}
  await index.ingest({...session('','large'),nativeSessionId:'large-session',chunks:many()},'b');
  expect(served).toBe(true);await timer;
 });
 it('rejects native databases before creating search tables',()=>{
  const dir=mkdtempSync(join(tmpdir(),'herder-search-'));dirs.push(dir);const path=join(dir,'native.sqlite');
  const native=new DatabaseSync(path);native.exec('CREATE TABLE threads(id TEXT)');native.close();
  expect(()=>new SessionSearchIndex(path)).toThrow('search_database_not_owned');
  const read=new DatabaseSync(path,{readOnly:true});try{expect(read.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{name:'threads'}]);}finally{read.close();}
 });
 it('opens consumer queries without writer admission while a backfill write transaction is held',async()=>{
  const index=fixture();await index.ingest(session('visiblewhilewriting'),'a');
  const writer=new DatabaseSync(index.path);writer.exec('BEGIN IMMEDIATE');let reader:SessionSearchIndex|undefined;
  try{reader=new SessionSearchIndex(index.path,'host-a',{readOnly:true});expect(reader.search({query:'visiblewhilewriting'}).results).toHaveLength(1);}
  finally{reader?.close();writer.exec('ROLLBACK');writer.close();}
 });
 it('keeps FTS as the driving index for a harness-filtered consumer query',async()=>{
  const index=fixture();await index.ingest(session('filteredword'),'a');let query='';
  const original=DatabaseSync.prototype.prepare;
  const spy=vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(this:DatabaseSync,sql:string){if(sql.startsWith('SELECT s.harness,s.native_id'))query=sql;return original.call(this,sql);});
  try{expect(index.search({query:'filteredword',harnesses:['codex']}).results).toHaveLength(1);}finally{spy.mockRestore();}
  const db=new DatabaseSync(index.path,{readOnly:true});try{
   const plan=db.prepare('EXPLAIN QUERY PLAN '+query).all('"filteredword"','codex');
   expect(String(plan[0].detail)).toMatch(/^SCAN chunks_fts VIRTUAL TABLE/);
   expect(plan.some(row=>String(row.detail).includes('TEMP B-TREE'))).toBe(false);
  }finally{db.close();}
 });
 it('treats operator-like input as plain Unicode words',()=>{expect(lexicalMatch('title:кот OR собака*')).toBe('"title" AND "кот" AND "OR" AND "собака"');expect(()=>lexicalMatch('***')).toThrow();});
});
