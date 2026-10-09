import {hostname,platform} from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {readFile} from "node:fs/promises";
const exec=promisify(execFile);
export type SingletonOwnerPin={hostId:string;pid:number;entry:string;startTicks:string};
/** Slice deliberately supports only the independently verified server-100 owner.
 * A loopback endpoint or MCP server name is never native host evidence. */
export function validateOwnerEvidence(pin:SingletonOwnerPin,evidence:{hostId:string;platform:string;listenerPid:number;listenerName:string;entry:string;startTicks:string;listenerAddress:string;requestedAddress:string}):void{
 const addressMatches=evidence.listenerAddress===evidence.requestedAddress||evidence.listenerAddress===evidence.requestedAddress.replace(/^127\.0\.0\.1:/,"0.0.0.0:");
 if(pin.hostId!=="roomhacker-server-100"||evidence.hostId!==pin.hostId||evidence.platform!=="linux"||evidence.listenerPid!==pin.pid||evidence.listenerName!=="node"||evidence.entry!==pin.entry||evidence.startTicks!==pin.startTicks||!addressMatches)throw new Error("singleton_native_owner_identity_unverified");
}
export async function verifySingletonOwner(pin:SingletonOwnerPin,url:URL):Promise<void>{
 if(hostname()!==pin.hostId||platform()!=="linux"||pin.hostId!=="roomhacker-server-100")throw new Error("singleton_native_owner_identity_unverified");
 if(url.hostname!=="127.0.0.1"||url.protocol!=="http:"||!Number.isInteger(pin.pid)||pin.pid<1||!pin.entry||!pin.startTicks)throw new Error("singleton_owner_pin_missing");
 const port=url.port||"80";if(!/^\d+$/.test(port))throw new Error("singleton_owner_port_invalid");
 const requestedAddress=`127.0.0.1:${port}`;
 const {stdout}=await exec("ss",["-H","-4","-lntp",`sport = :${port}`],{timeout:1500,maxBuffer:65536});
 const listener=stdout.split("\n").find(line=>line.includes(`pid=${pin.pid},`)&&[requestedAddress,`0.0.0.0:${port}`].includes(line.trim().split(/\s+/)[3]||""));
 const command=(await readFile(`/proc/${pin.pid}/cmdline`,"utf8")).split("\0");
 const stat=await readFile(`/proc/${pin.pid}/stat`,"utf8"),fields=stat.slice(stat.lastIndexOf(")")+2).split(" ");
 validateOwnerEvidence(pin,{hostId:hostname(),platform:platform(),listenerPid:listener?pin.pid:0,listenerName:listener?.includes('"node"')?"node":"unknown",entry:command[1]||"",startTicks:fields[19]||"",requestedAddress,listenerAddress:listener?.trim().split(/\s+/)[3]||""});
}
