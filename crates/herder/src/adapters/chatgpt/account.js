async function chatGptAccount(){
  if(location.origin!=="https://chatgpt.com")return {origin:location.origin};
  const r=await fetch('/api/auth/session',{credentials:'same-origin',cache:'no-store'});
  if(!r.ok)return {origin:location.origin};
  const s=await r.json();
  const id=s&&s.account&&s.account.id;
  if(typeof id!=="string"||!id)return {origin:location.origin};
  const hash=async value=>{
    const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
    return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,'0')).join('');
  };
  const user=s?.user?.id;
  const userioScope=typeof user==='string'&&user
    ? await hash(JSON.stringify({provider:'chatgpt',user_id:user,account_id:id})) : null;
  return {origin:location.origin,scope:await hash(id),userioScope};
}
