import { parseChromeEvaluation, type ChromePageTools } from "./mac-mini-chrome-transport.js";
import { ZAI_LIST_API_SCRIPT } from "./browser-chat-api-scripts.js";
import { claimOwnedTab, isOwnedTabUrl, ownedTabUrl, resolveOwnedTab } from "./browser-owned-tab.js";

export type BrowserChatSite = "chatgpt" | "zai";
const SITE_ORIGIN = {chatgpt:"https://chatgpt.com",zai:"https://chat.z.ai"} as const;

/** An explicit create/send verifies only the logged-in account, not the whole
 * ChatGPT inventory. Background polling may remain paused independently.
 * Auth material remains in the browser and never crosses CDP. */
export const CHATGPT_CREATE_SCOPE_SCRIPT = `async () => {
  if(location.origin!=="https://chatgpt.com")return {error:"wrong_origin"};
  // The account check reads /api/auth/session, which the site answers during
  // a history cooldown. Refusing to verify the account here would fail every
  // startup of a rate-limited instance and lose the account proof that the
  // readback needs.
  const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),10000);
  try{
    const response=await fetch('/api/auth/session',{credentials:'same-origin',cache:'no-store',signal:abort.signal});
    if(!response.ok)return {error:'session_http_'+response.status};
    const session=await response.json();
    if(typeof session.account?.id!=='string'||!session.account.id)return {error:'account_unavailable'};
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(session.account.id));
    return {scope:[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')};
  }finally{clearTimeout(timer)}
}`;

export async function verifyNewChatAccountScope(
  tools:ChromePageTools,site:BrowserChatSite,pageId:number,
):Promise<string> {
  const data=parseChromeEvaluation<{scope?:string;error?:string}>(
    await tools.call('evaluate_script',{pageId,function:
      site==='chatgpt'?CHATGPT_CREATE_SCOPE_SCRIPT:ZAI_LIST_API_SCRIPT}));
  if(typeof data.scope!=='string'||!/^[a-f0-9]{64}$/.test(data.scope))
    throw new Error(site+' account verification unavailable: '+(data.error||'unverified'));
  return data.scope;
}


function pages(text:string): Array<{id:number;url:string}> {
  return text.split("\n").flatMap(line=>{
    const match=line.match(/^\s*(\d+):.*?\((https:\/\/[^)]+)\)/);
    if (!match) return [];
    try { return [{id:Number(match[1]),url:new URL(match[2]!).toString()}]; }
    catch { return []; }
  });
}

/** Return our own tab to the blank chat route of the provider. Only the tab
 * this provider owns is touched; a foreign tab is never navigated. */
async function navigateToRoot(tools:ChromePageTools,pageId:number,site:BrowserChatSite):Promise<void> {
  try {
    await tools.call("navigate_page",{pageId,type:"url",url:SITE_ORIGIN[site]+"/"});
  } catch { /* the blank state is verified by the caller */ }
}

/** One NEW background tab, identified by exact page-ID set difference.
 * new_page sometimes reports navigation timeout despite creating the tab.
 * Never reuse a random existing tab or change the human-selected chat.
 */


/** The exact text the composer currently holds. */
async function composerValue(tools:ChromePageTools,pageId:number,site:BrowserChatSite):Promise<string> {
  try {
    const value=parseChromeEvaluation<{value:string}>(
      await tools.call("evaluate_script",{pageId,function:`() => {
        const editor=document.querySelector(${JSON.stringify(site==="chatgpt"
          ?'div[contenteditable="true"][role="textbox"][data-composer-markdown]'
          :'textarea[placeholder="Send a Message"]')});
        return {value:(editor?.innerText||editor?.value||editor?.textContent||'').trim()};
      }`}));
    return typeof value?.value==="string"?value.value.trim():"";
  } catch { return ""; }
}

/** Replace the whole composer content. A fill on a rich editor appends to
 * whatever the site restored, so the previous value is selected and
 * replaced instead of merely emptied. */
async function clearComposer(tools:ChromePageTools,pageId:number,site:BrowserChatSite):Promise<void> {
  try {
    await tools.call("evaluate_script",{pageId,function:`() => {
      const editor=document.querySelector(${JSON.stringify(site==="chatgpt"
        ?'div[contenteditable="true"][role="textbox"][data-composer-markdown]'
        :'textarea[placeholder="Send a Message"]')});
      if(!editor)return {cleared:false};
      editor.focus();
      if(editor.tagName==='TEXTAREA')editor.select();
      else {
        const range=document.createRange();
        range.selectNodeContents(editor);
        const selection=window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      document.execCommand('delete');
      return {cleared:!(editor.innerText||editor.value||editor.textContent||'').trim()};
    }`});
  } catch { /* the fill below still writes the user's own text */ }
}

export async function openOwnedBlankChatPage(
  tools:ChromePageTools,site:BrowserChatSite,scope?:string,onCreated?:(pageId:number)=>void,
):Promise<number> {
  const origin=SITE_ORIGIN[site];
  const before=new Set(pages(await tools.call("list_pages")).map(p=>p.id));
  // One tab per provider: the marked tab that the driver already owns is
  // reused, so a first message never opens a second tab.
  const listing=pages(await tools.call("list_pages"));
  let owned=listing.find(p=>isOwnedTabUrl(p.url,site,scope));
  if (!owned && scope) {
    for (const page of listing.filter(p=>isOwnedTabUrl(p.url,site))) {
      if (await verifyNewChatAccountScope(tools,site,page.id).catch(()=>undefined) !== scope) continue;
      await claimOwnedTab(tools,site,page.id,scope);
      owned=page;break;
    }
  }
  if (owned) {
    if (scope && await verifyNewChatAccountScope(tools,site,owned.id) !== scope)
      throw new Error("New-chat account identity could not be verified");
    // Our own tab may still hold a composer value from an earlier run. Clear
    // it here so the first message starts from a clean composer; a draft the
    // human wrote in a foreign tab is never touched.
    await clearComposer(tools,owned.id,site);
    for(let attempt=0;attempt<7;attempt++){
      try{
        const state=parseChromeEvaluation<{origin:string;path:string;ready:boolean;empty:boolean}>(
          await tools.call("evaluate_script",{pageId:owned.id,function:`() => {
            const editor=document.querySelector(${JSON.stringify(site==="chatgpt"
              ?'div[contenteditable="true"][role="textbox"][data-composer-markdown]'
              :'textarea[placeholder="Send a Message"]')});
            return {origin:location.origin,path:location.pathname,
              ready:!!editor&&editor.getClientRects().length>0,
              empty:!(editor?.innerText||editor?.value||editor?.textContent||'').trim()};
          }`}));
        if(state.origin===origin&&state.path==="/"&&state.ready){
          if(state.empty)return owned.id;
          await clearComposer(tools,owned.id,site);
        }
      }catch{ /* retried below */ }
      await new Promise(resolve=>setTimeout(resolve,300));
    }
    throw new Error(site+" owned tab composer could not be cleared; no message submitted");
  }
  // Our own tab may have navigated into a conversation and lost its URL
  // marker. It is still ours: the page keeps the ownership marker, and such
  // a tab is reused instead of opening another one.
  const claimed=await resolveOwnedTab(tools,site,listing,scope);
  if (claimed) {
    if (scope && await verifyNewChatAccountScope(tools,site,claimed.id) !== scope)
      throw new Error("New-chat account identity could not be verified");
    if(new URL(claimed.url).pathname!=="/")await navigateToRoot(tools,claimed.id,site);
    await clearComposer(tools,claimed.id,site);
    for(let attempt=0;attempt<7;attempt++){
      try{
        const state=parseChromeEvaluation<{origin:string;path:string;ready:boolean;empty:boolean}>(
          await tools.call("evaluate_script",{pageId:claimed.id,function:`() => {
            const editor=document.querySelector(${JSON.stringify(site==="chatgpt"
              ?'div[contenteditable="true"][role="textbox"][data-composer-markdown]'
              :'textarea[placeholder="Send a Message"]')});
            return {origin:location.origin,path:location.pathname,
              ready:!!editor&&editor.getClientRects().length>0,
              empty:!(editor?.innerText||editor?.value||editor?.textContent||'').trim()};
          }`}));
        if(state.origin===origin&&state.path==="/"&&state.ready){
          if(state.empty)return claimed.id;
          // The SPA may mount the editor and restore its draft after navigation.
          await clearComposer(tools,claimed.id,site);
        }
      }catch{ /* retried below */ }
      await new Promise(resolve=>setTimeout(resolve,300));
    }
    throw new Error(site+" owned tab could not be returned to a blank chat; no message submitted");
  }
  void before;
  try { await tools.call("new_page",{url:ownedTabUrl(origin,site,scope),background:true,timeout:12_000}); }
  catch { /* require new unique page in authoritative list instead */ }
  const now=pages(await tools.call("list_pages"));
  const created=now.filter(p=>!before.has(p.id)&&new URL(p.url).origin===origin);
  if (created.length!==1) throw new Error(site+" new-chat tab not uniquely identified; no message submitted");
  const pageId=created[0]!.id;
  onCreated?.(pageId);
  for(let attempt=0;attempt<7;attempt++){
    try {
      const state=parseChromeEvaluation<{origin:string;path:string;ready:boolean;empty:boolean}>(
        await tools.call("evaluate_script",{pageId,function:`() => {
          const editor=document.querySelector(${JSON.stringify(site==="chatgpt"
            ?'div[contenteditable="true"][role="textbox"][data-composer-markdown]'
            :'textarea[placeholder="Send a Message"]')});
          return {origin:location.origin,path:location.pathname,
            ready:!!editor&&editor.getClientRects().length>0,
            empty:!(editor?.innerText||editor?.value||editor?.textContent||'').trim()};
        }`}));
      if(state.origin!==origin||state.path!=="/"||!state.empty)
        throw new Error("New chat page changed or contains a draft");
      if(state.ready) {
        if (!await claimOwnedTab(tools,site,pageId,scope)) {
          throw new Error(site+" new chat ownership could not be retained; no message submitted");
        }
        return pageId;
      }
    }catch(error){
      if(error instanceof Error&&error.message.includes("changed or contains")) throw error;
    }
    await new Promise(resolve=>setTimeout(resolve,300));
  }
  throw new Error(site+" new-chat composer unavailable; no message submitted");
}

function firstMessageClickScript(site:BrowserChatSite,text:string):string {
  if(site==="chatgpt")return `() => {
    if(location.origin!=="https://chatgpt.com"||location.pathname!=="/")
      return {submitted:false,reason:"new_chat_target_changed"};
    const editor=document.querySelector('div[contenteditable="true"][role="textbox"][data-composer-markdown]');
    const value=(editor?.innerText||editor?.textContent||"").trim();
    if(!editor||value!==${JSON.stringify(text.trim())})return {submitted:false,reason:"draft_changed"};
    const visible=b=>!!b&&b.getClientRects().length>0;
    const controls=[...document.querySelectorAll("button")].filter(visible);
    if(controls.some(b=>b.getAttribute("data-testid")==="stop-button"||
      /^(Stop generating|Stop response|Остановить генерацию|Остановить ответ|Остановить)$/i.test(b.getAttribute("aria-label")||"")))
      return {submitted:false,reason:"busy"};
    const form=editor.closest("form");
    const send=controls.filter(b=>form?.contains(b)&&(b.type==="submit"||
      b.getAttribute("data-testid")==="send-button"||
      /^(Send message|Send prompt|Отправить сообщение)$/i.test(b.getAttribute("aria-label")||"")));
    if(send.length!==1||send[0].disabled)return {submitted:false,reason:"send_not_ready"};
    send[0].click();return {submitted:true};
  }`;
  return `() => {
    if(location.origin!=="https://chat.z.ai"||location.pathname!=="/")
      return {submitted:false,reason:"new_chat_target_changed"};
    const editor=document.querySelector('textarea[placeholder="Send a Message"]');
    if(!editor||editor.value.trim()!==${JSON.stringify(text.trim())})
      return {submitted:false,reason:"draft_changed"};
    const visible=b=>!!b&&b.getClientRects().length>0;
    if([...document.querySelectorAll("button")].some(b=>visible(b)&&
      !!b.querySelector(':scope > span.block.size-3.rounded-xs.bg-text-inverted')))
      return {submitted:false,reason:"busy"};
    const send=[...document.querySelectorAll("#send-message-button")].filter(visible);
    if(send.length!==1||send[0].disabled)
      return {submitted:false,reason:"send_not_ready"};
    send[0].click();return {submitted:true};
  }`;
}

/** Read only the new tab's native error surface; never inspect other chats. */
export function newChatPostClickProbe(site:BrowserChatSite):string {
  const selectors=site==='zai'
    ? '[role="alert"],[class*="border-red-600"],[class*="bg-red-600"]'
    : '[role="alert"],[data-testid="conversation-error"],[data-testid="conversation-turn-error"]';
  return `() => {
    const errors=[...document.querySelectorAll(${JSON.stringify(selectors)})]
      .filter(e=>e.getClientRects().length>0).map(e=>(e.innerText||e.textContent||'').trim()).join(String.fromCharCode(10));
    const rejection=/current concurrent conversation limit has been reached/i.test(errors)
      ? 'concurrent_conversation_limit'
      : /too many requests|rate limit|слишком много запросов/i.test(errors)
        ? 'rate_limit'
        : /usage (?:cap|limit)|quota (?:exceeded|exhausted)|лимит.{0,25}исчерпан/i.test(errors)
          ? 'usage_limit' : undefined;
    return {origin:location.origin,path:location.pathname,rejection};
  }`;
}

/** Verify the native route of a ChatGPT first message from the account's own
 * conversation list. The site does not always navigate the tab to /c/<id>
 * after the first message, so the route is proven by the stored message. */
export function chatGptNewChatMessageProbe(text:string,scope?:string):string {
  return `async () => {
    const herderChatGptNewChatVerify=true, text=${JSON.stringify(text.trim())}, scope=${JSON.stringify(scope||"")};
    if(location.origin!=='https://chatgpt.com')return {verified:false,reason:'route_changed'};
    const session=await(await fetch('/api/auth/session',{credentials:'same-origin',cache:'no-store'})).json();
    if(!session.accessToken||!session.account?.id)return {verified:false,reason:'history_unavailable'};
    if(scope){
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(session.account.id)));
      const actual=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
      if(actual!==scope)return {verified:false,reason:'native_history_mismatch'};
    }
    const list=await fetch('/backend-api/conversations?offset=0&limit=20&order=updated',{
      headers:{authorization:'Bearer '+session.accessToken,'chatgpt-account-id':session.account.id},credentials:'same-origin'});
    if(!list.ok)return {verified:false,reason:'history_unavailable'};
    const data=await list.json();
    const items=(data.items||[]).filter(x=>x&&x.id&&!x.is_archived&&!x.is_temporary_chat);
    for(const item of items.slice(0,10)){
      const read=await fetch('/backend-api/conversations/'+encodeURIComponent(item.id)+'?num_turns=20&include_has_versions=true',{
        headers:{authorization:'Bearer '+session.accessToken,'chatgpt-account-id':session.account.id},credentials:'same-origin'});
      if(!read.ok)continue;
      const conversation=await read.json();
      if(conversation.conversation_id!==item.id)continue;
      // The conversation list endpoint answers with a messages array; the
      // mapping tree belongs to the single-conversation endpoint. Reading
      // the wrong field here hides the submitted message forever.
      const rows=Array.isArray(conversation.messages)?conversation.messages:[];
      const users=rows.filter(message=>message&&message.author&&message.author.role==='user')
        .map(message=>((message.content&&message.content.parts)||[])
          .map(part=>typeof part==='string'?part:'').join('').trim())
        .filter(value=>value.length>0);
      if(users.length===1&&users[0]===text)return {verified:true,id:item.id};
    }
    return {verified:false,reason:'history_unavailable'};
  }`;
}

export interface NewChatSubmitReceipt {
  /** True means the site's own Send button was clicked exactly once. */
  clicked:boolean;
  /** Assigned by the site, never chosen by Agent Herder. */
  remoteId?:string;
  /** True if a click may have happened; never retry blindly. */
  uncertain:boolean;
  reason?:string;
}

/** Verify the site's stored first user message before adopting a Z.ai route. */
export function zaiNewChatMessageProbe(id:string,text:string,scope?:string):string {
  return `async () => {
    const herderZaiNewChatVerify=true, id=${JSON.stringify(id)}, text=${JSON.stringify(text.trim())}, scope=${JSON.stringify(scope||"")};
    if(location.origin!=='https://chat.z.ai'||location.pathname!=='/c/'+id)return {verified:false,reason:'route_changed'};
    const r=await fetch('/api/v1/chats/'+encodeURIComponent(id),{credentials:'same-origin'});
    if(!r.ok)return {verified:false,reason:'history_unavailable'};
    const chat=await r.json();
    if(chat.id!==id)return {verified:false,reason:'native_history_mismatch'};
    if(scope){
      if(!chat.user_id)return {verified:false,reason:'history_unavailable'};
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(chat.user_id)));
      const actual=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
      if(actual!==scope)return {verified:false,reason:'native_history_mismatch'};
    }
    const history=chat.chat?.history?.messages;
    if(!history||typeof history!=='object'||Array.isArray(history))return {verified:false,reason:'history_unavailable'};
    const ids=Object.keys(history);if(!ids.length||ids.length>200)return {verified:false,reason:'history_unavailable'};
    const batch=await fetch('/api/v1/chats/'+encodeURIComponent(id)+'/messages/batch',{
      method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({ids})});
    if(!batch.ok)return {verified:false,reason:'history_unavailable'};
    const result=await batch.json();
    if(result.chat_id!==id||!result.data||ids.some(key=>!result.data[key]))return {verified:false,reason:'history_unavailable'};
    const users=ids.map(key=>result.data[key]).filter(message=>message?.role==='user');
    if(!users.length)return {verified:false,reason:'history_unavailable'};
    const value=message=>typeof message.content==='string'?message.content:
      (Array.isArray(message.content_blocks)?message.content_blocks:[]).filter(block=>block.type==='text'||block.type==='markdown').map(block=>typeof block.content==='string'?block.content:'').join('\\n');
    if(users.length!==1||value(users[0]).trim()!==text)return {verified:false,reason:'native_history_mismatch'};
    return {verified:true};
  }`;
}

/** Submit the USER'S first message. This is deliberately separate from
 * createChat: creation itself must never send a synthetic prompt or use quota.
 */
export async function submitFirstChatMessage(
  tools:ChromePageTools,site:BrowserChatSite,text:string,expectedScope?:string,pinnedPageId?:number,
):Promise<NewChatSubmitReceipt> {
  let pageId:number;
  let createdPageId:number|undefined;
  try {
    if (pinnedPageId === undefined) pageId=await openOwnedBlankChatPage(tools,site,site === "chatgpt" ? expectedScope : undefined,id=>{createdPageId=id;});
    else {
      if (!Number.isSafeInteger(pinnedPageId) || pinnedPageId < 1
        || !expectedScope || !/^[a-f0-9]{64}$/.test(expectedScope))
        throw new Error("Pinned first message requires an exact page and verified account scope");
      pageId=pinnedPageId;
      const state=parseChromeEvaluation<{origin:string;path:string;ready:boolean;empty:boolean}>(
        await tools.call("evaluate_script",{pageId,function:`() => {
          const editor=document.querySelector(${JSON.stringify(site==="chatgpt"
            ?'div[contenteditable="true"][role="textbox"][data-composer-markdown]'
            :'textarea[placeholder="Send a Message"]')});
          return {origin:location.origin,path:location.pathname,
            ready:!!editor&&editor.getClientRects().length>0,
            empty:!(editor?.innerText||editor?.value||editor?.textContent||'').trim()};
        }`}));
      if(state.origin!==SITE_ORIGIN[site] || state.path!=="/" || !state.ready || !state.empty)
        throw new Error("Pinned first-message page must be a ready blank chat without a draft; existing chat preserved");
    }
  } catch(error) { return {clicked:false,uncertain:false,reason:String(error)}; }
  // Only dispose a tab allocated by this call. A supplied pin belongs to the caller.
  const closeOwnedPage=async()=>{
    if(createdPageId===pageId)await tools.call("close_page",{pageId}).catch(()=>undefined);
  };
  const existingZaiIds = new Set<string>();
  if (site === "zai") {
    try {
      const before=parseChromeEvaluation<{scope?:string;chats?:Array<{id?:unknown}>}>(
        await tools.call("evaluate_script",{pageId,function:ZAI_LIST_API_SCRIPT}));
      if (expectedScope !== undefined && before.scope !== expectedScope) {
        await closeOwnedPage();
        return {clicked:false,uncertain:false,reason:"New-chat account identity could not be verified"};
      }
      if (!Array.isArray(before.chats)) throw new Error("Z.ai account inventory is unavailable");
      for (const chat of before.chats) if (typeof chat.id === "string") existingZaiIds.add(chat.id);
    } catch {
      await closeOwnedPage();
      return {clicked:false,uncertain:false,reason:"Z.ai account inventory unavailable; no message submitted"};
    }
  }
  // A new tab must belong to the *same* browser account that owns the
  // local draft. Browser profiles can coexist and account changes must not
  // silently redirect the first user message to someone else's account.
  if (expectedScope !== undefined) {
    let verified=false;
    try {
      const actual=await verifyNewChatAccountScope(tools,site,pageId);
      verified=/^[a-f0-9]{64}$/.test(expectedScope) && actual===expectedScope;
    }catch { /* no auth proof means do not send */ }
    if (!verified) {
      await closeOwnedPage();
      return {clicked:false,uncertain:false,reason:"New-chat account identity could not be verified"};
    }
  }
  const editorLabel=site==="chatgpt"
    ? /uid=([\w-]+) textbox "(?:Спросить ChatGPT|Работайте с ChatGPT|Ask ChatGPT|Ask anything|Message ChatGPT)"/i
    : /uid=([\w-]+) textbox "Send a Message"/i;
  try {
    const a11y=await tools.call("take_snapshot",{pageId});
    const uid=a11y.match(editorLabel)?.[1];
    if(!uid) {
      await closeOwnedPage();
      return {clicked:false,uncertain:false,reason:"New-chat textbox not found"};
    }
    // The site may restore its own composer draft over our text. Write the
    // message and verify what the composer actually holds; a restored draft
    // is cleared and the write is repeated.
    for (let attempt = 0; attempt < 5; attempt++) {
      await clearComposer(tools, pageId, site);
      await tools.call("fill", { pageId, uid, value: text });
      const written = await composerValue(tools, pageId, site);
      if (written === text.trim()) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }catch(error){
    await closeOwnedPage();
    return {clicked:false,uncertain:false,reason:"Cannot fill new-chat composer; no click attempted"};
  }

  let click:{submitted:boolean;reason?:string};
  try {
    click=parseChromeEvaluation<{submitted:boolean;reason?:string}>(
      await tools.call("evaluate_script",{pageId,function:firstMessageClickScript(site,text)}));
  }catch {
    // The transport may fail AFTER the site accepted the click.
    return {clicked:true,uncertain:true,reason:"First-message click outcome unknown; do not retry"};
  }
  if(!click.submitted){
    await closeOwnedPage();
    return {clicked:false,uncertain:false,reason:click.reason||"New-chat Send not accepted"};
  }
  const origin=SITE_ORIGIN[site];
  for(let i=0;i<18;i++){
    try{
      const observed=parseChromeEvaluation<{origin:string;path:string;rejection?:string}>(
        await tools.call("evaluate_script",{pageId,function:newChatPostClickProbe(site)}));
      if(observed.rejection)return {clicked:true,uncertain:true,reason:
        site+" rejected the first message: "+observed.rejection+"; no automatic retry"};
      const id=observed.path.match(/^\/c\/([a-f0-9-]{12,80})$/i)?.[1];
      if(!id&&site==="chatgpt"&&observed.origin===origin){
        // The site keeps the tab on the root after the first message, so the
        // native route is proven by the stored message itself.
        const proof=parseChromeEvaluation<{verified?:boolean;id?:string;reason?:string}>(
          await tools.call("evaluate_script",{pageId,function:chatGptNewChatMessageProbe(text,expectedScope)}));
        if(proof.verified&&typeof proof.id==="string")
          return {clicked:true,uncertain:false,remoteId:proof.id};
        if(proof.reason==="native_history_mismatch")
          return {clicked:true,uncertain:true,reason:"New-chat native history did not match the submitted message; do not retry"};
        await new Promise(resolve=>setTimeout(resolve,350));
        continue;
      }
      if(observed.origin===origin&&id){
        if(site==="zai" && existingZaiIds.has(id))
          return {clicked:true,uncertain:true,reason:"New-chat route was already in the account inventory; do not retry"};
        if(site==="zai"){
          const proof=parseChromeEvaluation<{verified?:boolean;reason?:string}>(
            await tools.call("evaluate_script",{pageId,function:zaiNewChatMessageProbe(id,text,expectedScope)}));
          if(!proof.verified){
            if(proof.reason==="native_history_mismatch"||proof.reason==="route_changed")
              return {clicked:true,uncertain:true,reason:"New-chat native history did not match the submitted message; do not retry"};
            await new Promise(resolve=>setTimeout(resolve,350));
            continue;
          }
        }
        return {clicked:true,uncertain:false,remoteId:site==="zai"?"route:"+id:id};
      }
    }catch { /* route navigation is transient after first message */ }
    await new Promise(resolve=>setTimeout(resolve,350));
  }
  return {clicked:true,uncertain:true,reason:"First message sent but native chat ID not yet verified; do not retry"};
}
