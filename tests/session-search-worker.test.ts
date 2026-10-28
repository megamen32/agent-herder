import {it,expect} from 'vitest';
import {mkdtempSync,readFileSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import ts from 'typescript';
import {SessionSearchIndex} from '../src/session-search.js';
import {startSessionSearchBackground} from '../src/session-search-worker.js';

it('serves real HTTP health and indexed search while a native SQLite corpus is ingested in the owner worker',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'herder-worker-')),dist=join(dir,'dist');mkdirSync(dist);writeFileSync(join(dist,'package.json'),' {"type":"module"}');
 for(const name of ['session-search','session-search-indexer','session-search-sources','session-search-worker','indexing-settings'])writeFileSync(join(dist,name+'.js'),ts.transpileModule(readFileSync(new URL('../src/'+name+'.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText);
 const dbpath=join(dir,'native.sqlite'),db=new DatabaseSync(dbpath);db.exec('CREATE TABLE session(id TEXT,title TEXT,directory TEXT,time_updated INTEGER);CREATE TABLE message(id TEXT,session_id TEXT,data TEXT,time_created INTEGER);CREATE TABLE part(id TEXT,session_id TEXT,message_id TEXT,data TEXT,time_created INTEGER);BEGIN');
 db.prepare('INSERT INTO session VALUES(?,?,?,?)').run('native','Huge native fixture','/fixture',1);db.prepare('INSERT INTO message VALUES(?,?,?,?)').run('msg','native','{"role":"user"}',1);
 const insert=db.prepare('INSERT INTO part VALUES(?,?,?,?,?)');for(let n=0;n<10000;n++)insert.run(String(n),'native','msg',JSON.stringify({type:'text',text:'native history '.repeat(20)}),n);db.exec('COMMIT');db.close();
 const index=new SessionSearchIndex(join(dir,'index.sqlite'),'fixture');await index.ingest({harness:'fixture',nativeSessionId:'old',title:'Existing session',cwd:'/fixture',revision:'1',chunks:(async function*(){yield{id:'old',text:'availableword'};})()},'seed');
 const missing=join(dir,'absent');const owner=await startSessionSearchBackground({path:index.path,workerURL:pathToFileURL(join(dist,'session-search-worker.js')),env:{...process.env,CODEX_HOME:missing,MINIMAX_CODE_SESSION_STORE:missing,OPENCODE_DB_PATH:dbpath,ZCODE_DB_PATH:missing,HERMES_STATE_DB:missing,CLAUDE_PROJECTS_DIR:missing}});
 const server=createServer((request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify(request.url==='/health'?{ok:true}:index.search({query:'availableword',limit:1})));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  await expect.poll(()=>index.status().indexing,{timeout:3000,interval:10}).toBe(true);
  const address=server.address() as {port:number};const started=performance.now();const health=await fetch(`http://127.0.0.1:${address.port}/health`).then(response=>response.json());const search=await fetch(`http://127.0.0.1:${address.port}/search`).then(response=>response.json());
  expect(health.ok).toBe(true);expect(search.results).toHaveLength(1);expect(performance.now()-started).toBeLessThan(2000);expect(index.status().indexing).toBe(true);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await owner.close();index.close();rmSync(dir,{recursive:true,force:true});}
},15000);
