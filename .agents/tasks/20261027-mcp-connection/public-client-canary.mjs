// The browser owns the issued QA token. Transfer it through a private pipe,
// never through model-visible output, arguments, files or environment.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
const [session,namespace]=process.argv.slice(2);
if(!/^[a-z0-9-]{1,16}$/.test(session||'')||!/^[a-z0-9-]{1,16}$/.test(namespace||''))throw Error('Own browser session/namespace required');
let phase='read-own-browser',client;
try{
 const browserEnv={...process.env};delete browserEnv.AGENT_BROWSER_AUTO_CONNECT;
 const script=`(() => ({token: document.querySelector('input[aria-label="Новый bearer-токен MCP"]')?.value, id: document.querySelector('[aria-label="Новый токен MCP"]')?.dataset.tokenId, url: document.querySelector('input[aria-label="Адрес MCP"]')?.value, name: document.querySelector('input[aria-label="Название MCP-подключения"]')?.value}))()`;
 const raw=execFileSync('/home/roomhacker/.npm-global/bin/agent-browser',['--session',session,'--namespace',namespace,'--auto-connect','false','--headed','false','eval',script,'--json'],{encoding:'utf8',env:browserEnv,stdio:['ignore','pipe','pipe'],maxBuffer:65536,timeout:10000});
 const envelope=JSON.parse(raw);
 let data=envelope.data?.result??envelope.result;
 if(typeof data==='string')data=JSON.parse(data);
 if(!data||!/^herder_mcp_[A-Za-z0-9_-]{43}$/.test(data.token||'')||!data.id||!data.name?.startsWith('QA MCP '))throw Error('Own QA issuance not found');
 if(data.url!=='https://agent.bezrabotnyi.com/mcp')throw Error('Unexpected MCP destination');
 const token=data.token,id=data.id,url=data.url;
 const statuses=[];
 phase='public-initialize-and-list';
 client=new Client({name:'herder-connection-browser-QA',version:'1'},{versionNegotiation:{mode:'auto'}});
 const transport=new StreamableHTTPClientTransport(new URL(url),{
  authProvider:{token:async()=>token},
  requestInit:{redirect:'error',credentials:'omit'},
  fetch:async(input,init)=>{
   if(new URL(typeof input==='string'?input:input.url||input.href).href!==url)throw Error('Unexpected MCP request destination');
   if(new Headers(init?.headers).has('cookie'))throw Error('Cookie unexpectedly supplied');
   const response=await fetch(input,{...init,redirect:'error',credentials:'omit',signal:AbortSignal.timeout(10000)});
   statuses.push(response.status);return response;
  },
 });
 await client.connect(transport,{timeout:10000});
 const tools=await client.listTools();
 if(!tools.tools?.length)throw Error('No MCP tools');
 await client.close();client=undefined;
 console.log(JSON.stringify({phase:'public-client-connected',id,tools:tools.tools.length,statuses,cookieSent:false,waitingForUiRevocation:true}));
 phase='wait-ui-revocation';
 const registry=path.join(os.homedir(),'.local/state/agent-herder/settings/mcp-client-tokens.json');
 const deadline=Date.now()+60000;let revoked=false;
 while(Date.now()<deadline){
  const state=JSON.parse(fs.readFileSync(registry,'utf8'));
  if(state.tokens?.find(record=>record.id===id)?.revokedAt){revoked=true;break;}
  await new Promise(resolve=>setTimeout(resolve,500));
 }
 if(!revoked)throw Error('UI revocation not observed');
 phase='public-revoked-refusal';
 const response=await fetch(url,{method:'POST',redirect:'error',credentials:'omit',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:'revoked-auth-probe',method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'revoked-connection-QA',version:'1'}}}),signal:AbortSignal.timeout(10000)});
 await response.body?.cancel();
 console.log(JSON.stringify({phase:'public-revoked-refusal',id,status:response.status}));
 if(response.status!==401)throw Error('Revoked credential was not refused');
}catch{
 console.error(JSON.stringify({phase,error:'Controlled MCP connection check failed; secret values omitted'}));process.exitCode=1;
}finally{try{await client?.close();}catch{}}
