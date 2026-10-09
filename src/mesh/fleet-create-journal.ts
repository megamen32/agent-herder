import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import lockfile from 'proper-lockfile';
import type {FleetScope,FleetCreateRequest,FleetCreateReceipt} from './fleet-contract.js';
type Entry={digest:string;receipt:FleetCreateReceipt};
/** Scope+stable input identity is intent identity, never a fabricated native session ID. */
export class FleetCreateJournal {
 constructor(private readonly path:string,private readonly scope:FleetScope){this.scope=Object.freeze({...scope});}
 async once(request:FleetCreateRequest,operation:()=>Promise<FleetCreateReceipt>):Promise<FleetCreateReceipt>{
  const key=createHash('sha256').update(JSON.stringify([this.scope.profileId,this.scope.userId,request.hostId,request.inputId])).digest('hex');
  const digest=createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const reject=(reason:string,retryable:boolean):FleetCreateReceipt=>({state:'not_attempted',inputId:request.inputId,retryable,reason});
  await mkdir(dirname(this.path),{recursive:true,mode:0o700});
  try{await writeFile(this.path,'{}',{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  let release:()=>Promise<void>;try{release=await lockfile.lock(this.path,{realpath:false,stale:120000,retries:0});}catch{return reject('fleet_create_busy',true);}
  try{
   const entries=JSON.parse(await readFile(this.path,'utf8')) as Record<string,Entry>;
   if(!entries||typeof entries!=='object'||Array.isArray(entries))throw new Error('Invalid fleet journal');
   const previous=entries[key];if(previous)return previous.digest===digest?previous.receipt:reject('input_id_conflict',false);
   if(Object.keys(entries).length>=2048)return reject('fleet_intent_capacity',true);
   const unknown:FleetCreateReceipt={state:'unknown',inputId:request.inputId,retryable:false};
   entries[key]={digest,receipt:unknown};await this.persist(entries);
   let receipt:FleetCreateReceipt;try{receipt=await operation();}catch{receipt=unknown;}
   if(receipt.state==='not_attempted'&&receipt.retryable)delete entries[key];else entries[key]!.receipt=receipt;
   await this.persist(entries);return receipt;
  }finally{await release();}
 }
 private async persist(entries:Record<string,Entry>){const tmp=`${this.path}.${process.pid}.tmp`;await writeFile(tmp,JSON.stringify(entries),{mode:0o600});await rename(tmp,this.path);}
}
