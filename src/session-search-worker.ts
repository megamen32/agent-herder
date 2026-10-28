import {isMainThread,parentPort,Worker,workerData} from 'node:worker_threads';
import {randomUUID} from 'node:crypto';
import {SessionSearchIndex} from './session-search.js';
import {startSessionSearchIndexer} from './session-search-indexer.js';
import {scanSessionSearchSources} from './session-search-sources.js';
import {backgroundIndexingSettings,BackgroundIndexingSettings} from './indexing-settings.js';

/** Native SQLite reads and parsing are synchronous; keep them off HTTP/MCP. */
export async function startSessionSearchBackground(options:{workerURL?:URL;path?:string;env?:NodeJS.ProcessEnv;settings?:BackgroundIndexingSettings}={}){
 const settings=options.settings??backgroundIndexingSettings();
 const ownerToken=randomUUID();
 const worker=new Worker(options.workerURL??new URL('./session-search-worker.js',import.meta.url),{workerData:{ownerToken,path:options.path,settingsPath:settings.path},env:options.env});
 let sequence=0,claimed=false;const acknowledgements=new Map<number,()=>void>();
 worker.on('message',message=>{if(message?.type==='indexing-claimed')claimed=true;if(message?.type==='indexing-applied'){acknowledgements.get(message.id)?.();acknowledgements.delete(message.id);}});
 const unsubscribe=settings.subscribe(enabled=>new Promise<void>(resolve=>{const id=++sequence;acknowledgements.set(id,resolve);worker.postMessage({type:'indexing',id,enabled});}));
 worker.unref();
 const exited=new Promise<void>(resolve=>worker.once('exit',()=>{
  unsubscribe();for(const settle of acknowledgements.values())settle();acknowledgements.clear();
  // Thread termination keeps this process alive; release only this thread's lease.
  if(claimed)try{const index=new SessionSearchIndex(options.path);try{index.releaseOwner(ownerToken);}finally{index.close();}}catch{/* A failed mirror remains unavailable to consumers. */}
  resolve();
 }));
 worker.on('error',()=>{/* Worker failure cannot terminate the user's HTTP owner. */});
 return {async close(){worker.postMessage('stop');const timer=setTimeout(()=>void worker.terminate(),1000);timer.unref();await exited;clearTimeout(timer);}};
}

if(!isMainThread){
 const settings=new BackgroundIndexingSettings(workerData.settingsPath);
 const owner=startSessionSearchIndexer(scanSessionSearchSources,{ownerToken:String(workerData.ownerToken),path:workerData.path,enabled:settings.get().enabled,isEnabled:()=>settings.get().enabled});
 parentPort?.on('message',async message=>{if(message==='stop'){await(await owner)?.close();parentPort?.close();}else if(message?.type==='indexing'){settings.reload();await(await owner)?.setEnabled(message.enabled===true);if((await owner)?.index)parentPort?.postMessage({type:'indexing-claimed'});parentPort?.postMessage({type:'indexing-applied',id:message.id});}});
 if((await owner)?.index)parentPort?.postMessage({type:'indexing-claimed'});
}
