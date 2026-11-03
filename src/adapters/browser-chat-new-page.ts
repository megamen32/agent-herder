import { parseChromeEvaluation, type ChromePageTools } from "./mac-mini-chrome-transport.js";
import { CHATGPT_LIST_API_SCRIPT, ZAI_LIST_API_SCRIPT } from "./browser-chat-api-scripts.js";

export type BrowserChatSite = "chatgpt" | "zai";
const SITE_ORIGIN = {chatgpt:"https://chatgpt.com",zai:"https://chat.z.ai"} as const;

function pages(text:string): Array<{id:number;url:string}> {
  return text.split("\n").flatMap(line=>{
    const match=line.match(/^\s*(\d+):.*?\((https:\/\/[^)]+)\)/);
    if (!match) return [];
    try { return [{id:Number(match[1]),url:new URL(match[2]!).toString()}]; }
    catch { return []; }
  });
}

/** One NEW background tab, identified by exact page-ID set difference.
 * new_page sometimes reports navigation timeout despite creating the tab.
 * Never reuse a random existing tab or change the human-selected chat.
 */
export async function openOwnedBlankChatPage(
  tools:ChromePageTools,site:BrowserChatSite,
):Promise<number> {
  const origin=SITE_ORIGIN[site];
  const before=new Set(pages(await tools.call("list_pages")).map(p=>p.id));
  try { await tools.call("new_page",{url:origin+"/",background:true,timeout:12_000}); }
  catch { /* require new unique page in authoritative list instead */ }
  const now=pages(await tools.call("list_pages"));
  const created=now.filter(p=>!before.has(p.id)&&new URL(p.url).origin===origin);
  if (created.length!==1) throw new Error(site+" new-chat tab not uniquely identified; no message submitted");
  const pageId=created[0]!.id;
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
      if(state.ready)return pageId;
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

export interface NewChatSubmitReceipt {
  /** True means the site's own Send button was clicked exactly once. */
  clicked:boolean;
  /** Assigned by the site, never chosen by Agent Herder. */
  remoteId?:string;
  /** True if a click may have happened; never retry blindly. */
  uncertain:boolean;
  reason?:string;
}

/** Submit the USER'S first message. This is deliberately separate from
 * createChat: creation itself must never send a synthetic prompt or use quota.
 */
export async function submitFirstChatMessage(
  tools:ChromePageTools,site:BrowserChatSite,text:string,expectedScope?:string,
):Promise<NewChatSubmitReceipt> {
  let pageId:number;
  try { pageId=await openOwnedBlankChatPage(tools,site); }
  catch(error) { return {clicked:false,uncertain:false,reason:String(error)}; }
  // A new tab must belong to the *same* browser account that owns the
  // local draft. Browser profiles can coexist and account changes must not
  // silently redirect the first user message to someone else's account.
  if (expectedScope !== undefined) {
    let verified=false;
    try {
      const result=parseChromeEvaluation<{scope?:string;error?:string}>(
        await tools.call("evaluate_script", {
          pageId,
          function:site==="chatgpt"?CHATGPT_LIST_API_SCRIPT:ZAI_LIST_API_SCRIPT,
        }));
      verified=/^[a-f0-9]{64}$/.test(expectedScope) && result.scope===expectedScope;
    }catch { /* no auth proof means do not send */ }
    if (!verified) {
      await tools.call("close_page",{pageId}).catch(()=>undefined);
      return {clicked:false,uncertain:false,reason:"New-chat account identity could not be verified"};
    }
  }
  const editorLabel=site==="chatgpt"
    ? /uid=([\w-]+) textbox "(?:Спросить ChatGPT|Ask ChatGPT|Ask anything|Message ChatGPT)"/i
    : /uid=([\w-]+) textbox "Send a Message"/i;
  try {
    const a11y=await tools.call("take_snapshot",{pageId});
    const uid=a11y.match(editorLabel)?.[1];
    if(!uid) {
      await tools.call("close_page",{pageId}).catch(()=>undefined);
      return {clicked:false,uncertain:false,reason:"New-chat textbox not found"};
    }
    await tools.call("fill",{pageId,uid,value:text});
  }catch(error){
    await tools.call("close_page",{pageId}).catch(()=>undefined);
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
    await tools.call("close_page",{pageId}).catch(()=>undefined);
    return {clicked:false,uncertain:false,reason:click.reason||"New-chat Send not accepted"};
  }
  const origin=SITE_ORIGIN[site];
  for(let i=0;i<18;i++){
    try{
      const observed=parseChromeEvaluation<{origin:string;path:string}>(
        await tools.call("evaluate_script",{pageId,function:
          "() => ({origin:location.origin,path:location.pathname})"}));
      const id=observed.path.match(/^\/c\/([a-f0-9-]{12,80})$/i)?.[1];
      if(observed.origin===origin&&id)return {clicked:true,uncertain:false,
        remoteId:site==="zai"?"route:"+id:id};
    }catch { /* route navigation is transient after first message */ }
    await new Promise(resolve=>setTimeout(resolve,350));
  }
  return {clicked:true,uncertain:true,reason:"First message sent but native chat ID not yet verified; do not retry"};
}
