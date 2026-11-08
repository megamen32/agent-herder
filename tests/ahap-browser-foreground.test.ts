import {it,expect,vi,afterEach} from 'vitest';
import {BrowserChatAdapter} from '../src/adapters/browser-chat.js';
import {BrowserChatHistoryCache} from '../src/adapters/browser-chat-history-cache.js';
import {makeConfiguredAdapter} from '../src/ahap-browser-runner.js';
afterEach(()=>vi.restoreAllMocks());
it('AHAP init and explicit reads never prewarm unrelated history or return stale cache',async()=>{
 const prewarm=vi.spyOn(BrowserChatHistoryCache.prototype,'prewarm').mockImplementation(()=>{});
 const scope='a'.repeat(64);
 const json=(v:unknown)=>'```json\n'+JSON.stringify(v)+'\n```';
 const tools={call:async(name:string,args:Record<string,unknown>={})=>{
  if(name==='list_pages')return '5: Z.ai (https://chat.z.ai/?herder_owned=zai)';
  if(name==='evaluate_script')return json({owned:true,scope,chats:[],origin:'https://chat.z.ai',path:'/',loggedIn:true,composer:true,phase:'idle',titles:[]});
  throw Error('unexpected '+name);
 }};
 const adapter=makeConfiguredAdapter({AHAP_HARNESS:'zai',AHAP_BROWSER_TRANSPORT:'mac-mini',AHAP_BROWSER_ACCOUNT_SCOPE:scope},{macMini:()=>tools,directCdp:()=>{throw Error('wrong')}});
 await adapter.verifyPinnedAccountScope();await adapter.init();
 expect(prewarm).not.toHaveBeenCalled();
 adapter.close?.();
});
it('foreground consumer reads the current answer instead of a stale dashboard cache',async()=>{
 const cached=vi.spyOn(BrowserChatHistoryCache.prototype,'messages').mockResolvedValue([{id:'old',role:'assistant',text:'old',parts:[]}]);
 vi.spyOn(BrowserChatHistoryCache.prototype,'prewarm').mockImplementation(()=>{});
 let answer='first';
 const driver={listChats:async()=>[],sendMessage:async()=>({}),getAccountScope:()=> 'a'.repeat(64),getMessages:async()=>[{id:'current',role:'assistant' as const,text:answer,parts:[]}]};
 const adapter=new BrowserChatAdapter(driver,{id:'zai',name:'Z.ai',harness:'zai',cwd:'/test'},'/test',true,true);
 await adapter.init();
 expect((await adapter.getSessionMessages('zai::route%3Atest'))?.[0]?.text).toBe('first');
 answer='second';
 expect((await adapter.getSessionMessages('zai::route%3Atest'))?.[0]?.text).toBe('second');
 expect(cached).not.toHaveBeenCalled();
});
