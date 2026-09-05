#!/usr/bin/env node
const endpoint = process.env.AGENT_HERDER_URL || "http://127.0.0.1:18787";
let raw=""; for await (const c of process.stdin) raw+=c;
let input={}; try { input=raw.trim()?JSON.parse(raw):{}; } catch { process.stdout.write("{}"); process.exit(0); }
const event=input.hook_event_name || input.hookEventName || "";
const sessionId=String(input.session_id || input.sessionId || "");
const cwd=String(input.cwd || process.cwd());
const emit=(context)=>process.stdout.write(context?JSON.stringify({hookSpecificOutput:{hookEventName:event,additionalContext:context}}):"{}");
const get=async(url,options)=>{const r=await fetch(url,{...options,signal:AbortSignal.timeout(1200)});if(!r.ok) throw new Error(String(r.status));return r.json()};
const isWriteActivity=(tool,input)=>{
  const n=String(tool||'').toLowerCase();
  if(/(?:write|edit|patch|apply_patch|create_file|delete_file|move_file|rename_file)/.test(n)) return true;
  if(!/(?:bash|shell|terminal|exec|command)/.test(n)) return false;
  const c=typeof input==='string'?input:String(input?.command||input?.cmd||input?.script||'');
  return [/(?:^|[;&|\s])sed\s+-[^\n;]*\bi[^\n;]*/,/(?:^|[;&|\s])perl\s+-[^\n;]*\bi[^\n;]*/,/(?:^|[;&|\s])(?:tee|cp|mv|rm|touch|mkdir|truncate|install)(?:\s|$)/,/(?:^|[;&|\s])git\s+(?:checkout|restore|apply|mv|rm)(?:\s|$)/,/(?:^|[^<])>{1,2}\s*[^&]/].some(r=>r.test(c));
};
const paths=new Set();
function walk(v){if(typeof v==='string'){for(const m of v.matchAll(/\*\*\* (?:Update|Add|Delete) File:\s*([^\n]+)/g))paths.add(m[1].trim());return}if(Array.isArray(v)){for(const x of v)walk(x);return}if(v&&typeof v==='object')for(const [k,x] of Object.entries(v)){if(/^(path|file|file_path|filepath|filename)$/i.test(k)&&typeof x==='string')paths.add(x); else if(/^(paths|files)$/i.test(k)&&Array.isArray(x))for(const q of x)if(typeof q==='string')paths.add(q); walk(x)}}
const post=(path,body)=>fetch(endpoint+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(1200)}).catch(()=>{});
try{
 if(event==='SessionStart'){ await post('/api/coordination/lifecycle',{harness:'zcode',sessionId,cwd,event:'start'}); const q=new URLSearchParams({harness:'zcode',sessionId,cwd,touch:'1'}); const d=await get(`${endpoint}/api/coordination/context?${q}`); emit(d.context||null);
 } else if(event==='UserPromptSubmit'){ await post('/api/coordination/lifecycle',{harness:'zcode',sessionId,cwd,event:'turn-start'}); const q=new URLSearchParams({harness:'zcode',sessionId,cwd,touch:'1'}); const d=await get(`${endpoint}/api/coordination/context?${q}`); emit(d.context||null);
 } else if(event==='SessionEnd'){ await post('/api/coordination/lifecycle',{harness:'zcode',sessionId,cwd,event:'end'}); emit(null);
 } else if(event==='PreToolUse'||event==='PostToolUse'){
   const toolInput=input.tool_input||input.toolInput||{}; const write=isWriteActivity(input.tool_name||input.toolName,toolInput);
   if(write) walk(toolInput); const clean=write?[...paths].map(p=>p.replace(/^\.\//,'')).filter(p=>p&&!p.startsWith('../')).slice(0,32):[];
   const d=await get(`${endpoint}/api/coordination/activity`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({harness:'zcode',sessionId,cwd,paths:clean})}); emit(d.context||null);
 } else emit(null)
}catch{emit(null)}
