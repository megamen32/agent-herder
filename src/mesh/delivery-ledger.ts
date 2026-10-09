import {createHash} from "node:crypto";
import {mkdir,readFile,rename,writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import lockfile from "proper-lockfile";
import {addressKey,type NativeReceipt} from "./protocol.js";
import type {MeshDelivery} from "./gptadmin.js";
type Receipt=NativeReceipt & {reason?:string};
type Entry={digest:string;at:number;pair:string;target:string;receipt:Receipt};
/** Native intent is persisted before transport; admitted/unknown receipts are never evicted. */
export class MeshDeliveryLedger {
 constructor(private readonly path:string,private readonly now:()=>number=Date.now){}
 async once(request:MeshDelivery,send:()=>Promise<Receipt>):Promise<Receipt>{
  const target=addressKey(request.target),pair=addressKey(request.sender)+">"+target;
  const key=createHash("sha256").update(target+"\0"+request.inputId).digest("hex");
  const digest=createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const rejection=(reason:string,retryable=true):Receipt=>({state:"not_attempted",inputId:request.inputId,retryable,reason});
  await mkdir(dirname(this.path),{recursive:true,mode:0o700});
  try{await writeFile(this.path,"{}",{flag:"wx",mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
  let release:()=>Promise<void>;
  try{release=await lockfile.lock(this.path,{realpath:false,stale:120000,retries:0});}catch{return rejection("mesh_admission_busy");}
  try{
   const entries=JSON.parse(await readFile(this.path,"utf8")) as Record<string,Entry>;
   if(!entries||typeof entries!=="object"||Array.isArray(entries))throw new Error("Invalid mesh receipt ledger");
   const prior=entries[key];if(prior)return prior.digest===digest?prior.receipt:rejection("input_id_conflict",false);
   const recent=Object.values(entries).filter(e=>this.now()-e.at<60000);
   if(recent.filter(e=>e.pair===pair).length>=6||recent.filter(e=>e.target===target).length>=12)return rejection("rate_limited");
   if(Object.keys(entries).length>=2048)return rejection("mesh_receipt_capacity");
   const uncertain:Receipt={state:"unknown",inputId:request.inputId,retryable:false};
   entries[key]={digest,at:this.now(),pair,target,receipt:uncertain};
   await this.persist(entries);
   let receipt:Receipt;
   try{receipt=await send();}catch{receipt=uncertain;}
   if(receipt.state==="not_attempted"&&receipt.retryable)delete entries[key];else entries[key]!.receipt=receipt;
   await this.persist(entries);
   return receipt;
  }finally{await release();}
 }
 private async persist(entries:Record<string,Entry>):Promise<void>{
  const temporary=`${this.path}.${process.pid}.tmp`;await writeFile(temporary,JSON.stringify(entries),{mode:0o600});await rename(temporary,this.path);
 }
}
