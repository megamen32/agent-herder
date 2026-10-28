import {randomUUID} from 'node:crypto';
import {SessionSearchIndex,type SearchSessionInput,type SearchSourceReceipt} from './session-search.js';

export type SessionSearchScanner=(options:{signal?:AbortSignal;onStatus?:(status:SearchSourceReceipt)=>void})=>AsyncIterable<SearchSessionInput>;
/** Only the persistent owner scans. MCP and API searches never invoke this. */
export async function startSessionSearchIndexer(scanner:SessionSearchScanner,options:{path?:string;intervalMs?:number;ownerToken?:string;enabled?:boolean;isEnabled?:()=>boolean}={}){
 let index:SessionSearchIndex|undefined;const token=options.ownerToken??randomUUID();
 let enabled=options.enabled!==false,abort:AbortController|undefined,timer:ReturnType<typeof setTimeout>|undefined,closed=false;
 let pending:Promise<void>=Promise.resolve();
 const allowed=()=>enabled&&options.isEnabled?.()!==false;
 const claim=()=>{if(index)return true;const opened=new SessionSearchIndex(options.path);if(!opened.claimOwner(token)){opened.close();return false;}opened.pruneInterruptedGenerations();index=opened;return true;};
 // A paused restart must not even open/claim/prune the SQLite writer.
 if(allowed()&&!claim())return undefined;
 const run=()=>{
  if(closed||!allowed()||!claim())return;
  const receipts:SearchSourceReceipt[]=[];abort=new AbortController();const signal=abort.signal;
  const guarded=async function*(){
   for await(const session of scanner({signal,onStatus:receipt=>receipts.push(receipt)})){
    signal.throwIfAborted();if(!allowed())throw new Error('background_indexing_paused');
    const chunks=session.chunks;
    yield {...session,chunks:(async function*(){for await(const chunk of chunks){signal.throwIfAborted();if(!allowed())throw new Error('background_indexing_paused');yield chunk;}signal.throwIfAborted();if(!allowed())throw new Error('background_indexing_paused');})()};
   }
   signal.throwIfAborted();if(!allowed())throw new Error('background_indexing_paused');
  };
  pending=index!.scan(guarded(),receipts)
   .catch(()=>{/* An interrupted scan keeps previously published rows. */})
   .finally(()=>{if(!closed&&allowed()){timer=setTimeout(run,options.intervalMs??60000);timer.unref();}});
 };
 run();
 return {get index(){return index;},async setEnabled(next:boolean){if(next===enabled){await pending;return;}enabled=next;if(!next){abort?.abort();if(timer)clearTimeout(timer);await pending;}else{await pending;if(!closed)run();}},async close(){closed=true;abort?.abort();if(timer)clearTimeout(timer);await pending;if(index){index.releaseOwner(token);index.close();}}};
}
