import {randomUUID} from 'node:crypto';
import {SessionSearchIndex,type SearchSessionInput,type SearchSourceReceipt} from './session-search.js';

export type SessionSearchScanner=(options:{signal?:AbortSignal;onStatus?:(status:SearchSourceReceipt)=>void})=>AsyncIterable<SearchSessionInput>;
/** Only the persistent owner scans. MCP and API searches never invoke this. */
export async function startSessionSearchIndexer(scanner:SessionSearchScanner,options:{path?:string;intervalMs?:number;ownerToken?:string}={}){
 const index=new SessionSearchIndex(options.path),token=options.ownerToken??randomUUID();
 if(!index.claimOwner(token)){index.close();return undefined;}
 index.pruneInterruptedGenerations();
 const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let closed=false;
 let pending:Promise<void>=Promise.resolve();
 const run=()=>{
  const receipts:SearchSourceReceipt[]=[];
  pending=index.scan(scanner({signal:abort.signal,onStatus:receipt=>receipts.push(receipt)}),receipts)
   .catch(()=>{/* Durable search_run holds the failure; search stays explicitly partial. */})
   .finally(()=>{if(!closed){timer=setTimeout(run,options.intervalMs??60000);timer.unref();}});
 };
 run();
 return {index,async close(){closed=true;abort.abort();if(timer)clearTimeout(timer);await pending;index.releaseOwner(token);index.close();}};
}
