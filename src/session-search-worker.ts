import {isMainThread,parentPort,Worker,workerData} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {SessionSearchIndex} from './session-search.js';
import {startSessionSearchIndexer} from './session-search-indexer.js';
import {scanSessionSearchSources} from './session-search-sources.js';

/** Native SQLite reads and parsing are synchronous; keep them off HTTP/MCP. */
export async function startSessionSearchBackground(options:{workerURL?:URL;path?:string;env?:NodeJS.ProcessEnv}={}){
 const ownerToken=randomUUID();
 const worker=new Worker(options.workerURL??new URL('./session-search-worker.js',import.meta.url),{workerData:{ownerToken,path:options.path},env:options.env});
 worker.unref();
 const exited=new Promise<void>(resolve=>worker.once('exit',()=>{
  // Thread termination keeps this process alive; release only this thread's lease.
  try{const index=new SessionSearchIndex(options.path);try{index.releaseOwner(ownerToken);}finally{index.close();}}catch{/* A failed mirror remains unavailable to consumers. */}
  resolve();
 }));
 worker.on('error',()=>{/* Worker failure cannot terminate the user's HTTP owner. */});
 return {async close(){worker.postMessage('stop');const timer=setTimeout(()=>void worker.terminate(),1000);timer.unref();await exited;clearTimeout(timer);}};
}

if(!isMainThread){
 const owner=startSessionSearchIndexer(scanSessionSearchSources,{ownerToken:String(workerData.ownerToken),path:workerData.path});
 parentPort?.on('message',async message=>{if(message==='stop'){await(await owner)?.close();parentPort?.close();}});
 await owner;
}
