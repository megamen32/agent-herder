async function listZaiChats(expected, authenticateEmpty) {
  if(location.origin!=="https://chat.z.ai")return {origin:location.origin};
  const options={credentials:'same-origin',cache:'no-store',mode:'same-origin',redirect:'error'};
  const r=await fetch('/api/v1/chats/?page=1&type=all&channel=zai-web&project_id=',options);
  if(!r.ok)return {origin:location.origin,status:r.status};
  let chats;try{chats=await r.json()}catch{return {origin:location.origin,error:'invalid_json'}};
  if(!Array.isArray(chats))return {origin:location.origin,error:'invalid_list'};
  const unverified={origin:location.origin,error:'account_unverified'};
  const empty=chats.length===0, first=chats[0]?.id;
  if(empty ? !authenticateEmpty : typeof first!=='string')return unverified;
  const proof=await fetch(empty ? '/api/v1/auths/' : '/api/v1/chats/'+encodeURIComponent(first),options);
  if(!proof.ok)return empty ? {origin:location.origin,status:proof.status} : unverified;
  let record;try{record=await proof.json()}catch{return unverified};
  const owner=empty ? record?.id : record?.user_id;
  if(empty ? typeof owner!=='string'||!owner.trim() : record?.id!==first||!owner)return unverified;
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(owner)));
  const scope=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
  if(scope!==expected)return {origin:location.origin,error:'account_mismatch',scope,scope_verified:true};
  // A cached owned chat can still be readable after the browser switches
  // accounts. The native inventory also proves the current login.
  if(authenticateEmpty&&!empty){
    const auth=await fetch('/api/v1/auths/',options);
    if(!auth.ok)return {origin:location.origin,status:auth.status};
    let session;try{session=await auth.json()}catch{return unverified};
    if(typeof session?.id!=='string'||session.id!==String(owner))return {origin:location.origin,error:'account_mismatch'};
  }
  return {origin:location.origin,chats,scope,scope_verified:true};
}
