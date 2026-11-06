import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { ZaiCdpDriver } from '../src/adapters/zai-cdp-driver.ts';
import { BrowserChatAdapter } from '../src/adapters/browser-chat.ts';

const id = '11111111-1111-4111-8111-111111111111';
const wait = ms => new Promise(r => setTimeout(r, ms));

export async function runCanary() {
  const dir = await mkdtemp(join(tmpdir(), 'herder-zai-canary-'));
  const old = Object.fromEntries(['AGENT_HERDER_BROWSER_DRAFT_ROOT','AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT','AGENT_HERDER_BROWSER_CHAT_CACHE_ROOT','AGENT_HERDER_AUTOPILOT_STATE_DIR'].map(k => [k, process.env[k]]));
  process.env.AGENT_HERDER_BROWSER_DRAFT_ROOT = join(dir, 'drafts');
  process.env.AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT = join(dir, 'inventory');
  process.env.AGENT_HERDER_BROWSER_CHAT_CACHE_ROOT = join(dir, 'history');
  process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR = join(dir, 'state');
  const requests = [], blocked = [];
  let submitted = '';
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      return res.end(`<div id="chat-group-tab-zai-web">test</div><button data-selected="true"><div dir="auto">Local fixture chat</div></button><textarea placeholder="Send a Message"></textarea><button id="send-message-button">Send</button><script>history.replaceState({},'', '/c/${id}');document.querySelector('#send-message-button').onclick=async()=>{const t=document.querySelector('textarea');const value=t.value;t.value='';await fetch('/fixture/send',{method:'POST',body:value});};</script>`);
    }
    if (req.url === '/fixture/send' && req.method === 'POST') {
      let body=''; req.on('data', chunk => body += chunk); req.on('end', () => { submitted=body; res.end('{}'); }); return;
    }
    if (req.url.startsWith('/api/v1/chats/?')) return res.end(JSON.stringify([{id,title:'Local fixture chat'}]));
    if (req.url === `/api/v1/chats/${id}`) return res.end(JSON.stringify({id,user_id:'fixture-account',chat:{history:{messages: submitted ? {u:{},a:{}} : {}}}}));
    if (req.url === `/api/v1/chats/${id}/messages/batch`) return res.end(JSON.stringify({chat_id:id,data:{u:{id:'u',role:'user',content:submitted},a:{id:'a',role:'assistant',content:'fixture deterministic response'}}}));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const child = spawn('/usr/bin/google-chrome', ['--headless=new','--no-sandbox','--disable-gpu','--disable-quic','--disable-background-networking','--no-first-run','--no-default-browser-check','--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=<-loopback>','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--user-data-dir=${join(dir,'profile')}`,'about:blank'], {stdio:'ignore'});
  let ws;
  try {
    let port;
    for (let i=0;i<100;i++) { try { port = (await readFile(join(dir,'profile','DevToolsActivePort'),'utf8')).split('\n')[0]; break; } catch { if (child.exitCode !== null) throw new Error(`Chrome exited ${child.exitCode}`); await wait(100); } }
    if (!port) throw new Error('Chrome DevTools did not start');
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});
    let seq=0; const pending=new Map();
    const call=(method,params={})=>new Promise((resolve,reject)=>{const n=++seq;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});
    ws.on('message', async raw => {
      const msg=JSON.parse(raw);
      if (msg.id) { const p=pending.get(msg.id); if (!p) return; pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); return; }
      if (msg.method !== 'Fetch.requestPaused') return;
      const {requestId,request}=msg.params;
      try {
        const url=new URL(request.url);
        if (url.origin !== 'https://chat.z.ai') { blocked.push(request.url); await call('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'}); return; }
        const response=await fetch(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`,{method:request.method, ...(request.postData ? {body:request.postData} : {})});
        const body=Buffer.from(await response.arrayBuffer()).toString('base64');
        await call('Fetch.fulfillRequest',{requestId,responseCode:response.status,responseHeaders:[{name:'content-type',value:response.headers.get('content-type') || 'application/octet-stream'}],body});
      } catch { await call('Fetch.failRequest',{requestId,errorReason:'Failed'}).catch(()=>{}); }
    });
    await call('Fetch.enable',{patterns:[{urlPattern:'*'}]});
    await call('Page.enable'); await call('Runtime.enable');
    await call('Page.navigate',{url:'https://chat.z.ai/'});
    for(let i=0;i<100;i++){const r=await call('Runtime.evaluate',{expression:'location.origin === "https://chat.z.ai" && document.readyState === "complete"',returnByValue:true});if(r.result.value)break;await wait(50);}
    const evalJs=async expression=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);return r.result.value;};
    const origin=await evalJs('location.origin');
    await evalJs('fetch("https://outside.invalid/probe").catch(() => null)');
    const tools={async call(name,args={}) {
      if(name==='list_pages') return `1: fixture (${await evalJs('location.href')}) [selected]`;
      if(name==='navigate_page') { await call('Page.navigate',{url:args.url}); for(let i=0;i<100;i++){if(await evalJs('location.pathname === '+JSON.stringify(new URL(args.url).pathname)+' && document.readyState === "complete"')) return ''; await wait(50);} throw new Error('navigation timeout'); }
      if(name==='take_snapshot') return 'uid=fixture textbox "Send a Message"';
      if(name==='fill') { await evalJs(`document.querySelector('textarea').value=${JSON.stringify(args.value)}`); return ''; }
      if(name==='evaluate_script') return '```json\n'+JSON.stringify(await evalJs(`(${args.function})()`))+'\n```';
      throw new Error(`Unexpected tool ${name}`);
    }};
    const driver=new ZaiCdpDriver(tools,1,0);
    const adapter=new BrowserChatAdapter(driver,{id:'zai',name:'ZAI',harness:'zai',cwd:'/fixture'});
    const sent=await adapter.sendMessage('route:'+id,{message:'fixture prompt'});
    for(let i=0;i<100 && !submitted;i++) await wait(20);
    const messages=await adapter.getSessionMessages('route:'+id);
    const sessions=await adapter.listSessions();
    return {origin,sent,messages,sessions,requests,blocked,submitted};
  } finally {
    if(ws) ws.close();
    child.kill('SIGTERM'); await Promise.race([new Promise(r=>child.once('exit',r)),wait(2000)]);
    if(child.exitCode===null) child.kill('SIGKILL');
    await new Promise(r=>server.close(r));
    for(const [k,v] of Object.entries(old)) v===undefined ? delete process.env[k] : process.env[k]=v;
    await rm(dir,{recursive:true,force:true});
  }
}
