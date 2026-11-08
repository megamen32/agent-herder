/** Z.ai's native archive endpoint is a toggle: read before and after, call once. */
export function zaiArchiveScript(id: string, expectedScope: string): string {
  return `async () => {
    const id=${JSON.stringify(id)}, expected=${JSON.stringify(expectedScope)};
    if(location.origin!=='https://chat.z.ai'||!/^[a-f0-9-]{12,80}$/i.test(id))return {ok:false,error:'invalid_chat'};
    const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),20000);let mutation=false;
    try {
      const token=localStorage.getItem('token');
      const headers={'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})};
      const url='/api/v1/chats/'+encodeURIComponent(id);
      const read=async()=>{const r=await fetch(url,{headers,credentials:'same-origin',signal:ac.signal});if(!r.ok)return {error:'chat_http_'+r.status};return await r.json()};
      const before=await read();
      if(before.error)return {ok:false,error:before.error};
      if(before.id!==id||!before.user_id)return {ok:false,error:'identity_mismatch'};
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(before.user_id)));
      const scope=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
      if(scope!==expected)return {ok:false,error:'account_scope_mismatch'};
      if(before.archived===true)return {ok:true,already:true};
      if(before.archived!==false)return {ok:false,error:'archive_state_unknown'};
      if(['running','pending','in_progress'].includes(before.last_run?.status))return {ok:false,error:'conversation_busy'};
      mutation=true;
      const r=await fetch(url+'/archive',{method:'POST',headers,credentials:'same-origin',signal:ac.signal});
      if(!r.ok)return {ok:false,error:'archive_http_'+r.status};
      const after=await read();
      return after.id===id&&after.user_id===before.user_id&&after.archived===true?{ok:true}:{ok:false,error:'archive_readback_unconfirmed'};
    }catch{return {ok:false,error:mutation?'archive_outcome_unknown':'archive_preflight_failed'}}finally{clearTimeout(timer)}
  }`;
}
