import {parentPort} from 'node:worker_threads';
import {computeAgentActivityStatistics} from './session-statistics.js';

if(!parentPort)throw new Error('session statistics worker requires parentPort');
parentPort.once('message',async(input:{days:number;sessionRoot:string;includeArchived?:boolean})=>{
 try{parentPort!.postMessage({ok:true,value:await computeAgentActivityStatistics(input.days,input.sessionRoot,value=>parentPort!.postMessage({progress:value}),input.includeArchived)});}
 catch(error){parentPort!.postMessage({ok:false,error:error instanceof Error?error.message:String(error)});}
});
