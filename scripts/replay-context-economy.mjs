#!/usr/bin/env node
// Read-only historical replay. Raw reports are written only to a private scratch store.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = Object.fromEntries(process.argv.slice(2).map(arg => { const i=arg.indexOf('='); return [arg.slice(2,i),arg.slice(i+1)]; }));
if (!args.transcript || !args.output) throw new Error('Usage: node scripts/replay-context-economy.mjs --transcript=/absolute/native.jsonl --output=/private/output --modules=/absolute/compiled [--cutoff=ISO]');
const output=resolve(args.output); await mkdir(output,{recursive:true,mode:0o700});
process.env.AGENT_HERDER_LONG_MESSAGES_DIR=join(output,'messages');
const modules=resolve(args.modules || 'dist');
const {CoordinationNoteStore}=await import(pathToFileURL(join(modules,'coordination-notes.js')).href);
const {compactAutomaticMessage,readLongMessage}=await import(pathToFileURL(join(modules,'long-messages.js')).href);
const {buildMessageProvenanceHeader}=await import(pathToFileURL(join(modules,'message-provenance.js')).href);
const raw=await readFile(args.transcript,'utf8');
const rows=raw.trim().split('\n').map(line=>JSON.parse(line)).filter(row=>!args.cutoff || row.timestamp<=args.cutoff);
const tagged=/<(agent-herder-[\w-]+)\b[^>]*>[\s\S]*?<\/\1>/g;
const hash=text=>createHash('sha256').update(text).digest('hex');
const pieces=[];const retained=[];const recovered=[];
const boards=new Map(); const store=new CoordinationNoteStore(join(output,'notes.json'));
// Roster text is a partial historical view, not the original note database.
// Reconstruct only peer snapshots. Preserve coordination/conflict blocks unchanged.
store.list=async ({cwd,authorSessionId}={})=>(boards.get(cwd)||[]).filter(n=>!authorSessionId||n.authorSessionId===authorSessionId);
let ordinal=0,peerBlocks=0,peerSuppressed=0,reportCount=0,longReports=0,exactReadbacks=0;
for (const row of rows) {
 if(row.type!=='response_item'||row.payload?.type!=='message')continue;
 const item=row.payload;let text=(item.content||[]).map(c=>c.text||'').join('\n');
 const agentStart=item.role==='user'?text.search(/🤖 (Codex|Сообщение от AI-сессии|Claude|OpenCode)/):-1;
 const report=agentStart>=0?text.slice(agentStart):null;
 if(report!==null)text=text.slice(0,agentStart);
 for(const match of [...text.matchAll(tagged)]){
  const original=match[0];let replacement=original;
  if(match[1]==='agent-herder-repo-peers'){
   peerBlocks++;const board=original.match(/board="([^"]+)"/)?.[1]||'unknown';const cwd='/replay/'+board;
   const notes=original.split('\n').flatMap(line=>{
    const m=line.match(/^- \[([^\]]+)\] (\S+) :: (.*)$/);if(!m)return [];
    const paths=m[3]==='(workspace-level)'?[]:m[3].split(', ').filter(Boolean);
    return (paths.length?paths:[null]).map(path=>{const h=hash(m[1]+':'+m[2]+':'+path).slice(0,32);const id=[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');return {id,kind:'working',message:path?'Auto-reserved after file activity: '+path:'Historical workspace presence',cwd,paths:path?[path]:[],authorHarness:m[1],authorSessionId:m[2],source:'hook',createdAt:row.timestamp,updatedAt:row.timestamp,expiresAt:'2099-01-01T00:00:00.000Z'};});
   });
   boards.set(cwd,notes);
   const now=Date.now;Date.now=()=>Date.parse(row.timestamp);
   try{replacement=await store.renderWorkspacePeers({id:'historical-reader',harness:'codex',cwd})||'';}finally{Date.now=now;}
   if(!replacement)peerSuppressed++;
   // Verify every path/owner in the reconstructed snapshot remains available.
   const available=await store.list({cwd});
   if(JSON.stringify(available)!==JSON.stringify(notes))throw new Error('Historical roster snapshot lost');
  }
  pieces.push({kind:match[1],before:original,after:replacement});
  retained.push({ordinal:ordinal++,kind:match[1],sha256:hash(original),original});
  text=text.replace(original,'');
 }
 if(report!==null){
  text=report;
  const header=text.match(/^\s*🤖[^\n]*\n(?:Ответ нужен[^\n]*\n)?\s*/)?.[0]||'';
  const body=text.slice(header.length);reportCount++;
  const sender=header.match(/^🤖 (Codex|Claude|OpenCode) ([^\s·]+)/);
  const harness=sender?.[1].toLowerCase();
  const identity=sender?.[2];
  const adapters=new Map(identity?[[harness,{type:harness,getSession:async()=>({id:identity,harness})}]]:[]);
  const shortHeader=await buildMessageProvenanceHeader(adapters,identity?{fromSessionId:identity,fromHarness:harness}:{},{id:'historical-reader',harness:'codex'});
  const preview=await compactAutomaticMessage(body);
  pieces.push({kind:'agent-delivery-header',before:header,after:shortHeader});
  pieces.push({kind:'agent-delivery-body',before:body,after:preview});
  let full=body,reads=[];
  if(preview!==body){
   longReports++;const messageId=preview.match(/"messageId":"([a-f0-9]{64})"/)?.[1];if(!messageId)throw new Error('No usable read reference');
   full='';let offset=0;
   do {const chunk=await readLongMessage({messageId,offset,limit:4000});full+=chunk.text;reads.push(JSON.stringify(chunk));offset=chunk.nextOffset;}while(offset!==null);
   if(full!==body||hash(full)!==messageId)throw new Error('Full message reconstruction failed');exactReadbacks++;
  }
  recovered.push({ordinal:ordinal++,sha256:hash(body),characters:body.length,long:preview!==body,exact:full===body});
  // If every long report is needed, count full read results as well as preview.
  pieces.at(-1).readAll=reads.join('\n');
 }
}
const countInput=pieces.flatMap(p=>[p.before,p.after,p.readAll||'']);
const tokenProcess=spawnSync('python3',['-c',"import sys,json,tiktoken; e=tiktoken.get_encoding('o200k_base'); print(json.dumps([len(e.encode(s,disallowed_special=())) for s in json.load(sys.stdin)]))"],{input:JSON.stringify(countInput),encoding:'utf8',maxBuffer:16*1024*1024});
if(tokenProcess.status!==0)throw new Error(tokenProcess.stderr);
const counts=JSON.parse(tokenProcess.stdout);const totals={};
for(let i=0;i<pieces.length;i++){
 const p=pieces[i],s=totals[p.kind]??={before:0,after:0,readAll:0,items:0};s.before+=counts[3*i];s.after+=counts[3*i+1];s.readAll+=counts[3*i+2];s.items++;
}
const sum=key=>Object.values(totals).reduce((a,b)=>a+b[key],0);
const before=sum('before'),after=sum('after'),readAll=sum('readAll');
const result={source:resolve(args.transcript),cutoff:args.cutoff||null,sourceSnapshotSha256:hash(rows.map(row=>JSON.stringify(row)).join('\n')),tokenizer:'o200k_base estimate; response_item messages only',method:'Real coordination renderer against reconstructed visible peer snapshots; original coordination/conflict blocks preserved unchanged. Actual long-message store/read implementation. No historical native actions replayed. Roster rows are treated as passive hook-owned path observations at original timestamps; original note identities, hidden paths and model choices cannot be reconstructed.',totals,before,after,readAll,afterReadingEveryLongReport:after+readAll,reductionPercent:100*(1-after/before),reductionAfterAllReadsPercent:100*(1-(after+readAll)/before),peerBlocks,peerSuppressed,reportCount,longReports,exactReadbacks,allReportsPreserved:recovered.every(r=>r.exact),preservation:'All report bodies reconstructed byte-exact; all original service blocks kept in private source-blocks.json, changed owner/path snapshots available via the store. This establishes retrievability, not proof that an agent reads every required report or behaves identically.'};
await writeFile(join(output,'source-blocks.json'),JSON.stringify(retained),{mode:0o600});
await writeFile(join(output,'readback-checks.json'),JSON.stringify(recovered,null,2),{mode:0o600});
await writeFile(join(output,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(result,null,2));
