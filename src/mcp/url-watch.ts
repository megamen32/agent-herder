import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { structuredResult } from "./results.js";

/** Watch configured services without granting arbitrary network access to an MCP client. */
export function registerUrlWatch(server: McpServer) {
  server.registerTool("watch_url", {
    description:"Read a configured URL revision or wait up to 50 seconds for it to change. Resume with the returned revision.",
    inputSchema:z.object({url:z.url(),revision:z.string().regex(/^[a-f0-9]{64}$/).optional(),timeoutMs:z.number().int().min(0).max(50000).default(45000)}),
  },async (args,ctx)=>{
    const url=new URL(args.url);
    const allowed=(process.env.AGENT_HERDER_WATCH_ORIGINS??"").split(",").map(origin=>origin.trim());
    if(!["http:","https:"].includes(url.protocol) || url.username || url.password || !allowed.includes(url.origin))
      throw new Error("URL origin must be configured in AGENT_HERDER_WATCH_ORIGINS");
    const deadline=Date.now()+args.timeoutMs;
    let revision=args.revision;
    do {
      const remaining=Math.max(1,deadline-Date.now());
      const signal=AbortSignal.any([ctx.mcpReq.signal,AbortSignal.timeout(args.timeoutMs===0?5000:Math.min(remaining,5000))]);
      try {
        const response=await fetch(url,{signal,redirect:"error"});
        if(!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error("Watch read failed: HTTP "+response.status);
        }
        const hash=createHash("sha256").update(url.href).update("\0");
        let size=0;
        for await(const chunk of response.body as unknown as AsyncIterable<Uint8Array>){
          size+=chunk.byteLength;
          if(size>1048576) throw new Error("Watched resource exceeds 1 MiB");
          hash.update(chunk);
        }
        revision=hash.digest("hex");
      } catch(error) {
        if(args.revision && !ctx.mcpReq.signal.aborted && signal.aborted && Date.now()>=deadline) break;
        throw error;
      }
      if(revision!==args.revision || Date.now()>=deadline) break;
      await delay(Math.min(1000,deadline-Date.now()),undefined,{signal:ctx.mcpReq.signal});
    } while(Date.now()<deadline);
    return structuredResult({revision,changed:args.revision!==undefined && revision!==args.revision});
  });
}
