import type {AgentSession} from '../types/index.js';
/** Native active identities first, metadata second: no historical list window. */
export async function readOpenCodeActiveSessions(options:{v2:boolean;read:(path:string)=>Promise<unknown>;hostId:string}){
 const root=options.v2?'/api':'';
 const raw=await options.read(`${root}/session/${options.v2?'active':'status'}`);
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('opencode_active_status_invalid');
 const states=new Map<string,string>();
 for(const [id,value] of Object.entries(raw)){const row=value as {status?:string;type?:string};const state=row?.status??row?.type;if(typeof state!=='string')throw new Error('opencode_active_state_missing');if(['running','busy','active','retry'].includes(state))states.set(id,'running');else if(!['idle','stopped','completed','error','failed','aborted'].includes(state))throw new Error('opencode_active_state_unknown');}
 if(options.v2){const permissions=await options.read(`${root}/permission/request`);if(!Array.isArray(permissions))throw new Error('opencode_active_permissions_invalid');for(const p of permissions){if(typeof p?.sessionID!=='string')throw new Error('opencode_active_permission_identity_invalid');states.set(p.sessionID,'needs_input');}}
 const observedAt=new Date().toISOString(),expiresAt=new Date(Date.now()+30000).toISOString();
 const entries=[...states];const sessions:AgentSession[]=[];let cursor=0;
 await Promise.all(Array.from({length:Math.min(8,entries.length)},async()=>{while(cursor<entries.length){const [id,status]=entries[cursor++]!;const row=await options.read(`${root}/session/${encodeURIComponent(id)}`) as {id?:string;title?:string;directory?:string;location?:{directory?:string};parentID?:string;time?:{updated?:number}};if(row?.id!==id)throw new Error('opencode_active_metadata_identity_invalid');sessions.push({id,harness:'opencode',title:row.title||id,cwd:row.location?.directory||row.directory||'',hostId:options.hostId,status:status as AgentSession['status'],lastActivity:new Date(row.time?.updated||0).toISOString(),needsPermission:status==='needs_input',meta:{activityEvidence:'opencode-native-active-status',activityObservedAt:observedAt,activityExpiresAt:expiresAt,...(row.parentID?{parentSessionId:row.parentID}:{})}});}}));
 return {sessions,receipt:{exhaustive:true,observedAt,source:'opencode-native-active-status'}};
}
