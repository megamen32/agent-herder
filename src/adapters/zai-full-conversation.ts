/** Obtain every native message for one exact Z.ai conversation on explicit request. */
export function zaiFullConversationScript(chatId: string, transferId = ""): string {
  return `async () => {
    const id=${JSON.stringify(chatId)}, transferId=${JSON.stringify(transferId)};
    if(location.origin!=='https://chat.z.ai'||!/^[a-f0-9-]{12,80}$/i.test(id)) return {error:'invalid_chat'};
    const response=await fetch('/api/v1/chats/'+encodeURIComponent(id),{credentials:'same-origin'});
    if(!response.ok) return {error:'chat_http_'+response.status};
    const chat=await response.json();
    if(chat.id!==id || !chat.chat?.history?.messages || typeof chat.chat.history.messages!=='object' || Array.isArray(chat.chat.history.messages)) return {error:'identity_or_history_mismatch'};
    const ids=Object.keys(chat.chat.history.messages);
    const messages={};
    for(let start=0;start<ids.length;start+=60){
      const requested=ids.slice(start,start+60);
      const batch=await fetch('/api/v1/chats/'+encodeURIComponent(id)+'/messages/batch',{
        method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({ids:requested})});
      if(!batch.ok) return {error:'batch_http_'+batch.status};
      const data=await batch.json();
      if(data.chat_id!==id || !data.data || typeof data.data!=='object' || Array.isArray(data.data)) return {error:'batch_identity_mismatch'};
      for(const key of requested){
        if(!Object.prototype.hasOwnProperty.call(data.data,key) || !data.data[key] || data.data[key].id!==key) return {error:'batch_incomplete'};
        messages[key]=data.data[key];
      }
    }
    const data={conversation_id:id,chat,messages};
    if(!transferId) return {data};
    const text=JSON.stringify(data);
    if(text.length>16*1024*1024) return {error:'conversation_too_large'};
    globalThis.__herderFullConversationTransfers ||= {};
    const now=Date.now();
    for(const [key,entry] of Object.entries(globalThis.__herderFullConversationTransfers)) if(now-entry.at>5*60*1000) delete globalThis.__herderFullConversationTransfers[key];
    globalThis.__herderFullConversationTransfers[transferId]={text,at:now};
    return {transferId,length:text.length,chunkSize:65536};
  }`;
}
