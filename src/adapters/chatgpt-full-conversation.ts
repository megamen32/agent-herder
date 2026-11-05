/** Read the exact native conversation object on the user's authenticated page.
 * Tokens stay inside the page; only the requested conversation is returned. */
export function chatgptFullConversationApiScript(chatId: string, transferId?: string): string {
  return `async () => {
    const id=${JSON.stringify(chatId)};
    if(location.origin!=='https://chatgpt.com'||!/^[a-f0-9-]{28,80}$/i.test(id)) return {error:'invalid_chat'};
    if(Date.now() < (globalThis.__herderChatGptReadCooldownUntil || 0)) return {error:'read_cooldown'};
    const auth=await fetch('/api/auth/session',{credentials:'same-origin'});
    if(!auth.ok) return {error:'auth_http_'+auth.status};
    const session=await auth.json();
    if(!session.accessToken) return {error:'account_unavailable'};
    const headers={authorization:'Bearer '+session.accessToken};
    if(session.account?.id) headers['chatgpt-account-id']=session.account.id;
    const response=await fetch('/backend-api/conversation/'+encodeURIComponent(id),{headers,credentials:'same-origin'});
    if(!response.ok) return {error:'history_http_'+response.status};
    const data=await response.json();
    if(data.conversation_id!==id || !data.mapping || typeof data.mapping!=='object' || Array.isArray(data.mapping)) return {error:'identity_mismatch'};
    const transferId=${JSON.stringify(transferId || "")};
    if(!transferId) return {data};
    const text=JSON.stringify(data);
    if(text.length>100*1024*1024) return {error:'conversation_too_large'};
    globalThis.__herderFullConversationTransfers ||= {};
    const now=Date.now();
    for(const [key,entry] of Object.entries(globalThis.__herderFullConversationTransfers)) if(now-entry.at>5*60*1000) delete globalThis.__herderFullConversationTransfers[key];
    globalThis.__herderFullConversationTransfers[transferId]={text,at:now};
    return {transferId,length:text.length,chunkSize:65536};
  }`;
}

import type { SessionMessageView } from '../types/index.js';
/** Render user-visible text. Native raw export retains non-text and alternate branches. */
export function chatgptConversationMessages(value: unknown): SessionMessageView[] {
  const data = value as { current_node?: string; mapping?: Record<string, { parent?: string | null; message?: { id?: string; author?: { role?: string }; recipient?: string; channel?: string; create_time?: number; metadata?: { model_slug?: string }; content?: { parts?: unknown[]; text?: string } } | null }> };
  const mapping = data?.mapping || {};
  let nodes = Object.values(mapping);
  if (data.current_node && mapping[data.current_node]) {
    const seen = new Set<string>(); const chain: typeof nodes = []; let current: string | null | undefined = data.current_node;
    while (current && mapping[current] && !seen.has(current)) { seen.add(current); const node: (typeof nodes)[number] = mapping[current]!; chain.push(node); current = node.parent; }
    nodes = chain.reverse();
  } else nodes.sort((a,b) => (a.message?.create_time || 0) - (b.message?.create_time || 0));
  return nodes.flatMap(node => {
    const m=node.message, role=m?.author?.role;
    if (!m || !m.id || (role !== 'user' && role !== 'assistant') || (role === 'assistant' && ((m.channel && !['final','commentary'].includes(m.channel)) || (m.recipient && m.recipient !== 'all')))) return [];
    const text=(Array.isArray(m.content?.parts) ? m.content.parts.map(part => typeof part === 'string' ? part : (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : '')).join('\n') : (m.content?.text || '')).trim();
    if (!text) return [];
    return [{ id:m.id, role, text, parts:[{type:'text' as const,text}], ...(m.create_time ? {timestamp:new Date(m.create_time*1000).toISOString()} : {}), ...(m.metadata?.model_slug ? {model:m.metadata.model_slug} : {}) }];
  });
}

/** Read one transfer chunk; the caller verifies the exact total length. */
export function chatgptConversationChunkScript(transferId: string, offset: number, size: number): string {
  return `() => { const entry=globalThis.__herderFullConversationTransfers?.[${JSON.stringify(transferId)}];
    if(!entry) return {error:'transfer_expired'};
    return {offset:${offset},text:entry.text.slice(${offset},${offset + size})}; }`;
}
export function chatgptConversationCleanupScript(transferId: string): string {
  return `() => { if(globalThis.__herderFullConversationTransfers) delete globalThis.__herderFullConversationTransfers[${JSON.stringify(transferId)}]; return {ok:true}; }`;
}
