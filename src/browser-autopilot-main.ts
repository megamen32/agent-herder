#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireV1BrowserAutopilotLease, createV1BrowserAutopilotRuntime, readProtectedBrowserAutopilotJson, validateV1BrowserAutopilotConfig } from "./automation/v1-browser-runtime.js";
import { ZAI_AUTOPILOT_MODELS } from "./autopilot/zai-failover.js";

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const positional=args.filter(arg=>!arg.startsWith("--"));
  if(positional.length!==1 || args.some(arg=>arg.startsWith("--") && arg!=="--check" && arg!=="--once"))
    throw new Error("browser_autopilot_usage_config_path_check_or_once");
  const config=validateV1BrowserAutopilotConfig(await readProtectedBrowserAutopilotJson(resolve(positional[0]!)));
  const summary={enabled:config.enabled,profiles:config.profiles.map(profile=>({label:profile.label,instanceRef:profile.instanceRef,sessions:profile.sessionRefs.length})),
    models:[...ZAI_AUTOPILOT_MODELS],transport:config.zai.transport??"api",contextBytes:config.zai.contextBytes??128*1024,pollIntervalMs:config.pollIntervalMs??60_000};
  if(args.includes("--check") || !config.enabled){
    process.stdout.write(JSON.stringify({status:args.includes("--check")?"configuration_checked":"disabled",...summary})+"\n");
    return;
  }
  let leaseLost=false,onLeaseLost=()=>{leaseLost=true;};
  const release=await acquireV1BrowserAutopilotLease(config.statePath,()=>onLeaseLost());
  let runtime:Awaited<ReturnType<typeof createV1BrowserAutopilotRuntime>>;
  try {runtime=await createV1BrowserAutopilotRuntime(config);}
  catch(error){await release();throw error;}
  let closing=false,timer:ReturnType<typeof setInterval>|undefined;
  const close=async()=>{
    if(closing)return;closing=true;
    if(timer)clearInterval(timer);
    try {await runtime.close();} finally {await release();}
  };
  onLeaseLost=()=>{leaseLost=true;process.exitCode=1;void close().catch(()=>undefined);};
  if(leaseLost){await close();throw new Error("browser_autopilot_lease_lost");}
  process.once("SIGTERM",()=>{void close().catch(()=>{process.exitCode=1;});});
  process.once("SIGINT",()=>{void close().catch(()=>{process.exitCode=1;});});
  try {
    await runtime.service.tick();
    if(args.includes("--once")){
      await runtime.service.settle();
      await close();
      process.stdout.write(JSON.stringify({status:"cycle_settled",...summary})+"\n");
      return;
    }
    if(closing)return;
    let polling=false;
    timer=setInterval(()=>{
      if(closing||polling)return;
      polling=true;
      void Promise.resolve(runtime.service.tick()).catch(()=>{
        process.stderr.write(JSON.stringify({event:"browser_autopilot_tick_unavailable"})+"\n");
      }).finally(()=>{polling=false;});
    },config.pollIntervalMs??60_000);
    process.stdout.write(JSON.stringify({status:"running",...summary})+"\n");
  } catch(error) {await close();throw error;}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  void main().catch(error=>{
    const code=error instanceof Error && /^browser_autopilot_[a-z_]+$/u.test(error.message)?error.message:"browser_autopilot_startup_failed";
    process.stderr.write(JSON.stringify({error:code})+"\n");process.exitCode=1;
  });
}
