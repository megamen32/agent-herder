/** Install a passive observer of requests the ChatGPT page itself makes.
 * This script never initiates a network request or navigates the page. */
export function chatgptPassiveHistoryScript(): string {
  return `() => {
    if(location.origin!=='https://chatgpt.com')return {error:'wrong_origin',messages:[]};
    if(!globalThis.__herderPassiveHistoryHook && typeof window.fetch==='function'){
      globalThis.__herderPassiveHistoryHook=true;
      const original=window.fetch;
      window.fetch=async function(input,init){
        const requestStartedAt=Date.now();
        const requestVisit=globalThis.__herderBackgroundVisit;
        try {
          const address=typeof input==='string'?input:(input?.url??input?.href);
          const url=new URL(address,location.origin);
          const method=String(init?.method??input?.method??'GET').toUpperCase();
          if(url.origin===location.origin && /^\\/backend-api\\/(?:f\\/)?conversation(?:\\/|$)/.test(url.pathname) && method!=='GET' && method!=='HEAD') {
            let preparation=false;
            try {
              const body=typeof init?.body==='string'?JSON.parse(init.body):null;
              preparation=!!body && typeof body==='object' && !Array.isArray(body) && !('messages' in body)
                && (body.action==='prepare' || (url.pathname==='/backend-api/conversation/init' && method==='POST' && body.action==null));
            } catch {}
            // Unknown writes fail closed; the explicitly identified prepare
            // operation is navigation setup and does not submit a turn.
            if(!preparation)globalThis.__herderBackgroundVisit=null;
          }
        } catch {}
        const response=await original.apply(this,arguments);
        try{
          const address=typeof input==='string'?input:(input?.url??input?.href);
          const url=new URL(address,location.origin);
          if(url.origin===location.origin && (url.pathname.startsWith('/backend-api/') || url.pathname==='/api/auth/session')){
            if(response.status===429){
              const raw=response.headers?.get?.('retry-after');
              const seconds=typeof raw==='string'&&/^\\d+$/.test(raw.trim())?Number(raw):0;
              const untilDate=typeof raw==='string'&&!seconds?Date.parse(raw):0;
              const serverWait=seconds>0?seconds*1000:Number.isFinite(untilDate)?Math.max(0,untilDate-Date.now()):0;
              const strikes=Math.min(10,(globalThis.__herderPassive429Strikes||0)+1);
              globalThis.__herderPassive429Strikes=strikes;
              globalThis.__herderPassiveLast429=String(Date.now())+':'+String(strikes);
              const delay=Math.max(300000*Math.pow(2,strikes-1),serverWait);
              globalThis.__herderPassiveCooldownUntil=Math.max(globalThis.__herderPassiveCooldownUntil||0,Date.now()+delay);
            }
            const match=url.pathname.match(/^\\/backend-api\\/conversations?\\/([a-f0-9-]{28,80})$/i);
            if(match&&response.ok){
              void response.clone().json().then(data=>{
                if(data?.conversation_id!==match[1]||!data.mapping||typeof data.mapping!=='object')return;
                let nodes=[];
                if(data.current_node&&data.mapping[data.current_node]){
                  const seen=new Set();let node=data.current_node;
                  while(node&&data.mapping[node]&&!seen.has(node)&&seen.size<10000){seen.add(node);nodes.push(data.mapping[node]);node=data.mapping[node].parent;}
                  nodes.reverse();
                }else nodes=Object.values(data.mapping).sort((a,b)=>(a.message?.create_time||0)-(b.message?.create_time||0));
                const messages=nodes.flatMap(node=>{
                  const m=node?.message,role=m?.author?.role;
                  if(!m?.id||(role!=='user'&&role!=='assistant'))return [];
                  const text=(Array.isArray(m.content?.parts)?m.content.parts.map(p=>typeof p==='string'?p:(typeof p?.text==='string'?p.text:'')).join('\\n'):(m.content?.text||'')).trim().slice(-12000);
                  return text?[{id:String(m.id),role,text}]:[];
                }).slice(-20);
                globalThis.__herderPassiveHistories ||= {};
                globalThis.__herderPassiveHistories[match[1]]={at:Date.now(),requestStartedAt,visitId:requestVisit?.id,visitAt:requestVisit?.at,messages};
              }).catch(()=>{});
            }
          }
        }catch{}
        return response;
      };
    }
    const route=location.pathname.match(/^\\/(?:c|g\\/g-p-[a-f0-9-]+\\/c)\\/([a-f0-9-]{28,80})$/i);
    if(!route)return {messages:[],cooldownUntil:globalThis.__herderPassiveCooldownUntil||0,last429:globalThis.__herderPassiveLast429||''};
    const domRows=[...document.querySelectorAll('[data-message-author-role]')].slice(-20).map(node=>({
      id:node.getAttribute('data-message-id')||node.closest('[data-message-id]')?.getAttribute('data-message-id')||'',
      role:node.getAttribute('data-message-author-role'),text:(node.innerText||'').trim().slice(-12000)})).filter(m=>m.role==='user'||m.role==='assistant');
    const invalidDom=domRows.some(m=>!m.id||!m.text);
    const dom=invalidDom?[]:domRows;
    // Only a response initiated after this exact owned navigation is eligible.
    // A cached response from an earlier visit must never judge a later turn.
    const visit=globalThis.__herderBackgroundVisit;
    const captured=globalThis.__herderPassiveHistories?.[route[1]];
    const freshVisit=visit?.id===route[1] && Number.isFinite(visit.at)
      && Date.now()>=visit.at && Date.now()-visit.at<300000;
    const fresh=visit?.id===route[1] && captured?.visitId===route[1]
      && captured.visitAt===visit.at && captured.requestStartedAt>=visit.at && Date.now()-captured.at<300000;
    // Current ChatGPT renders messages without data-message-author-role.
    // Use only native message IDs exposed on the exact visited conversation.
    let currentDom=[];
    if(!invalidDom && !dom.length){
      let invalid=false;
      const candidates=[...document.querySelectorAll('[data-user-message-bubble],[data-chatgpt-selection-conversation-id][data-chatgpt-selection-message-id]')];
      for(const node of candidates.slice(-20)){
        const user=node.matches('[data-user-message-bubble]');
        let id='';
        if(user){
          const raw=node.closest('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids')||'';
          const ids=raw.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/ig)||[];
          if(ids.length===1)id=ids[0];
        }else{
          if(node.getAttribute('data-chatgpt-selection-conversation-id')!==route[1]){invalid=true;break;}
          id=node.getAttribute('data-chatgpt-selection-message-id')||'';
        }
        const text=(node.innerText||'').trim().slice(-12000);
        if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)||!text){invalid=true;break;}
        currentDom.push({id,role:user?'user':'assistant',text});
      }
      if(invalid || currentDom.at(-1)?.role!=='assistant')currentDom=[];
    }
    const visible=node=>!!node&&node.getClientRects().length>0;
    const buttons=[...document.querySelectorAll('button')].filter(visible);
    const stop=buttons.some(button=>button.getAttribute('data-testid')==='stop-button'||/^(Stop generating|Stop response|Остановить генерацию|Остановить ответ|Остановить)$/i.test(button.getAttribute('aria-label')||''));
    const voice=buttons.some(button=>/^(Начать голосовой разговор|Start voice conversation|Start voice chat)$/i.test(button.getAttribute('aria-label')||''));
    const editor=[...document.querySelectorAll('div[contenteditable="true"][role="textbox"][data-composer-markdown]')].some(visible);
    const phase=stop?'generating':editor&&voice?'idle':'unknown';
    return {sessionId:route[1],phase,freshVisit,messages:invalidDom?[]:(dom.length?dom:(currentDom.length?currentDom:(fresh?captured.messages:[]))),cooldownUntil:globalThis.__herderPassiveCooldownUntil||0,last429:globalThis.__herderPassiveLast429||''};
  }`;
}
