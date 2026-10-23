import type {SessionSearchQuery} from './session-search.js';
import {lexicalMatch} from './session-search.js';
import {unwrapResult} from './mesh/protocol.js';

export interface SearchPeer {hostId:string;target:string}
export async function searchSessionFleet(input:SessionSearchQuery&{hostId?:string},peers:readonly SearchPeer[],call:(peer:SearchPeer,args:SessionSearchQuery)=>Promise<unknown>,deadlineMs=10000){
 lexicalMatch(input.query);
 if(input.hostId&&!peers.some(peer=>peer.hostId===input.hostId))throw new Error('search_host_invalid');
 const selected=peers.filter(peer=>!input.hostId||input.hostId===peer.hostId);
 const started=performance.now();
 const hosts=await Promise.all(selected.map(async peer=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const response=unwrapResult(await Promise.race([call(peer,{query:input.query,limit:input.limit,harnesses:input.harnesses}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('search_host_deadline')),deadlineMs);})]));
   if(response.hostId!==peer.hostId||!Array.isArray(response.results)||typeof response.partial!=='boolean')throw new Error('search_host_response_invalid');
   if(response.results.some((row:Record<string,unknown>)=>!row||row.hostId!==peer.hostId||typeof row.harness!=='string'||typeof row.nativeSessionId!=='string'))throw new Error('search_result_identity_invalid');
   return {hostId:peer.hostId,state:'available' as const,...response};
  }catch(error){return {hostId:peer.hostId,state:'unavailable' as const,partial:true,results:[],reason:error instanceof Error?error.message.slice(0,120):'search_host_unavailable'};}
  finally{if(timer)clearTimeout(timer);}
 }));
 // BM25 scores from different corpora are not comparable. Preserve host groups.
 return {results:hosts.flatMap(host=>host.results as Array<Record<string,unknown>>),hosts,partial:hosts.length===0||hosts.some(host=>host.partial),elapsedMs:Math.round((performance.now()-started)*100)/100};
}
