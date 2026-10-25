import { unwrapResult, type MeshAddress, type NativeReceipt } from "./protocol.js";

export type OwnerMeshCall=(request:{target:MeshAddress;sender:MeshAddress;inputId:string;message:string})=>Promise<unknown>;

/** A native peer is only a transport shim; the running Agent Herder owner owns the durable job and native receipt. */
export async function relayNativePeerDeliveryToOwner(
 request:{target:MeshAddress;sender:MeshAddress;inputId:string;message:string},
 call:OwnerMeshCall,
):Promise<NativeReceipt>{
 const unknown:NativeReceipt={state:"unknown",inputId:request.inputId,retryable:false,reason:"owner_mesh_delivery_outcome_unknown"};
 try{
  const receipt=unwrapResult(await call(request));
  if(receipt.inputId!==request.inputId||!["queued","admitted","not_attempted","unknown"].includes(String(receipt.state)))return unknown;
  if(receipt.state==="queued")return typeof receipt.jobId==="string"&&receipt.jobId?{state:"queued",inputId:request.inputId,jobId:receipt.jobId,retryable:false,reason:typeof receipt.reason==="string"?receipt.reason:"durable_job_pending"}:unknown;
  if(receipt.state==="admitted")return typeof receipt.turnId==="string"&&receipt.turnId?{state:"admitted",inputId:request.inputId,turnId:receipt.turnId,retryable:false}:unknown;
  if(receipt.state==="not_attempted")return {state:"not_attempted",inputId:request.inputId,retryable:receipt.retryable===true,...(typeof receipt.reason==="string"?{reason:receipt.reason}:{})};
  return unknown;
 }catch{return unknown;}
}
