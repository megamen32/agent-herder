/** Archive an exact conversation, never delete it. Credentials remain in-page. */
export function chatgptArchiveScript(chatId: string, expectedScope: string): string {
  return `async () => {
    if(location.origin!=='https://chatgpt.com')return {ok:false,error:'wrong_origin'};
    const id=${JSON.stringify(chatId)}, expected=${JSON.stringify(expectedScope)};
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    let mutation=false;
    try {
      const auth=await fetch('/api/auth/session',{credentials:'same-origin',signal:controller.signal});
      if(!auth.ok)return {ok:false,error:'auth_unavailable'};
      const session=await auth.json();
      if(!session.accessToken||!session.account?.id)return {ok:false,error:'account_unavailable'};
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(session.account.id));
      const scope=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
      if(scope!==expected)return {ok:false,error:'account_scope_mismatch'};
      const headers={authorization:'Bearer '+session.accessToken,'chatgpt-account-id':session.account.id,'content-type':'application/json'};
      const url='/backend-api/conversation/'+encodeURIComponent(id);
      const read=async()=>{const r=await fetch(url,{headers,credentials:'same-origin',signal:controller.signal});if(!r.ok)return {error:'http_'+r.status};return await r.json()};
      const before=await read();
      if(before.error)return {ok:false,error:before.error};
      if(before.conversation_id!==id)return {ok:false,error:'conversation_identity_mismatch'};
      if(before.is_archived===true)return {ok:true,already:true};
      if(before.async_status==='running'||before.is_generating===true)return {ok:false,error:'conversation_busy'};
      mutation=true;
      const response=await fetch(url,{method:'PATCH',headers,credentials:'same-origin',signal:controller.signal,body:JSON.stringify({is_archived:true})});
      if(!response.ok)return {ok:false,error:'archive_http_'+response.status};
      const after=await read();
      return after.conversation_id===id&&after.is_archived===true?{ok:true}:{ok:false,error:'archive_readback_unconfirmed'};
    }catch{return {ok:false,error:mutation?'archive_outcome_unknown':'archive_preflight_failed'}}finally{clearTimeout(timer)}
  }`;
}
