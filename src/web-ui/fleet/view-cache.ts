import type {MeshAddress} from '../../mesh/protocol.js';
export interface ViewCacheSettings {hours:number;maxMiB:number}
export const defaultViewCacheSettings:ViewCacheSettings={hours:24,maxMiB:32};
const settingsKey='agent-herder.session-view-cache-settings.v1';
export function readViewCacheSettings(storage:Pick<Storage,'getItem'>):ViewCacheSettings {
 try{const r=JSON.parse(storage.getItem(settingsKey)??'null');if(r&&[0,24,72,168].includes(r.hours)&&[16,32,64].includes(r.maxMiB))return {hours:r.hours,maxMiB:r.maxMiB};}catch{}
 return {...defaultViewCacheSettings};
}
export function writeViewCacheSettings(storage:Pick<Storage,'setItem'>,s:ViewCacheSettings){storage.setItem(settingsKey,JSON.stringify(s));}
export interface CacheRow {key:string;scope:string;savedAt:number;accessedAt:number;bytes:number;json:string}
export type CacheIndex=Omit<CacheRow,'json'>;
export interface ViewCacheStore {read(key:string):Promise<CacheRow|undefined>;commit(row:CacheRow|undefined,settings:ViewCacheSettings,now:number):Promise<void>;clear():Promise<void>}
export function cacheRemovals(rows:CacheIndex[],settings:ViewCacheSettings,now:number):string[]{let bytes=0,count=0;return rows.sort((a,b)=>b.accessedAt-a.accessedAt).filter(r=>{if(!liveCacheRow(r,settings,now))return true;bytes+=r.bytes;return ++count>128||bytes>settings.maxMiB*1024*1024;}).map(r=>r.key);}
function liveCacheRow(row:CacheIndex,s:ViewCacheSettings,time:number){return s.hours>0&&Number.isFinite(row.savedAt)&&row.savedAt<=time&&time-row.savedAt<s.hours*3600000&&Number.isSafeInteger(row.bytes)&&row.bytes>0&&row.bytes<=1024*1024;}
export function indexedViewCacheStore():ViewCacheStore {
 let connection:Promise<IDBDatabase>|undefined;
 const db=()=>connection??=new Promise((resolve,reject)=>{const r=indexedDB.open('agent-herder-session-views',1);r.onupgradeneeded=()=>r.result.createObjectStore('views',{keyPath:'key'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('cache_blocked'));});
 return {
  read:async key=>{const connection=await db();return new Promise((resolve,reject)=>{const r=connection.transaction('views','readonly').objectStore('views').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});},
  commit:async(row,settings,now)=>{const connection=await db();return new Promise<void>((resolve,reject)=>{const t=connection.transaction('views','readwrite'),store=t.objectStore('views'),rows:CacheIndex[]=[];const cursor=store.openCursor();cursor.onsuccess=()=>{const c=cursor.result;if(c){const {key,scope,savedAt,accessedAt,bytes}=c.value;if(key!==row?.key)rows.push({key,scope,savedAt,accessedAt,bytes});c.continue();return;}if(row)rows.unshift(row);const remove=cacheRemovals(rows,settings,now);for(const key of remove)store.delete(key);if(row&&!remove.includes(row.key))store.put(row);};cursor.onerror=()=>{t.abort();};t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error);});},
  clear:async()=>{const connection=await db();return new Promise<void>((resolve,reject)=>{const t=connection.transaction('views','readwrite');t.objectStore('views').clear();t.oncomplete=()=>resolve();t.onerror=()=>reject(t.error);});}
 };
}
/** Read views only. No statuses/admission receipts are used to authorize a mutation. */
export class SessionViewCache {
 private chain:Promise<unknown>=Promise.resolve();
 constructor(private readonly store:ViewCacheStore,private readonly settings:()=>ViewCacheSettings,private readonly now=Date.now){}
 private key(scope:string,a:MeshAddress){return JSON.stringify([scope,a.hostId,a.harness,a.nativeSessionId]);}
 private run<T>(fn:()=>Promise<T>):Promise<T|undefined>{const p=this.chain.then(fn).catch(()=>undefined);this.chain=p;return p;}
 get<T>(scope:string,a:MeshAddress):Promise<{value:T;savedAt:number}|undefined>{return this.run(async()=>{const row=await this.store.read(this.key(scope,a));if(!row)return undefined;if(!liveCacheRow(row,this.settings(),this.now())||row.scope!==scope||row.bytes!==new TextEncoder().encode(row.json).length){await this.store.commit(undefined,this.settings(),this.now());return undefined;}return {value:JSON.parse(row.json) as T,savedAt:row.savedAt};});}
 put(scope:string,a:MeshAddress,value:unknown):Promise<unknown>{return this.run(async()=>{const json=JSON.stringify(value),bytes=new TextEncoder().encode(json).length;if(bytes>1024*1024||!this.settings().hours)return;const key=this.key(scope,a),time=this.now(),row={key,scope,json,bytes,savedAt:time,accessedAt:time};await this.store.commit(row,this.settings(),this.now());});}
 prune(){return this.run(async()=>this.store.commit(undefined,this.settings(),this.now()));}
 clear(){return this.run(()=>this.store.clear());}
}
