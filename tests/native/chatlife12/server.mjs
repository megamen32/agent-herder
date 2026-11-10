import http from 'node:http';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto,createHash} from 'node:crypto';
const extension=process.argv[2];
const scope=createHash('sha256').update(JSON.stringify({provider:'chatgpt',user_id:'fixture-user',account_id:'fixture-account'})).digest('hex');
const agent='fixture-agent',instance='browser-44444444-4444-4444-8444-444444444444',connection='fixture',principal='fixture-principal';
const ref='11111111-1111-4111-8111-111111111111';
let seq=0, archived=false, mismatch=false, hideNext=false, hiddenId='', sends=0;
const results=[],tabs=[],data={},messages=[];
const ok=x=>({ok:true,status:200,headers:{get:()=>null},json:async()=>x});
const location={origin:'https://chatgpt.com',pathname:'/',href:'https://chatgpt.com/'};
let activeTab,editor={textContent:'',focus(){}};
const uuid=n=>String(n).padStart(8,'0')+'-0000-4000-8000-000000000000';
const msgNode=m=>({textContent:m.text,getAttribute:()=>m.id,closest:()=>({getAttribute:()=>m.id})});
const button={get disabled(){return !editor.textContent},click(){const text=editor.textContent;editor.textContent='';sends++;messages.push({id:uuid(sends*2),role:'user',text},{id:uuid(sends*2+1),role:'assistant',text:'fixture answer '+sends});location.pathname='/c/'+ref;location.href='https://chatgpt.com'+location.pathname;activeTab.url=location.href;}};
const document={querySelector(s){if(s==='#prompt-textarea')return editor;if(s==='[data-testid="send-button"]')return button;if(s==='[data-message-author-role]')return messages.length?msgNode(messages[0]):null;return null},querySelectorAll(s){if(s.includes('user'))return messages.filter(m=>m.role==='user').map(msgNode);if(s.includes('assistant'))return messages.filter(m=>m.role==='assistant').map(msgNode);return []},execCommand(_c,_s,t){editor.textContent=t}};
const providerFetch=async(path,opts={})=>{
 if(path==='/api/auth/session')return ok({accessToken:'fixture-only',user:{id:mismatch?'other':'fixture-user'},account:{id:'fixture-account'}});
 if(path.startsWith('/backend-api/conversations?'))return ok({items:messages.length&&!archived?[{id:ref,title:'fixture',update_time:10}]:[]});
 if(path.startsWith('/backend-api/conversations/'))return ok({conversation_id:ref,has_more:false,messages:messages.map(m=>({id:m.id,author:{role:m.role},recipient:'all',channel:'final',status:'finished_successfully',end_turn:true,create_time:1,update_time:1,content:{parts:[{text:m.text}]}}))});
 if(path.startsWith('/backend-api/conversation/')){if(opts.method==='PATCH')archived=true;return ok({conversation_id:ref,is_archived:archived});}
 throw Error('unexpected provider path '+path);
};
const chrome={storage:{local:{async get(k){if(typeof k==='string')return {[k]:data[k]};return {...k,...data}},async set(x){Object.assign(data,x)}}},tabs:{async query(){return tabs.slice()},async create({url}){const t={id:tabs.length+1,url,status:'complete'};tabs.push(t);return t},async get(id){return tabs.find(t=>t.id===id)}},scripting:{async executeScript({target,func,args=[]}){activeTab=tabs.find(t=>t.id===target.tabId);if(!activeTab)throw Error('missing tab');const u=new URL(activeTab.url);location.pathname=u.pathname;location.href=u.href;editor={textContent:'',focus(){}};return [{result:await func(...args)}]}}};
const self={UserIOConnections:{subscriptionsForScope:async(_p,s)=>s===scope?[{id:connection}]:[],observeAccount:async()=>{}},UserIO:{call:async(_m,_path,payload)=>{results.push({...payload,principal_id:principal});return {ok:true}}},ChatGPT:{sessionProof:async()=>({ok:true,present:true,proof:'a'.repeat(64)})}};
const ctx=vm.createContext({self,chrome,URL,location,document,crypto:webcrypto,TextEncoder,AbortController,setTimeout,clearTimeout,fetch:providerFetch,console});
for(const f of ['chatgpt-core.js','chatgpt-state.js','scoped-chatgpt.js','agent.js'])vm.runInContext(readFileSync(extension+'/lib/'+f,'utf8'),ctx,{filename:f});
const srv=http.createServer(async(req,res)=>{try {const u=new URL(req.url,'http://127.0.0.1');let body='';for await(const c of req)body+=c;const input=body?JSON.parse(body):{};let out;
 if(u.pathname==='/v1/agent/status')out={agents:[{agent_id:agent,instances:[instance]}]};
 else if(u.pathname==='/v1/agent/commands'){const command={...input,id:agent+':'+(++seq)};if(hideNext && input.action==='gpt_first_send'){hiddenId=command.id;hideNext=false;}out={queued:true,id:command.id};setImmediate(()=>self.Agent.processCommand(command,{connectionId:connection,principalId:principal,agentInstanceId:instance}).catch(e=>console.error(e)));}
 else if(u.pathname==='/v1/agent/results'){if(hiddenId){hiddenId='';res.writeHead(503).end('{}');return;}out={results};}
 else if(u.pathname==='/control'){if(input.mismatch!==undefined)mismatch=input.mismatch;if(input.hideNext!==undefined)hideNext=input.hideNext;out={scope,ref,sends,archived,results:results.map(({id,action})=>({id,action})),messages};}
 else {res.writeHead(404).end();return}res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(out));}catch(e){console.error(e);res.writeHead(500).end('{}')}});
srv.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:srv.address().port,scope,agent,instance,connection,principal})));
