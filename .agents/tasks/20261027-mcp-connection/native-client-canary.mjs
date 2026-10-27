// Controlled acceptance: plaintext credential exists only in process memory.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
const base='http://127.0.0.1:18787',url='https://agent.bezrabotnyi.com/mcp';
const dir='.tmp/mcp-connection-20261027',inputId=crypto.randomUUID();
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(`${dir}/protocol-canary-intent.json`,JSON.stringify({inputId,name:'QA MCP native protocol 20261027',createdAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
let phase='issue',client,token,id,revoked=false;
const receipt={url,cookieSent:false,statuses:[]};
async function owner(body){
 const response=await fetch(`${base}/api/mcp-connection`,{method:'POST',headers:{'content-type':'application/json',Origin:base},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('Owner operation refused');
 return response.json();
}
async function revoke(){
 const data=await owner({action:'revoke',id});
 if(data.record?.id!==id||!data.record.revokedAt)throw Error('Revocation not confirmed');
 revoked=true;receipt.revokedAt=data.record.revokedAt;
}
try{
 const issued=await owner({action:'issue',name:'QA MCP native protocol 20261027',inputId});
 token=issued.token;id=issued.record?.id;receipt.id=id;
 if(!/^herder_mcp_[A-Za-z0-9_-]{43}$/.test(token||'')||!id)throw Error('Invalid issuance');
 phase='public-initialize-and-list';
 client=new Client({name:'herder-connection-protocol-QA',version:'1'},{versionNegotiation:{mode:'auto'}});
 const transport=new StreamableHTTPClientTransport(new URL(url),{
  authProvider:{token:async()=>token},requestInit:{redirect:'error',credentials:'omit'},
  fetch:async(input,init)=>{
   if(new URL(typeof input==='string'?input:input.url||input.href).href!==url)throw Error('Unexpected destination');
   if(new Headers(init?.headers).has('cookie'))throw Error('Unexpected cookie');
   const response=await fetch(input,{...init,redirect:'error',credentials:'omit',signal:AbortSignal.timeout(10000)});
   receipt.statuses.push(response.status);return response;
  },
 });
 await client.connect(transport,{timeout:10000});
 const tools=await client.listTools();
 if(!tools.tools?.length)throw Error('No tools');
 receipt.tools=tools.tools.length;
 await client.close();client=undefined;
 phase='revoke';await revoke();
 phase='public-revoked-refusal';
 const response=await fetch(url,{method:'POST',redirect:'error',credentials:'omit',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:'revoked-auth-probe',method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'revoked-connection-QA',version:'1'}}}),signal:AbortSignal.timeout(10000)});
 await response.body?.cancel();receipt.revokedStatus=response.status;
 if(response.status!==401)throw Error('Revoked token accepted');
 receipt.ok=true;
}catch{
 receipt.ok=false;receipt.failedPhase=phase;process.exitCode=1;
}finally{
 try{await client?.close();}catch{}
 // Unknown revocation is never retried; read metadata before further action.
 if(id&&!revoked&&phase!=='revoke')try{await revoke();}catch{receipt.cleanupUnconfirmed=true;}
 fs.writeFileSync(`${dir}/protocol-canary.json`,JSON.stringify(receipt,null,2),{mode:0o600});
 console.log(JSON.stringify(receipt));
}
