import type {AgentSession} from '../types/index.js';
import {addressKey,compactSession,type MeshAddress,type MeshSession} from './protocol.js';
import {projectPeerSession} from './gptadmin.js';
import {coordinationNotes} from '../coordination-notes.js';
export interface InventorySession extends MeshSession {parentAddress?:MeshAddress}
export interface SessionInventoryPage {hostId:string;sessions:InventorySession[];nextCursor:string|null;observedAt:string|null;warming:boolean;partial:boolean;total:number}
export interface LocalInventorySnapshot {sessions:AgentSession[];warming:boolean;observedAt:string|null}
/** Pages the existing process-owned metadata snapshot. Never starts discovery/history/a writer. */
export function sessionInventoryPage(hostId:string,snapshot:LocalInventorySnapshot,cursor?:string,limit=100):SessionInventoryPage {
 if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('inventory_page_limit');
 let after='';let previousObservedAt:string|null=null;
 if(cursor){
  if(cursor.length>2048||!/^[A-Za-z0-9_-]+$/.test(cursor))throw new Error('inventory_cursor_invalid');
  let value:unknown;try{value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch{throw new Error('inventory_cursor_invalid');}
  if(!Array.isArray(value)||value.length!==3||value[0]!==hostId||typeof value[1]!=='string'||value[1].length>1536||/[\x00-\x1f\x7f]/.test(value[1])||value[2]!==null&&typeof value[2]!=='string')throw new Error('inventory_cursor_invalid');
  after=value[1];previousObservedAt=value[2];
 }
 const keys=new Set<string>();let partial=snapshot.warming||snapshot.observedAt===null||Date.now()-Date.parse(snapshot.observedAt??'')>60000||Boolean(cursor&&previousObservedAt!==snapshot.observedAt);
 const rows=snapshot.sessions.map(row=>({row,key:row.harness+':'+row.id})).sort((a,b)=>a.key.localeCompare(b.key));
 const selected=rows.filter(r=>r.key.localeCompare(after)>0).slice(0,limit);
 const sessions:InventorySession[]=[];
 for(const {row} of selected){
  try{
   const workspace=coordinationNotes.cachedWorkspaceObservation(row.id);
   const activeCwd=workspace?.cwd??coordinationNotes.activeWorkspaceForSession(row.id);
   const projected=activeCwd?{...row,cwd:activeCwd,meta:{...row.meta,launchCwd:row.meta?.launchCwd??row.cwd,activeCwd,workspaceHostId:workspace?.hostId??hostId,workspaceExpiresAt:workspace?.expiresAt,projectSource:workspace?.source??'coordination_activity'}}:row;
   const s=projectPeerSession(compactSession(hostId,projected),hostId);if(!s){partial=true;continue;}
   const key=addressKey(s.address);if(keys.has(key)){partial=true;continue;}keys.add(key);
   const parent=row.meta?.parentSessionKey;let parentAddress:MeshAddress|undefined;
   if(typeof parent==='string'&&parent.includes(':')){const at=parent.indexOf(':');const a={hostId,harness:parent.slice(0,at),nativeSessionId:parent.slice(at+1)};try{addressKey(a);parentAddress=a;}catch{partial=true;}}
   sessions.push({...s,...(parentAddress?{parentAddress}:{})});
  }catch{partial=true;}
 }
 const last=selected.at(-1)?.key;const more=Boolean(last&&rows.some(r=>r.key.localeCompare(last)>0));
 return {hostId,sessions,nextCursor:more?Buffer.from(JSON.stringify([hostId,last,snapshot.observedAt])).toString('base64url'):null,observedAt:snapshot.observedAt,warming:snapshot.warming,partial,total:rows.length};
}
