import type { AgentSession } from '../types/index.js';

type Permission = { id: string; sessionID?: string; action?: string };

function httpStatus(error: unknown): number | undefined {
 const message=error instanceof Error?error.message:String(error);
 const match=message.match(/(?:^|[_\s])http[_\s:-]?(\d{3})$/i);
 return match?Number(match[1]):undefined;
}

/** Native active identities first, metadata second: no historical list window. */
export async function readOpenCodeActiveSessions(options:{v2:boolean;read:(path:string)=>Promise<unknown>;hostId:string}){
 const root=options.v2?'/api':'';
 const raw=await options.read(`${root}/session/${options.v2?'active':'status'}`);
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('opencode_active_status_invalid');
 const active=new Map<string,string>();
 for(const [id,value] of Object.entries(raw)){
  const row=value as {status?:string;type?:string};
  const state=row?.status??row?.type;
  if(typeof state!=='string')throw new Error('opencode_active_state_missing');
  if(['running','busy','active','retry'].includes(state))active.set(id,'running');
  else if(!['idle','stopped','completed','error','failed','aborted'].includes(state))throw new Error('opencode_active_state_unknown');
 }

 // The global route is an incomplete candidate index: a successful session-scoped
 // empty response remains authoritative, and global rows are trusted only when
 // the session-scoped route proves unsupported with 404.
 let globalPermissions:Permission[]=[];
 let permissionDiscoveryComplete=true;
 let exactPermissionReadComplete=true;
 if(options.v2){
  try{
   const value=await options.read(`${root}/permission/request`);
   if(!Array.isArray(value)||value.some((permission)=>!permission||typeof permission!=='object'||typeof permission.sessionID!=='string'||typeof permission.id!=='string'))throw new Error('opencode_active_permissions_invalid');
   globalPermissions=value as Permission[];
  }catch{permissionDiscoveryComplete=false;}
 }
 const globalBySession=new Map<string,Permission[]>();
 for(const permission of globalPermissions){const rows=globalBySession.get(permission.sessionID!)??[];rows.push(permission);globalBySession.set(permission.sessionID!,rows);}

 const readSessionPermissions=async(sessionId:string):Promise<Permission[]>=>{
  if(!options.v2)return [];
  try{
   const value=await options.read(`${root}/session/${encodeURIComponent(sessionId)}/permission`);
   if(!Array.isArray(value)||value.some((permission)=>!permission||typeof permission!=='object'||permission.sessionID!==sessionId||typeof permission.id!=='string'))throw new Error('opencode_active_session_permissions_invalid');
   return value as Permission[];
  }catch(error){
   if(httpStatus(error)!==404)throw error;
   const fallback=globalBySession.get(sessionId);
   if(!fallback)exactPermissionReadComplete=false;
   return fallback??[];
  }
 };

 const observedAt=new Date().toISOString(),expiresAt=new Date(Date.now()+30000).toISOString();
 const entries=[...new Set([...Object.keys(raw),...globalBySession.keys()])];const sessions:AgentSession[]=[];let cursor=0;
 await Promise.all(Array.from({length:Math.min(8,entries.length)},async()=>{
  while(cursor<entries.length){
   const id=entries[cursor++]!;
   const permissions=await readSessionPermissions(id);
   const status=permissions.length>0?'needs_input':active.get(id);
   if(!status)continue;
   const row=await options.read(`${root}/session/${encodeURIComponent(id)}`) as {id?:string;title?:string;directory?:string;location?:{directory?:string};parentID?:string;time?:{updated?:number}};
   if(row?.id!==id)throw new Error('opencode_active_metadata_identity_invalid');
   sessions.push({id,harness:'opencode',title:row.title||id,cwd:row.location?.directory||row.directory||'',hostId:options.hostId,status:status as AgentSession['status'],lastActivity:new Date(row.time?.updated||0).toISOString(),needsPermission:status==='needs_input',meta:{activityEvidence:'opencode-native-active-status',activityObservedAt:observedAt,activityExpiresAt:expiresAt,...(row.parentID?{parentSessionId:row.parentID}:{})}});
  }
 }));
 return {sessions,receipt:{exhaustive:permissionDiscoveryComplete&&exactPermissionReadComplete,observedAt,source:'opencode-native-active-status'}};
}
