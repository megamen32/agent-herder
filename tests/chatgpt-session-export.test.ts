import { describe, it, expect, vi } from 'vitest';
import { BrowserChatAdapter } from '../src/adapters/browser-chat.js';
import { chatgptFullConversationApiScript, chatgptConversationMessages } from '../src/adapters/chatgpt-full-conversation.js';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

describe('ChatGPT full session export', () => {
  it('reconciles 200 messages without invoking full export, while explicit export stays complete', async () => {
    const id='6aa7e444-0ba4-83ed-992f-d2afaa3159e8';
    const messages=[{id:'input',role:'user',text:'question'},{id:'reply',role:'assistant',text:'answer'}];
    const getMessages=vi.fn(async()=>messages);
    const getRawConversation=vi.fn<(...args: string[]) => Promise<unknown>>(async()=>{throw new Error('ChatGPT history unavailable: read_cooldown');});
    const adapter=new BrowserChatAdapter({listChats:async()=>[],sendMessage:async()=>({}),getMessages,getRawConversation} as any,
      {id:'chatgpt',name:'ChatGPT',harness:'chatgpt',cwd:'/tmp/chatgpt'}, '/tmp/chatgpt', false, true);
    expect(await adapter.getSessionMessages(id,200)).toEqual(messages);
    expect(getMessages).toHaveBeenCalledWith(id);
    expect(getRawConversation).not.toHaveBeenCalled();
    const data={conversation_id:id,mapping:Object.fromEntries(Array.from({length:240},(_,i)=>[String(i),{message:{id:String(i)}}]))};
    getRawConversation.mockImplementation(async()=>data);
    const raw=await adapter.getRawTranscript(id);
    expect(raw?.complete).toBe(true);
    expect(Object.keys(JSON.parse(Buffer.from(raw!.bytes).toString()).mapping)).toHaveLength(240);
    expect(getRawConversation).toHaveBeenCalledExactlyOnceWith(id);
  });
  it('retrieves the full native mapping without the recent-turn truncation', async () => {
    const id='6aa7e444-0ba4-83ed-992f-d2afaa3159e8';
    const mapping=Object.fromEntries(Array.from({length:240},(_,i)=>[String(i),{message:{id:String(i)}}]));
    const calls:string[]=[];
    const fetch=async (url:string) => { calls.push(url); return {ok:true,status:200,json:async()=>url==='/api/auth/session'?{accessToken:'fixture'}:{conversation_id:id,mapping}}; };
    const fn=vm.runInNewContext('('+chatgptFullConversationApiScript(id)+')',{location:{origin:'https://chatgpt.com'},fetch,JSON,encodeURIComponent});
    const result=await fn(); expect(Object.keys(result.data.mapping)).toHaveLength(240);
    expect(calls).toContain('/backend-api/conversation/'+id);
  });
  it('offers raw native data through the regular adapter export interface', async () => {
    const id='6aa7e444-0ba4-83ed-992f-d2afaa3159e8';
    const driver:any={listChats:async()=>[],sendMessage:async()=>({}),getRawConversation:async()=>({conversation_id:id,mapping:{a:{message:{content:'start'}},z:{message:{content:'end'}}}})};
    const adapter=new BrowserChatAdapter(driver,{id:'chatgpt',name:'ChatGPT',harness:'chatgpt',cwd:'/tmp/chatgpt'});
    const raw=await adapter.getRawTranscript!(id); expect(raw?.complete).toBe(true); expect(JSON.parse(Buffer.from(raw!.bytes).toString()).mapping.a.message.content).toBe('start');
  });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptArchive } from '../src/transcript-archive.js';
import { handleExportTranscript } from '../src/mcp-tools/handlers.js';

it('exports a virtual ChatGPT session through the normal transcript tool within its archive workspace', async () => {
  const root=await mkdtemp(join(tmpdir(),'herder-chat-export-'));
  try {
    const id='6aa7e444-0ba4-83ed-992f-d2afaa3159e8';
    const driver:any={listChats:async()=>[{id,title:'fixture',unread:false,working:false,updatedAt:new Date(0).toISOString()}],sendMessage:async()=>({}),getRawConversation:async()=>({conversation_id:id,mapping:{first:{message:{text:'first'}},last:{message:{text:'last'}}}})};
    const adapter=new BrowserChatAdapter(driver,{id:'chatgpt',name:'ChatGPT',harness:'chatgpt',cwd:'/home/example/.chatgpt'});
    await adapter.listSessions();
    const result=await handleExportTranscript(new Map([['chatgpt',adapter]]),{sessionId:id,harness:'chatgpt'},new TranscriptArchive({workspaceRoot:root}));
    expect(result).toContain('.json');
    const file=join(root,'.agent-herder','transcripts','chatgpt',id+'.json');
    expect(JSON.parse(await readFile(file,'utf8')).mapping.first.message.text).toBe('first');
  } finally { await rm(root,{recursive:true,force:true}); }
});

it('reads the full current conversation rather than the latest 60 turns', () => {
  const mapping=Object.fromEntries(Array.from({length:240},(_,i)=>[String(i),{message:{id:String(i),author:{role:i%2?'assistant':'user'},create_time:i+1,content:{parts:['message '+i]}}}]));
  const messages=chatgptConversationMessages({mapping});
  expect(messages).toHaveLength(240); expect(messages[0]?.text).toBe('message 0'); expect(messages[239]?.text).toBe('message 239');
});

import { ChatGptMacCdpDriver } from '../src/adapters/chatgpt-mac-cdp-driver.js';
import { BrowserChatDraftStore } from '../src/adapters/browser-chat-drafts.js';
it('reads an admitted draft through its verified native conversation', async () => {
  const root=await mkdtemp(join(tmpdir(),'herder-chat-draft-export-'));
  vi.stubEnv('AGENT_HERDER_BROWSER_DRAFT_ROOT',root);
  const scope=Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode('fixture'))).toString('hex'), id='6aa7e444-0ba4-83ed-992f-d2afaa3159e8';
  try {
    const drafts=new BrowserChatDraftStore('chatgpt',root);await drafts.useScope(scope);
    const draft=await drafts.create('fixture');await drafts.startSend(draft.id);await drafts.admit(draft.id,id);
    const mapping={first:{message:{id:'m1',author:{role:'user'},content:{parts:['question']}}},last:{message:{id:'m2',author:{role:'assistant'},content:{parts:['answer']}}}};
    const fetch=async(url:string)=>({ok:true,status:200,json:async()=>url==='/api/auth/session'?{accessToken:'fixture',account:{id:'fixture'}}:
      url.startsWith('/backend-api/conversations/')?{conversation_id:id,messages:Object.values(mapping).map(node=>node.message)}:{conversation_id:id,mapping}});
    const context=vm.createContext({location:{origin:'https://chatgpt.com'},fetch,JSON,encodeURIComponent,Date,Object,TextEncoder,crypto:webcrypto});
    const tools:any={call:async(name:string,args:any)=>{
      if(name==='list_pages')return '1: ChatGPT (https://chatgpt.com/)';
      if(args.function.includes('const digest=await crypto.subtle.digest'))return '```json\n'+JSON.stringify({scope})+'\n```';
      const result=await vm.runInContext('('+args.function+')()',context);
      return '```json\n'+JSON.stringify(result)+'\n```';
    }};
    const driver=new ChatGptMacCdpDriver(tools);
    const adapter=new BrowserChatAdapter(driver,{id:'chatgpt',name:'ChatGPT',harness:'chatgpt',cwd:'/tmp/chatgpt'});
    expect((await adapter.getSessionMessages(draft.id,200))?.map(m=>m.text)).toEqual(['question','answer']);
    const raw=await adapter.getRawTranscript(draft.id);
    expect(raw).toMatchObject({complete:true,source:{location:'https://chatgpt.com/c/'+id}});
  } finally {vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
});
it('transfers a conversation larger than the Chrome transport bound in verified chunks', async () => {
  const id='6aa7e444-0ba4-83ed-992f-d2afaa3159e8';
  const large='ф'.repeat(800_000); const mapping={first:{message:{text:large}},last:{message:{text:'end'}}};
  const fetch=async (url:string) => ({ok:true,status:200,json:async()=>url==='/api/auth/session'?{accessToken:'fixture'}:{conversation_id:id,mapping}});
  const context=vm.createContext({location:{origin:'https://chatgpt.com'},fetch,JSON,encodeURIComponent,Date,Object});
  let chunks=0;
  const tools:any={call:async(name:string,args:any)=>{
    if(name==='list_pages')return '1: ChatGPT (https://chatgpt.com/)';
    if(args.function.includes('entry.text.slice'))chunks++;
    const result=await vm.runInContext('('+args.function+')()',context);
    return '```json\n'+JSON.stringify(result)+'\n```';
  }};
  const result:any=await new ChatGptMacCdpDriver(tools).getRawConversation(id);
  expect(result.mapping.first.message.text.length).toBe(large.length); expect(result.mapping.last.message.text).toBe('end'); expect(chunks).toBeGreaterThan(1);
  expect(vm.runInContext('Object.keys(globalThis.__herderFullConversationTransfers).length',context)).toBe(0);
});
