import { expect, it, vi } from 'vitest';
const polling = vi.hoisted(() => ({ enabled: false }));
vi.mock('../src/harness-runtime-settings.js',()=>({liveHarnessPollingEnabled:()=>polling.enabled}));
import { BrowserTurnAutopilotObserver } from '../src/autopilot/browser-turn-observer.js';
import type { HarnessAdapter } from '../src/types/index.js';
import { ChatGptMacCdpDriver } from '../src/adapters/chatgpt-mac-cdp-driver.js';
import { BrowserChatAdapter } from '../src/adapters/browser-chat.js';
import { runInNewContext } from 'node:vm';
import { chatgptPassiveHistoryScript } from '../src/adapters/chatgpt-passive-history.js';

it('never directly refreshes a stalled ChatGPT session even when polling is enabled',async()=>{
 polling.enabled=true;
 vi.useFakeTimers();
 try {
  const refresh=vi.fn(async()=>true);
  const adapter={listBackgroundSessions:async()=>[{id:'chatgpt::s1',status:'running',cwd:'/tmp/fixture',lastActivity:'2026-01-01T00:00:00Z'}],refreshSession:refresh};
  const observer=new BrowserTurnAutopilotObserver({harnesses:['chatgpt'],adapters:new Map([['chatgpt',adapter as unknown as HarnessAdapter]]),
   supervisor:{sendMessage:vi.fn()},submit:vi.fn(),enabled:async()=>true,held:async()=>false,stallMs:60000,autoContinue:false,staleRefreshMs:300000});
  await observer.observeOnce();vi.advanceTimersByTime(300001);await observer.observeOnce();
  expect(refresh).not.toHaveBeenCalled();
 } finally { vi.useRealTimers();polling.enabled=false; }
});

it('uses only passive inventory for ChatGPT even when normal polling is enabled',async()=>{
 polling.enabled=true;
 try {
  const live=vi.fn(async()=>{throw Error('direct background inventory forbidden');});
  const passive=vi.fn(async()=>[]);
  const adapter={listSessions:live,listBackgroundSessions:passive};
  const observer=new BrowserTurnAutopilotObserver({harnesses:['chatgpt'],adapters:new Map([['chatgpt',adapter as unknown as HarnessAdapter]]),
   supervisor:{sendMessage:vi.fn()},submit:vi.fn(),enabled:async()=>true,held:async()=>false,stallMs:60000,autoContinue:false});
  await observer.observeOnce();
  expect(passive).toHaveBeenCalledOnce();expect(live).not.toHaveBeenCalled();
 } finally { polling.enabled=false; }
});

it('reads passive ChatGPT inventory without live listing or history prewarming',async()=>{
 polling.enabled=true;
 try {
  const listChats=vi.fn(async()=>{throw Error('live list forbidden');});
  const getMessages=vi.fn(async()=>{throw Error('prewarm forbidden');});
  const listObservedChats=vi.fn(async()=>[{id:'s1',title:'fixture',working:false,unread:false,updatedAt:new Date().toISOString()}]);
  const adapter=new BrowserChatAdapter({listChats,listObservedChats,getMessages,sendMessage:vi.fn()} as any,{id:'chatgpt',name:'ChatGPT',harness:'chatgpt',cwd:'/tmp/fixture'});
  expect(await adapter.listBackgroundSessions()).toHaveLength(1);
  await new Promise(resolve=>setTimeout(resolve,10));
  expect(listObservedChats).toHaveBeenCalledOnce();expect(listChats).not.toHaveBeenCalled();expect(getMessages).not.toHaveBeenCalled();
 } finally { polling.enabled=false; }
});

it('starts ChatGPT inventory passively even when live polling is enabled',async()=>{
 polling.enabled=true;
 try {
  const listChats=vi.fn(async()=>{throw Error('startup background fetch forbidden');});
  const listObservedChats=vi.fn(async()=>[]);
  const adapter=new BrowserChatAdapter({listChats,listObservedChats,sendMessage:vi.fn()} as any,{id:'chatgpt',name:'ChatGPT',harness:'chatgpt',cwd:'/tmp/fixture'});
  await adapter.init();
  await adapter.listSessions();
  await adapter.findNamedSessions('fixture','/tmp/fixture');
  expect(listObservedChats).toHaveBeenCalledTimes(3);expect(listChats).not.toHaveBeenCalled();
 } finally { polling.enabled=false; }
});

it('keeps ChatGPT autopilot working using only passively observed history',async()=>{
 let status:'running'|'idle'='running';
 const messages=[{id:'u1',role:'user',text:'continue the task'},{id:'a1',role:'assistant',text:'finished'}];
 const adapter={
  listBackgroundSessions:vi.fn(async()=>[{id:'chatgpt::s1',harness:'chatgpt',status,cwd:'/tmp/fixture',lastActivity:new Date().toISOString()}]),
  getBackgroundMessages:vi.fn(async()=>messages),
  invalidateHistory:vi.fn(async()=>{throw Error('background network refresh forbidden');}),
  getSessionMessages:vi.fn(async()=>{throw Error('foreground history fetch forbidden');}),
 };
 const submit=vi.fn();
 const observer=new BrowserTurnAutopilotObserver({harnesses:['chatgpt'],adapters:new Map([['chatgpt',adapter as unknown as HarnessAdapter]]),
  supervisor:{sendMessage:vi.fn(async()=>({ok:true}))},submit,enabled:async()=>true,held:async()=>false,stallMs:60000,autoContinue:false});
 await observer.observeOnce();status='idle';await observer.observeOnce();
 expect(adapter.getBackgroundMessages).toHaveBeenCalledWith('chatgpt::s1');
 expect(adapter.invalidateHistory).not.toHaveBeenCalled();expect(adapter.getSessionMessages).not.toHaveBeenCalled();
 expect(submit).toHaveBeenCalledTimes(1);
});

it('retries a completed turn when passive history becomes available',async()=>{
 let status:'running'|'idle'='running';
 let available=false;
 const adapter={listBackgroundSessions:async()=>[{id:'chatgpt::s1',status,cwd:'/tmp/fixture',lastActivity:'2026-01-01T00:00:00Z'}],
  getBackgroundMessages:async()=>available?[{id:'a1',role:'assistant',text:'finished'}]:null};
 const submit=vi.fn();
 const observer=new BrowserTurnAutopilotObserver({harnesses:['chatgpt'],adapters:new Map([['chatgpt',adapter as unknown as HarnessAdapter]]),
  supervisor:{sendMessage:vi.fn(async()=>({ok:true}))},submit,enabled:async()=>true,held:async()=>false,stallMs:60000,autoContinue:false});
 await observer.observeOnce();status='idle';await observer.observeOnce();
 expect(submit).not.toHaveBeenCalled();
 available=true;await observer.observeOnce();expect(submit).toHaveBeenCalledTimes(1);
 await observer.observeOnce();expect(submit).toHaveBeenCalledTimes(1);
});

it('requests a bounded browser visit when completed ChatGPT history is not yet visible',async()=>{
 let status:'running'|'idle'='running';
 const visit=vi.fn(async()=>{});
 const adapter={listBackgroundSessions:async()=>[{id:'chatgpt::s1',status,cwd:'/tmp/fixture',lastActivity:'2026-01-01T00:00:00Z'}],
  getBackgroundMessages:async()=>null,requestBackgroundVisit:visit};
 const observer=new BrowserTurnAutopilotObserver({harnesses:['chatgpt'],adapters:new Map([['chatgpt',adapter as unknown as HarnessAdapter]]),
  supervisor:{sendMessage:vi.fn(async()=>({ok:true}))},submit:vi.fn(),enabled:async()=>true,held:async()=>false,stallMs:60000,autoContinue:false});
 await observer.observeOnce();status='idle';await observer.observeOnce();
 expect(visit).toHaveBeenCalledWith('chatgpt::s1');
});

it.each(['disabled','held'])('does not visit a ChatGPT session when autopilot is %s',async(reason)=>{
 let status:'running'|'idle'='running';const visit=vi.fn(async()=>{});
 const adapter={listBackgroundSessions:async()=>[{id:'chatgpt::s1',status,cwd:'/tmp/fixture',lastActivity:'2026-01-01T00:00:00Z'}],
  getBackgroundMessages:async()=>null,requestBackgroundVisit:visit};
 const observer=new BrowserTurnAutopilotObserver({harnesses:['chatgpt'],adapters:new Map([['chatgpt',adapter as unknown as HarnessAdapter]]),
  supervisor:{sendMessage:vi.fn(async()=>({ok:true}))},submit:vi.fn(),enabled:async()=>reason!=='disabled',held:async()=>reason==='held',stallMs:60000,autoContinue:false});
 await observer.observeOnce();status='idle';await observer.observeOnce();expect(visit).not.toHaveBeenCalled();
});

it('intercepts page-owned history requests without making one, and backs off after 429',async()=>{
 let calls=0;let now=1000;
 const response={status:429,ok:false,headers:{get:()=> '600'},clone(){return this;}};
 const win={fetch:async()=>{calls++;return response;}};
 const context:any={window:win,location:{origin:'https://chatgpt.com',pathname:'/c/6aa7e444-0ba4-83ed-992f-d2afaa3159e8'},
  document:{querySelectorAll:()=>[]},Date:{now:()=>now},URL,Number,Math,Array,Object,Set,JSON};context.globalThis=context;
 const read=runInNewContext('('+chatgptPassiveHistoryScript()+')',context);
 await read();expect(calls).toBe(0);
 await win.fetch('/backend-api/conversation/6aa7e444-0ba4-83ed-992f-d2afaa3159e8');
 expect(calls).toBe(1);expect((await read()).cooldownUntil).toBe(now+600000);
 now+=1000;await win.fetch('/backend-api/conversation/6aa7e444-0ba4-83ed-992f-d2afaa3159e8');
 expect((await read()).cooldownUntil).toBeGreaterThanOrEqual(now+600000);
});

it('observes a 429 when the page passes a URL object to fetch',async()=>{
 const response={status:429,ok:false,headers:{get:()=>null}};
 const win={fetch:async()=>response};
 const context:any={window:win,location:{origin:'https://chatgpt.com',pathname:'/'},document:{querySelectorAll:()=>[]},Date,URL,Number,Math,Array,Object,Set,JSON};context.globalThis=context;
 const read=runInNewContext('('+chatgptPassiveHistoryScript()+')',context);
 read();const before=Date.now();await win.fetch(new URL('https://chatgpt.com/backend-api/conversations'));
 expect(read().cooldownUntil).toBeGreaterThanOrEqual(before+300000);
});

it('does not use an old intercepted transcript when the current page has no messages',()=>{
 const id='6aa7e444-0ba4-83ed-992f-d2afaa3159e8';
 const context:any={window:{fetch:async()=>{}},location:{origin:'https://chatgpt.com',pathname:`/c/${id}`},
  document:{querySelectorAll:()=>[]},Date,URL,Number,Math,Array,Object,Set,JSON,
  __herderPassiveHistories:{[id]:{at:Date.now(),messages:[{id:'old',role:'assistant',text:'old answer'}]}}};context.globalThis=context;
 const read=runInNewContext('('+chatgptPassiveHistoryScript()+')',context);
 expect(read().messages).toEqual([]);
});

it('does not drop a legacy user DOM message with missing ID and expose an older answer',()=>{
 const id='6aa7e444-0ba4-83ed-992f-d2afaa3159e8';
 const old={innerText:'old answer',getAttribute:(n:string)=>n==='data-message-author-role'?'assistant':'a1',closest:()=>null};
 const newer={innerText:'new question',getAttribute:(n:string)=>n==='data-message-author-role'?'user':null,closest:()=>null};
 const document={querySelectorAll:(s:string)=>s==='[data-message-author-role]'?[old,newer]:[]};
 const context:any={window:{fetch:async()=>{}},location:{origin:'https://chatgpt.com',pathname:`/c/${id}`},document,Date,URL,Number,Math,Array,Object,Set,JSON};context.globalThis=context;
 const read=runInNewContext('('+chatgptPassiveHistoryScript()+')',context);
 expect(read().messages).toEqual([]);
});

it('detects idle when a hidden composer precedes the visible one',()=>{
 const id='6aa7e444-0ba4-83ed-992f-d2afaa3159e8';
 const hidden={getClientRects:()=>[]}, visible={getClientRects:()=>[{}]};
 const voice={getClientRects:()=>[{}],getAttribute:(name:string)=>name==='aria-label'?'Начать голосовой разговор':null};
 const document={querySelector:()=>hidden,querySelectorAll:(selector:string)=>selector==='button'?[voice]:selector.includes('data-composer-markdown')?[hidden,visible]:[]};
 const context:any={window:{fetch:async()=>{}},location:{origin:'https://chatgpt.com',pathname:`/c/${id}`},document,Date,URL,Number,Math,Array,Object,Set,JSON};context.globalThis=context;
 const read=runInNewContext('('+chatgptPassiveHistoryScript()+')',context);
 expect(read().phase).toBe('idle');
});

it('reads current user and assistant DOM messages with native IDs and exact conversation binding',()=>{
 const id='6aa7e444-0ba4-83ed-992f-d2afaa3159e8',userId='11111111-1111-4111-8111-111111111111',assistantId='22222222-2222-4222-8222-222222222222';
 let now=1_000_000;
 const user={innerText:'question',matches:(s:string)=>s==='[data-user-message-bubble]',closest:()=>({getAttribute:()=>JSON.stringify([userId])})};
 const assistant={innerText:'answer',matches:()=>false,getAttribute:(name:string)=>name==='data-chatgpt-selection-conversation-id'?id:assistantId};
 const document={querySelectorAll:(selector:string)=>selector.includes('data-user-message-bubble')?[user,assistant]:[]};
 const context:any={window:{fetch:async()=>{}},location:{origin:'https://chatgpt.com',pathname:`/c/${id}`},document,Date:{now:()=>now},URL,Number,Math,Array,Object,Set,JSON};context.globalThis=context;
 const read=runInNewContext('('+chatgptPassiveHistoryScript()+')',context);
 expect(read().freshVisit).toBe(false);
 context.__herderBackgroundVisit={id,at:now};
 expect(read().messages.map((m:any)=>[m.id,m.role,m.text])).toEqual([[userId,'user','question'],[assistantId,'assistant','answer']]);
 now+=300_000;expect(read().freshVisit).toBe(false);now-=300_000;
 assistant.getAttribute=(name:string)=>name==='data-chatgpt-selection-conversation-id'?'another-session':assistantId;
 expect(read().messages).toEqual([]);
});

it('uses an intercepted history only when it was captured after the exact owned visit',async()=>{
 const id='6aa7e444-0ba4-83ed-992f-d2afaa3159e8';let now=1000000;
 const response={status:200,ok:true,headers:{get:()=>null},clone(){return {json:async()=>({conversation_id:id,current_node:'a',mapping:{u:{parent:null,message:{id:'u',author:{role:'user'},content:{parts:['question']}}},a:{parent:'u',message:{id:'a',author:{role:'assistant'},content:{parts:['answer']}}}}})}}};
 const win={fetch:async()=>response};
 const context:any={window:win,location:{origin:'https://chatgpt.com',pathname:`/c/${id}`},document:{querySelectorAll:()=>[]},Date:{now:()=>now},URL,Number,Math,Array,Object,Set,JSON};context.globalThis=context;
 const read=runInNewContext('('+chatgptPassiveHistoryScript()+')',context);
 read();context.__herderBackgroundVisit={id,at:now};now+=1;await win.fetch(`/backend-api/conversation/${id}`);
 await new Promise(resolve=>setTimeout(resolve,0));
 expect(read().messages.map((m:any)=>m.id)).toEqual(['u','a']);
 context.__herderBackgroundVisit={id,at:now+1};expect(read().messages).toEqual([]);
});

it('invalidates intercepted history when the page sends a new conversation turn',async()=>{
 const id='6aa7e444-0ba4-83ed-992f-d2afaa3159e8',now=1000000;
 const response={status:200,ok:true,headers:{get:()=>null},clone(){return {json:async()=>({conversation_id:id,current_node:'a',mapping:{a:{parent:null,message:{id:'a',author:{role:'assistant'},content:{parts:['old']}}}}})}}};
 const win={fetch:async(..._args:any[])=>response};
 const context:any={window:win,location:{origin:'https://chatgpt.com',pathname:`/c/${id}`},document:{querySelectorAll:()=>[]},Date:{now:()=>now},URL,Number,Math,Array,Object,Set,JSON};context.globalThis=context;
 const read=runInNewContext('('+chatgptPassiveHistoryScript()+')',context);
 read();context.__herderBackgroundVisit={id,at:now};await win.fetch(`/backend-api/conversation/${id}`);await new Promise(resolve=>setTimeout(resolve,0));
 expect(read().messages).toHaveLength(1);
 await win.fetch('/backend-api/conversation',{method:'POST',body:JSON.stringify({action:'next',messages:[{id:'new'}]})});expect(read().messages).toHaveLength(0);
});

it('keeps fresh history when the page makes a non-send conversation POST',async()=>{
 const id='6aa7e444-0ba4-83ed-992f-d2afaa3159e8',now=1000000;
 const response={status:200,ok:true,headers:{get:()=>null},clone(){return {json:async()=>({conversation_id:id,current_node:'a',mapping:{a:{parent:null,message:{id:'a',author:{role:'assistant'},content:{parts:['answer']}}}}})}}};
 const win={fetch:async(..._args:any[])=>response};
 const context:any={window:win,location:{origin:'https://chatgpt.com',pathname:`/c/${id}`},document:{querySelectorAll:()=>[]},Date:{now:()=>now},URL,Number,Math,Array,Object,Set,JSON};context.globalThis=context;
 const read=runInNewContext('('+chatgptPassiveHistoryScript()+')',context);
 read();context.__herderBackgroundVisit={id,at:now};await win.fetch(`/backend-api/conversation/${id}`);await new Promise(resolve=>setTimeout(resolve,0));
 await win.fetch('/backend-api/f/conversation',{method:'POST',body:JSON.stringify({action:'prepare'})});
 expect(read().messages).toHaveLength(1);
});

it('captures the page-owned plural conversation response after navigation init',async()=>{
 const id='6aa7e444-0ba4-83ed-992f-d2afaa3159e8',now=1000000;
 const response={status:200,ok:true,headers:{get:()=>null},clone(){return {json:async()=>({conversation_id:id,current_node:'a',mapping:{a:{parent:null,message:{id:'a',author:{role:'assistant'},content:{parts:['answer']}}}}})}}};
 const win={fetch:async(..._args:any[])=>response};
 const context:any={window:win,location:{origin:'https://chatgpt.com',pathname:`/c/${id}`},document:{querySelectorAll:()=>[]},Date:{now:()=>now},URL,Number,Math,Array,Object,Set,JSON};context.globalThis=context;
 const read=runInNewContext('('+chatgptPassiveHistoryScript()+')',context);
 read();context.__herderBackgroundVisit={id,at:now};
 await win.fetch('/backend-api/conversation/init',{method:'POST',body:'{}'});
 await win.fetch(`/backend-api/conversations/${id}`);await new Promise(resolve=>setTimeout(resolve,0));
 expect(read().messages.map((m:any)=>m.id)).toEqual(['a']);
});

it('invalidates the visit if an init request contains messages',async()=>{
 const id='6aa7e444-0ba4-83ed-992f-d2afaa3159e8',now=1000000;
 const win={fetch:async()=>({status:200,ok:true,headers:{get:()=>null}})};
 const context:any={window:win,location:{origin:'https://chatgpt.com',pathname:`/c/${id}`},document:{querySelectorAll:()=>[]},Date:{now:()=>now},URL,Number,Math,Array,Object,Set,JSON};context.globalThis=context;
 const read=runInNewContext('('+chatgptPassiveHistoryScript()+')',context);
 read();context.__herderBackgroundVisit={id,at:now};
 await win.fetch('/backend-api/conversation/init',{method:'POST',body:JSON.stringify({messages:[{id:'new'}]})});
 expect(context.__herderBackgroundVisit).toBeNull();
});

it('reads only the currently visible exact ChatGPT session without starting a fetch',async()=>{
 const native='6aa7e444-0ba4-83ed-992f-d2afaa3159e8';
 const calls:string[]=[];
 const tools={call:vi.fn(async(name:string,args:any={})=>{
  calls.push(name);
  if(name==='list_pages')return `1: ChatGPT (https://chatgpt.com/c/${native})`;
  expect(name).toBe('evaluate_script');
  expect(args.function).not.toMatch(/\bfetch\s*\(/);
  return '```json\n'+JSON.stringify({sessionId:native,phase:'idle',freshVisit:true,messages:[{id:'m1',role:'user',text:'hello'},{id:'m2',role:'assistant',text:'done'}]})+'\n```';
 })};
 const driver=new ChatGptMacCdpDriver(tools);
 expect(await driver.getObservedMessages(native)).toMatchObject([{id:'m1',role:'user'},{id:'m2',role:'assistant'}]);
 expect(await driver.getObservedMessages('6aa7e444-0ba4-83ed-992f-d2afaa3159e9')).toBeNull();
 expect(calls).not.toContain('new_page');expect(calls).not.toContain('navigate_page');
});

it('requires a fresh owned visit while comparing already-open tabs',async()=>{
 const native='6aa7e444-0ba4-83ed-992f-d2afaa3159e8';let fresh=false;
 const tools={call:vi.fn(async(name:string,args:any={})=>name==='list_pages'
  ? `1: ChatGPT (https://chatgpt.com/c/${native})\n2: ChatGPT (https://chatgpt.com/c/${native})`
  : '```json\n'+JSON.stringify({sessionId:native,phase:'idle',freshVisit:fresh&&args.pageId===2,messages:[{id:'a1',role:'assistant',text:'done'}]})+'\n```')};
 const driver=new ChatGptMacCdpDriver(tools);
 expect(await driver.getObservedMessages(native)).toBeNull();
 fresh=true;expect(await driver.getObservedMessages(native)).toMatchObject([{id:'a1',role:'assistant'}]);
});

it('does not treat a still-generating page as a completed turn',async()=>{
 const native='6aa7e444-0ba4-83ed-992f-d2afaa3159e8';
 const tools={call:vi.fn(async(name:string)=>name==='list_pages'
  ? `1: ChatGPT (https://chatgpt.com/c/${native})`
  : '```json\n'+JSON.stringify({sessionId:native,phase:'generating',messages:[{id:'m1',role:'assistant',text:'partial'}]})+'\n```')};
 expect(await new ChatGptMacCdpDriver(tools).getObservedMessages(native)).toBeNull();
});

it('does not treat a user-only passive transcript as a completed turn',async()=>{
 const native='6aa7e444-0ba4-83ed-992f-d2afaa3159e8';
 const tools={call:vi.fn(async(name:string)=>name==='list_pages'
  ? `1: ChatGPT (https://chatgpt.com/c/${native})`
  : '```json\n'+JSON.stringify({sessionId:native,phase:'idle',messages:[{id:'m1',role:'user',text:'pending'}]})+'\n```')};
 expect(await new ChatGptMacCdpDriver(tools).getObservedMessages(native)).toBeNull();
});

it('does not hide a newer user turn whose message identity is missing',async()=>{
 const native='6aa7e444-0ba4-83ed-992f-d2afaa3159e8';
 const tools={call:vi.fn(async(name:string)=>name==='list_pages'
  ? `1: ChatGPT (https://chatgpt.com/c/${native})`
  : '```json\n'+JSON.stringify({sessionId:native,phase:'idle',messages:[{id:'a1',role:'assistant',text:'old'},{id:'',role:'user',text:'new'}]})+'\n```')};
 expect(await new ChatGptMacCdpDriver(tools).getObservedMessages(native)).toBeNull();
});

it('passes a 429 observed in an existing tab to the shared navigation budget',async()=>{
 const native='6aa7e444-0ba4-83ed-992f-d2afaa3159e8', until=Date.now()+600000;
 const tools={call:vi.fn(async(name:string)=>name==='list_pages'
  ? `1: ChatGPT (https://chatgpt.com/c/${native})`
  : '```json\n'+JSON.stringify({sessionId:native,phase:'idle',last429:'event-1',cooldownUntil:until,messages:[]})+'\n```')};
 const driver=new ChatGptMacCdpDriver(tools);const observe429=vi.fn(()=>true);
 Object.defineProperty(driver,'backgroundBudget',{value:{observe429,reserve:()=>false},writable:true});
 expect(await driver.getObservedMessages(native)).toBeNull();
 expect(observe429).toHaveBeenCalledWith('event-1',until);
 await driver.visitBackgroundChat(native);
 expect(tools.call).not.toHaveBeenCalledWith('new_page',expect.anything());
});

it('does not accept an idle duplicate tab while the same chat is generating elsewhere',async()=>{
 const native='6aa7e444-0ba4-83ed-992f-d2afaa3159e8';
 const tools={call:vi.fn(async(name:string,args:any={})=>name==='list_pages'
  ? `1: ChatGPT (https://chatgpt.com/c/${native})\n2: ChatGPT (https://chatgpt.com/c/${native})`
  : '```json\n'+JSON.stringify({sessionId:native,phase:args.pageId===1?'idle':'generating',messages:[{id:'m1',role:'assistant',text:'old'}]})+'\n```')};
 expect(await new ChatGptMacCdpDriver(tools).getObservedMessages(native)).toBeNull();
});

it('does not open a ChatGPT tab when paused background inventory has no tab',async()=>{
 const tools={call:vi.fn(async(name:string)=>{
  if(name==='list_pages')return '';
  throw Error(`unexpected ${name}`);
 })};
 const driver=new ChatGptMacCdpDriver(tools);
 expect(await driver.listChats()).toEqual([]);
 expect(tools.call).not.toHaveBeenCalledWith('new_page',expect.anything());
});

it('does not open a tab for passive inventory even if live polling is enabled',async()=>{
 polling.enabled=true;
 try {
  const tools={call:vi.fn(async(name:string)=>{
   if(name==='list_pages')return '';
   throw Error(`unexpected ${name}`);
  })};
  expect(await new ChatGptMacCdpDriver(tools).listObservedChats()).toEqual([]);
  expect(tools.call).not.toHaveBeenCalledWith('new_page',expect.anything());
 } finally {polling.enabled=false;}
});
