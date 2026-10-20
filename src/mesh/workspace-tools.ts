import {hostname} from 'node:os';
import {realpath,stat} from 'node:fs/promises';
import {z} from 'zod';
import type {McpServer} from '@modelcontextprotocol/server';
import {coordinationNotes,type CoordinationNoteStore} from '../coordination-notes.js';
import {addressKey,unwrapResult,type MeshAddress} from './protocol.js';
import type {GptAdminTransport} from './gptadmin.js';

const host=z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const cwd=z.string().min(1).max(4096).refine(s=>s.startsWith('/')&&!/[\x00-\x1f\x7f]/.test(s),'Absolute POSIX workspace required');
const owner=z.object({hostId:host,harness:z.string().min(1).max(64),nativeSessionId:z.string().min(1).max(256)}).strict();
const identity=z.object({sessionId:z.string().min(1).max(256),harness:z.string().min(1).max(64)});
const ttl=z.number().int().min(60).max(604800).default(1800);
const paths=z.array(z.string().min(1).max(4096)).max(64);
const reply=(value:Record<string,unknown>)=>({structuredContent:value,content:[{type:'text' as const,text:JSON.stringify(value)}]});
const compact=(notes:any[])=>notes.slice(0,64).map(n=>({id:n.id,hostId:n.hostId,cwd:n.cwd,authorSessionId:n.authorSessionId,kind:n.kind,paths:n.paths,expiresAt:n.expiresAt}));

/** Explicit workspace state is separate from the native session's routing address.
 * Peer operations use the existing authenticated transport, never shell-derived CWD guesses. */
export function registerWorkspaceTools(server:McpServer,deps:{hostId?:string;coordination?:CoordinationNoteStore;transport:GptAdminTransport}):void{
 const local=deps.hostId??hostname(),store=deps.coordination??coordinationNotes;
 const peer=async(hostId:string,tool:string,args:Record<string,unknown>)=>{
  const value=unwrapResult(await deps.transport.call(`mcp:shell:${hostId}:AgentHerder`,tool,args));
  if(value.hostId!==hostId)throw new Error('workspace_peer_identity_mismatch');
  return value;
 };
 const probe=async(path:string)=>{
  const canonical=await realpath(path);if(!(await stat(canonical)).isDirectory())throw new Error('workspace_not_directory');
  return {hostId:local,cwd:canonical};
 };
 server.registerTool('workspace_probe',{description:'Verify a directory on this actual host; returns canonical path and host identity. Does not execute commands.',inputSchema:z.object({cwd}).strict()},async a=>reply(await probe(a.cwd)));
 server.registerTool('workspace_reserve',{description:'Reserve paths on this workspace host for a fully addressed session. Owner identity is attribution, not caller authentication.',inputSchema:z.object({owner,cwd,paths,ttlSeconds:ttl}).strict()},async a=>{
  const verified=await probe(a.cwd);
  // Full owner identity prevents equal native IDs on different machines colliding.
  const id=a.owner.hostId===local?a.owner.nativeSessionId:addressKey(a.owner);
  const result=await store.reservePaths({harness:a.owner.harness,sessionId:id,cwd:verified.cwd,hostId:local,paths:a.paths,ttlSeconds:a.ttlSeconds});
  return reply({...verified,reservations:compact(result.reservations),conflicts:result.conflicts.map(c=>({path:c.path,note:compact([c.note])[0]}))});
 });
 server.registerTool('workspace_owners',{description:'Read current owners on this actual host and path, without transcript bodies.',inputSchema:z.object({cwd}).strict()},async a=>{
  const verified=await probe(a.cwd);return reply({...verified,owners:compact(await store.list({cwd:verified.cwd,hostId:local}))});
 });
 server.registerTool('workspace_declare',{description:'Declare actual work host and directory, separately from native launch host/CWD. Verifies the directory on its host. Does not move or execute the session. Renew before TTL expires; release when done.',inputSchema:identity.extend({hostId:host,cwd,ttlSeconds:ttl}).strict()},async a=>{
  const verified=a.hostId===local?await probe(a.cwd):await peer(a.hostId,'workspace_probe',{cwd:a.cwd});
  if(typeof verified.cwd!=='string'||!verified.cwd.startsWith('/'))throw new Error('workspace_probe_invalid');
  const workspace=await store.declareWorkspace({...a,cwd:verified.cwd});
  return reply({session:{hostId:local,harness:a.harness,nativeSessionId:a.sessionId},workspace:{...workspace,source:'declared'}});
 });
 server.registerTool('workspace_status',{description:'Read declared actual workspace and current host-owned reservations. Native message address remains the launch host.',inputSchema:identity.strict()},async a=>{
  const workspace=await store.activeWorkspaceObservation(a.sessionId);
  if(!workspace)return reply({session:{hostId:local,harness:a.harness,nativeSessionId:a.sessionId},workspace:null});
  const owners=workspace.hostId===local?{hostId:local,cwd:workspace.cwd,owners:compact(await store.list({cwd:workspace.cwd,hostId:local}))}:await peer(workspace.hostId,'workspace_owners',{cwd:workspace.cwd});
  return reply({session:{hostId:local,harness:a.harness,nativeSessionId:a.sessionId},workspace,owners:owners.owners});
 });
 server.registerTool('workspace_activity',{description:'Before editing the declared workspace, reserve exact paths and check conflicts on the actual workspace host. Local shell activity is never guessed to be remote.',inputSchema:identity.extend({paths,ttlSeconds:ttl}).strict()},async a=>{
  const workspace=await store.activeWorkspaceObservation(a.sessionId);if(!workspace||workspace.source!=='declared')throw new Error('workspace_declaration_required');
  const address:MeshAddress={hostId:local,harness:a.harness,nativeSessionId:a.sessionId};
  if(workspace.hostId!==local)return reply(await peer(workspace.hostId,'workspace_reserve',{owner:address,cwd:workspace.cwd,paths:a.paths,ttlSeconds:a.ttlSeconds}));
  const result=await store.reservePaths({harness:a.harness,sessionId:a.sessionId,hostId:local,cwd:workspace.cwd,paths:a.paths,ttlSeconds:a.ttlSeconds});
  return reply({hostId:local,cwd:workspace.cwd,reservations:compact(result.reservations),conflicts:result.conflicts.map(c=>({path:c.path,note:compact([c.note])[0]}))});
 });
 server.registerTool('workspace_release',{description:'Clear this session workspace declaration. Existing file leases expire by their own TTL; no unrelated owner is removed.',inputSchema:identity.strict()},async a=>{await store.clearWorkspace(a.sessionId);return reply({released:true});});
}
