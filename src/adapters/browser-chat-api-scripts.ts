/** Read-only browser-side same-origin API projections.
 * Access tokens are obtained and used only inside the authenticated
 * ChatGPT tab; they are never returned, logged or persisted by Herder.
 * Only normalized user/assistant text crosses the Mac mini CDP gateway.
 */
export const CHATGPT_LIST_API_SCRIPT = `async () => {
  const trace = [];
  const tracedFetch = async (operation,endpoint,path,options) => {
    const started=Date.now();
    const r=await fetch(path,options);
    const value=r?.headers && typeof r.headers.get==='function'
      ? r.headers.get('retry-after'):null;
    const raInt=typeof value==='string' && /^[0-9]{1,8}$/.test(value.trim())
      ? parseInt(value,10):0;
    const asDate=typeof value==='string' && !raInt ? Date.parse(value):NaN;
    const raSec=raInt>0?Math.min(86400,raInt)
      :(Number.isFinite(asDate)?Math.max(0,Math.min(86400,Math.ceil((asDate-Date.now())/1000))):null);
    trace.push({operation,endpoint,http_status:r?.status,
      latency_ms:Math.max(0,Date.now()-started),retry_after_s:raSec,
      backoff_ms:0});
    return r;
  };
  if (location.origin !== 'https://chatgpt.com') return {error:'wrong_origin'};
    if (!globalThis.__herderChatGptHook && typeof window !== 'undefined' && typeof window.fetch === 'function') {
    globalThis.__herderChatGptHook = true; globalThis.__herderChatGptInventory = null;
    const origFetch = window.fetch;
    window.fetch = async function(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const resp = await origFetch.apply(this, arguments);
      try {
        if (url.indexOf('/backend-api/conversations') >= 0 && url.indexOf('/backend-api/conversations/') < 0 && resp.ok) {
          const clone = resp.clone(); const data = await clone.json();
          if (data && Array.isArray(data.items)) { globalThis.__herderChatGptInventory = { at: Date.now(), total: typeof data.total === 'number' ? data.total : data.items.length, chats: data.items.filter(x => x.id && x.title && !x.is_archived && !x.is_temporary_chat).map(x => ({id:x.id,title:x.title,updatedAt:x.update_time,createdAt:x.create_time,asyncStatus:x.async_status})) }; }
        }
      } catch(e) {}
      return resp;
    };
  }
  const inv = globalThis.__herderChatGptInventory;
  if (inv && Array.isArray(inv.chats) && inv.chats.length && Date.now() - inv.at < 90_000) {
    if (!globalThis.__herderChatGptScope) {
      try { const sr = await tracedFetch('auth_session','/api/auth/session','/api/auth/session',{credentials:'same-origin'});
        if (sr.ok) { const s = await sr.json(); if (s && s.account && s.account.id) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.account.id)); globalThis.__herderChatGptScope = [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join(''); } }
      } catch(e) {}
    }
    trace.push({operation:'conversation_list',endpoint:'/backend-api/conversations',http_status:200, latency_ms:0,retry_after_s:null,backoff_ms:0,intercepted:true,age_ms:Math.max(0,Date.now()-inv.at)});
    return {scope: globalThis.__herderChatGptScope || '', chats: inv.chats, source:'intercepted', trace};
  }
  if (Date.now() < (globalThis.__herderChatGptReadCooldownUntil || 0)) return {error:'read_cooldown',trace};
  const sessionResponse = await tracedFetch('auth_session','/api/auth/session','/api/auth/session',{credentials:'same-origin'});
  if (!sessionResponse.ok) return {error:'session_unavailable',trace};
  const session = await sessionResponse.json();
  if (!session.accessToken || !session.account?.id) return {error:'account_unavailable',trace};
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(session.account.id));
  const scope = [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
  const headers = {authorization:'Bearer '+session.accessToken,'chatgpt-account-id':session.account.id};
  const response = await tracedFetch('conversation_list','/backend-api/conversations','/backend-api/conversations?offset=0&limit=100&order=updated',
    {headers,credentials:'same-origin'});
  if (!response.ok) {
    if (response.status === 429) {
      const raSec = parseInt(
        (response.headers && typeof response.headers.get === 'function')
          ? (response.headers.get('retry-after') || '0') : '0', 10);
      globalThis.__herderChatGptReadCooldownUntil = Date.now() +
        (Number.isFinite(raSec) && raSec > 0 ? Math.min(raSec * 1000, 300_000) : 60_000);
    }
    if(trace.length && response.status === 429)
      trace[trace.length-1].backoff_ms = Math.max(0, globalThis.__herderChatGptReadCooldownUntil-Date.now());
    return {error:'list_http_'+response.status,trace};
  }
  const data=await response.json();
  globalThis.__herderChatGptScope = scope;
  return {scope,trace,source:'own_fetch',chats:(data.items||[]).filter(x => x.id && x.title && !x.is_archived && !x.is_temporary_chat)
   .map(x=>({id:x.id,title:x.title,updatedAt:x.update_time,createdAt:x.create_time,asyncStatus:x.async_status}))};
}`;

/** Passive list for the paused harness: reads only what the page already
 * holds — the intercept stash of the site's own /backend-api/conversations
 * responses. Never fetches: no auth session, no conversation list, no
 * cooldown. Answers with whatever age the stash has; an empty stash answers
 * an empty list and the driver falls back to its durable inventory or the
 * visible sidebar. This is the "hook" the owner means: the site feeds the
 * herder, the herder asks the site for nothing. */
export const CHATGPT_LIST_API_PASSIVE_SCRIPT = `async () => {
  if (location.origin !== 'https://chatgpt.com') return {error:'wrong_origin'};
    if (!globalThis.__herderChatGptHook && typeof window !== 'undefined' && typeof window.fetch === 'function') {
    globalThis.__herderChatGptHook = true; globalThis.__herderChatGptInventory = null;
    const origFetch = window.fetch;
    window.fetch = async function(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const resp = await origFetch.apply(this, arguments);
      try {
        if (url.indexOf('/backend-api/conversations') >= 0 && url.indexOf('/backend-api/conversations/') < 0 && resp.ok) {
          const clone = resp.clone(); const data = await clone.json();
          if (data && Array.isArray(data.items)) { globalThis.__herderChatGptInventory = { at: Date.now(), total: typeof data.total === 'number' ? data.total : data.items.length, chats: data.items.filter(x => x.id && x.title && !x.is_archived && !x.is_temporary_chat).map(x => ({id:x.id,title:x.title,updatedAt:x.update_time,createdAt:x.create_time,asyncStatus:x.async_status})) }; }
        }
      } catch(e) {}
      return resp;
    };
  }
  const inv = globalThis.__herderChatGptInventory;
  return {scope: globalThis.__herderChatGptScope || '', chats: inv && Array.isArray(inv.chats) ? inv.chats : [], source:'passive', trace: []};
}`;

/** Paginated full scan of EVERY conversation (one-time at init or via the
 * Web UI rescan button). offset=0,100,200… with 15s gap; respects 429. */
export const CHATGPT_FULL_SCAN_SCRIPT = `async () => {
  const trace = [];
  const tracedFetch = async (operation,endpoint,path,options) => {
    const started=Date.now();
    const r=await fetch(path,options);
    const value=r?.headers && typeof r.headers.get==='function' ? r.headers.get('retry-after'):null;
    const raInt=typeof value==='string' && /^[0-9]{1,8}$/.test(value.trim()) ? parseInt(value,10):0;
    const asDate=typeof value==='string' && !raInt ? Date.parse(value):NaN;
    const raSec=raInt>0?Math.min(86400,raInt) :(Number.isFinite(asDate)?Math.max(0,Math.min(86400,Math.ceil((asDate-Date.now())/1000))):null);
    trace.push({operation,endpoint,http_status:r?.status, latency_ms:Math.max(0,Date.now()-started),retry_after_s:raSec,backoff_ms:0});
    return r;
  };
  if (location.origin !== 'https://chatgpt.com') return {error:'wrong_origin'};
    if (!globalThis.__herderChatGptHook && typeof window !== 'undefined' && typeof window.fetch === 'function') {
    globalThis.__herderChatGptHook = true; globalThis.__herderChatGptInventory = null;
    const origFetch = window.fetch;
    window.fetch = async function(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const resp = await origFetch.apply(this, arguments);
      try {
        if (url.indexOf('/backend-api/conversations') >= 0 && url.indexOf('/backend-api/conversations/') < 0 && resp.ok) {
          const clone = resp.clone(); const data = await clone.json();
          if (data && Array.isArray(data.items)) { globalThis.__herderChatGptInventory = { at: Date.now(), total: typeof data.total === 'number' ? data.total : data.items.length, chats: data.items.filter(x => x.id && x.title && !x.is_archived && !x.is_temporary_chat).map(x => ({id:x.id,title:x.title,updatedAt:x.update_time,createdAt:x.create_time,asyncStatus:x.async_status})) }; }
        }
      } catch(e) {}
      return resp;
    };
  }
  const sessionResponse = await tracedFetch('auth_session','/api/auth/session','/api/auth/session',{credentials:'same-origin'});
  if (!sessionResponse.ok) return {error:'session_unavailable',trace};
  const session = await sessionResponse.json();
  if (!session.accessToken || !session.account?.id) return {error:'account_unavailable',trace};
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(session.account.id));
  const scope = [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
  globalThis.__herderChatGptScope = scope;
  const headers = {authorization:'Bearer '+session.accessToken,'chatgpt-account-id':session.account.id};
  const all = []; let offset = 0; let pages = 0; let total = 0;
  while (true) {
    if (Date.now() < (globalThis.__herderChatGptReadCooldownUntil || 0)) break;
    const response = await tracedFetch('conversation_list','/backend-api/conversations','/backend-api/conversations?offset='+offset+'&limit=100&order=updated', {headers,credentials:'same-origin'});
    pages++;
    if (!response.ok) { if (response.status === 429) { const raSec = parseInt((response.headers && typeof response.headers.get === 'function') ? (response.headers.get('retry-after') || '0') : '0', 10); globalThis.__herderChatGptReadCooldownUntil = Date.now() + (Number.isFinite(raSec) && raSec > 0 ? Math.min(raSec * 1000, 300_000) : 60_000); if(trace.length) trace[trace.length-1].backoff_ms = Math.max(0, globalThis.__herderChatGptReadCooldownUntil-Date.now()); } break; }
    const data = await response.json();
    if (typeof data.total === 'number') total = data.total;
    const items = (data.items||[]).filter(x => x.id && x.title && !x.is_archived && !x.is_temporary_chat);
    if (!items.length) break;
    for (const x of items) all.push({id:x.id,title:x.title,updatedAt:x.update_time,createdAt:x.create_time,asyncStatus:x.async_status});
    if (items.length < 100 || (total && all.length >= total)) break;
    offset += 100;
    await new Promise(r => setTimeout(r, 15000));
  }
  return {scope, trace, pages, total: total || all.length, chats: all, source:'full_scan'};
}`;

export function chatgptMessagesApiScript(chatId: string): string {
  return `async () => {
  const trace = [];
  const tracedFetch = async (operation,endpoint,path,options) => {
    const started=Date.now();
    const r=await fetch(path,options);
    const value=r?.headers && typeof r.headers.get==='function'
      ? r.headers.get('retry-after'):null;
    const raInt=typeof value==='string' && /^[0-9]{1,8}$/.test(value.trim())
      ? parseInt(value,10):0;
    const asDate=typeof value==='string' && !raInt ? Date.parse(value):NaN;
    const raSec=raInt>0?Math.min(86400,raInt)
      :(Number.isFinite(asDate)?Math.max(0,Math.min(86400,Math.ceil((asDate-Date.now())/1000))):null);
    trace.push({operation,endpoint,http_status:r?.status,
      latency_ms:Math.max(0,Date.now()-started),retry_after_s:raSec,
      backoff_ms:0});
    return r;
  };
    const id=${JSON.stringify(chatId)};
    if (location.origin !== 'https://chatgpt.com' || !/^[a-f0-9-]{28,80}$/i.test(id))
      return {error:'invalid_chat'};
    if (Date.now() < (globalThis.__herderChatGptReadCooldownUntil || 0)) return {error:'read_cooldown'};
    const session=await(await tracedFetch('auth_session','/api/auth/session','/api/auth/session',{credentials:'same-origin'})).json();
    if (!session.accessToken || !session.account?.id) return {error:'account_unavailable',trace};
    const r=await tracedFetch('conversation_read','/backend-api/conversations/{id}','/backend-api/conversations/'+encodeURIComponent(id)
      +'?num_turns=60&include_has_versions=true',
      {headers:{authorization:'Bearer '+session.accessToken,'chatgpt-account-id':session.account.id},
       credentials:'same-origin'});
    if (!r.ok) {
      if (r.status === 429) {
        const raSec = parseInt(
          (r.headers && typeof r.headers.get === 'function')
            ? (r.headers.get('retry-after') || '0') : '0', 10);
        globalThis.__herderChatGptReadCooldownUntil = Date.now() +
          (Number.isFinite(raSec) && raSec > 0 ? Math.min(raSec * 1000, 300_000) : 60_000);
      }
        if(trace.length && r.status === 429)
        trace[trace.length-1].backoff_ms = Math.max(0, globalThis.__herderChatGptReadCooldownUntil-Date.now());
      return {error:'history_http_'+r.status,trace};
    }
    const data=await r.json();
    if(data.conversation_id!==id || !Array.isArray(data.messages))return {error:'identity_mismatch',trace};
    const readPart=p=>{
      if(typeof p==='string')return p;
      if(!p||typeof p!=='object')return '';
      if(typeof p.text==='string')return p.text;
      if(typeof p.content==='string')return p.content;
      if(p.content_type==='image_asset_pointer'||p.content_type==='image')return '[Изображение]';
      return '';
    };
    const messages=data.messages.filter(m=>{
      const role=m?.author?.role;
      return (role==='user'||role==='assistant')
        && (role==='user'||(!m.channel||m.channel==='final'||m.channel==='commentary'))
        && (role==='user'||!m.recipient||m.recipient==='all');
    }).map(m=>{
      const text=(Array.isArray(m.content?.parts)?m.content.parts.map(readPart).join('\\n'):
        typeof m.content?.text==='string'?m.content.text:'').trim().slice(0,14000);
      return {id:String(m.id||''),role:m.author.role,text,
        timestamp:typeof m.create_time==='number'&&m.create_time>0
          ?new Date(m.create_time*1000).toISOString():undefined,
        model:typeof m.metadata?.model_slug==='string'?m.metadata.model_slug:undefined};
    }).filter(m=>m.id&&m.text).slice(-180);
    const tail=[];let used=0;
    for(let i=messages.length-1;i>=0;i--){
      const size=messages[i].text.length+160;
      if(used+size>210000)break;
      used+=size;tail.unshift(messages[i]);
    }
    return {messages:tail,trace};
  }`;
}

export const ZAI_LIST_API_SCRIPT = `async () => {
  if (location.origin !== 'https://chat.z.ai') return {error:'wrong_origin'};
  const seen=new Set(),chats=[];
  for(let page=1;page<=2;page++){
    const r=await fetch('/api/v1/chats/?page='+page+'&type=all&channel=zai-web&project_id=',
      {credentials:'same-origin'});
    if(!r.ok)return {error:'list_http_'+r.status};
    const batch=await r.json();
    if(!Array.isArray(batch))return {error:'list_shape'};
    for(const x of batch){
      // A chat without a title is still a real conversation: keep it with an
      // empty title; the driver assigns the stable untitled label. Dropping
      // it here would make the chat invisible to the whole inventory.
      if(!x?.id||seen.has(x.id))continue;
      seen.add(x.id);chats.push({id:x.id,title:typeof x.title==='string'?x.title:'',updatedAt:x.updated_at,
        unread:!!x.has_unread_msg,
        lastRunStatus:typeof x.last_run?.status==='string'?x.last_run.status:undefined});
    }
    if(batch.length<60)break;
  }
  chats.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  const top=chats.slice(0,100);
  if(!top.length)return {chats:[]};
  const info=await(await fetch('/api/v1/chats/'+encodeURIComponent(top[0].id),
    {credentials:'same-origin'})).json();
  if(!info?.user_id)return {error:'account_unavailable'};
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(info.user_id)));
  const scope=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
  return {scope,chats:top};
}`;

export function zaiMessagesApiScript(chatId: string): string {
  return `async () => {
    const id=${JSON.stringify(chatId)};
    if(location.origin!=='https://chat.z.ai'||!/^[a-f0-9-]{12,80}$/i.test(id))
      return {error:'invalid_chat'};
    const response=await fetch('/api/v1/chats/'+encodeURIComponent(id),
      {credentials:'same-origin'});
    if(!response.ok)return {error:'chat_http_'+response.status};
    const chat=await response.json();
    if(chat.id!==id)return {error:'identity_mismatch'};
    const ids=Object.keys(chat.chat?.history?.messages||{}).slice(-180);
    if(!ids.length)return {messages:[]};
    const all=[];
    for(let start=0;start<ids.length;start+=60){
      const part=ids.slice(start,start+60);
      const batch=await fetch('/api/v1/chats/'+encodeURIComponent(id)+'/messages/batch',
        {method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
         body:JSON.stringify({ids:part})});
      if(!batch.ok)return {error:'batch_http_'+batch.status};
      const d=await batch.json();
      if(d.chat_id!==id||!d.data||typeof d.data!=='object')return {error:'batch_identity_mismatch'};
      for(const item of part)if(d.data[item])all.push(d.data[item]);
    }
    const messages=all.filter(m=>m?.role==='user'||m?.role==='assistant').map(m=>{
      const blocks=Array.isArray(m.content_blocks)?m.content_blocks:[];
      const text=typeof m.content==='string'?m.content:
        blocks.filter(b=>b.type==='text'||b.type==='markdown')
          .map(b=>typeof b.content==='string'?b.content:'').join('\\n');
      const timestamp=m.created_at||m.timestamp;
      return {id:String(m.id||''),role:m.role,text:text.trim().slice(0,14000),
        timestamp:typeof timestamp==='number'&&timestamp>0
          ?new Date(timestamp<1e12?timestamp*1000:timestamp).toISOString():undefined,
        model:typeof m.model==='string'?m.model:undefined};
    }).filter(m=>m.id&&m.text);
    messages.sort((a,b)=>(a.timestamp||'').localeCompare(b.timestamp||''));
    const tail=[];let used=0;
    for(let i=messages.length-1;i>=0;i--){
      const size=messages[i].text.length+160;
      if(used+size>210000)break;
      used+=size;tail.unshift(messages[i]);
    }
    return {messages:tail};
  }`;
}


/** List the account's ZAI projects (chat.z.ai/project/<uuid>). Read-only. */
export const ZAI_LIST_PROJECTS_SCRIPT = `async () => {
  const r = await fetch('/api/v1/projects',{credentials:'same-origin'});
  if (!r.ok) return {error:'projects_http_'+r.status};
  const d = await r.json();
  return {projects: (Array.isArray(d)?d:[]).filter(p=>p&&p.id&&p.name)
    .map(p=>({id:p.id,name:p.name,chatCount:p.chat_count||0,archived:!!p.archived}))};
}`;

/** Move a ZAI chat into a project: PATCH /api/v1/chats/<id> with {project_id}. */
export function zaiMoveToProjectScript(chatId: string, projectId: string): string {
  return `async () => {
    const id=${JSON.stringify(chatId)};
    const pid=${JSON.stringify(projectId)};
    if (location.origin !== 'https://chat.z.ai' || !/^[a-f0-9-]{12,80}$/i.test(id))
      return {error:'invalid_chat'};
    const r = await fetch('/api/v1/chats/'+encodeURIComponent(id),
      {method:'PATCH',credentials:'same-origin',
       headers:{'content-type':'application/json'},
       body:JSON.stringify({project_id:pid})});
    return {ok:r.ok,status:r.status};
  }`;
}
