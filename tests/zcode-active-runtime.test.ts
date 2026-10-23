import { expect, it } from "vitest";
import { readZcodeActiveCandidates, zcodeStoredTailCanBeActive } from "../src/adapters/zcode-active.js";
import type { AgentSession } from "../src/types/index.js";
const candidate={id:"task",harness:"zcode",cwd:"/workspace",status:"running",needsPermission:false,title:"Task",lastActivity:new Date().toISOString()} as AgentSession;
const observation={sessionId:"task",observedAt:new Date().toISOString(),available:true,loadedSessionCoverage:"unknown",queuedInputCount:null,admittedNotStartedCount:null,idleProof:false} as const;
it("does not promote terminal tasks from fresh historical assistant tool tails",()=>{
  for(const status of ["completed","error","aborted","cancelled","stopped"])expect(zcodeStoredTailCanBeActive(status)).toBe(false);
  expect(zcodeStoredTailCanBeActive("running")).toBe(true);
});
it("native completed candidate is absent; a current native active turn or permission is active",async()=>{
  expect(await readZcodeActiveCandidates([candidate],async()=>({...observation,pendingRequestCount:0}))).toEqual([]);
  expect(await readZcodeActiveCandidates([candidate],async()=>({...observation,activeTurnId:"new-turn",pendingRequestCount:0}))).toMatchObject([{status:"running",meta:{activeTurnId:"new-turn"}}]);
  expect(await readZcodeActiveCandidates([candidate],async()=>({...observation,pendingRequestCount:1}))).toMatchObject([{status:"needs_input",needsPermission:true}]);
});
it("unavailable existing transport never fabricates idle",async()=>{
  await expect(readZcodeActiveCandidates([candidate],async()=>({...observation,available:false,reason:"existing_transport_or_runtime_unavailable"}))).rejects.toThrow("native_unavailable");
});

it("completed native task with an old failed turn and fresh tool tail stays terminal until a newer lifecycle start",async()=>{
  const {mkdtemp,rm}=await import("node:fs/promises");
  const {tmpdir}=await import("node:os");const {join}=await import("node:path");
  const {DatabaseSync}=await import("node:sqlite");
  const {ZcodeAdapter}=await import("../src/adapters/zcode.js");
  const {markLifecycleEvent}=await import("../src/session-lifecycle.js");
  const root=await mkdtemp(join(tmpdir(),"zcode-active-terminal-"));
  const tasksPath=join(root,"tasks.sqlite"),nativePath=join(root,"native.sqlite"),now=Date.now(),id="terminal-native-"+now;
  const tasks=new DatabaseSync(tasksPath);
  tasks.exec("create table tasks(task_id text, workspace_path text, title text,task_status text,model text,created_at integer,updated_at integer,deleted integer,archived integer)");
  tasks.prepare("insert into tasks values(?,?,?,?,?,?,?,?,?)").run(id,root,"Completed","completed",null,now-10000,now-1000,0,0);tasks.close();
  const native=new DatabaseSync(nativePath);
  native.exec("create table session(id text,directory text,parent_id text,time_updated integer);create table turn_usage(session_id text,turn_id text,status text,started_at integer,completed_at integer,user_message_id text,cancelled_by_user integer);create table message(id text,session_id text,data text,sequence integer,time_updated integer);create table session_input(session_id text,status text,time_created integer)");
  native.prepare("insert into session values(?,?,?,?)").run(id,root,null,now-1000);
  native.prepare("insert into turn_usage values(?,?,?,?,?,?,?)").run(id,"old-failed-turn","error",now-10000,now-9000,"user",0);
  native.prepare("insert into message values(?,?,?,?,?)").run("user",id,JSON.stringify({role:"user"}),1,now-10000);
  native.prepare("insert into message values(?,?,?,?,?)").run("tool-tail",id,JSON.stringify({role:"assistant",parentID:"user",finish:"tool-calls"}),2,now-1000);
  native.prepare("insert into session_input values(?,?,?)").run(id,"promoted",now-10000);native.close();
  const client={start:async()=>{throw new Error("native activation forbidden")},call:async()=>{throw new Error("native activation forbidden")},close:async()=>{}};
  try{
    const adapter=new ZcodeAdapter({client,tasksIndexDbPath:tasksPath,localDbPath:nativePath});
    expect((await adapter.listSessions()).find(s=>s.id===id)?.status).toBe("stopped");
    markLifecycleEvent("zcode",id,"turn-start",root);
    expect((await adapter.listSessions()).find(s=>s.id===id)?.status).toBe("running");
    markLifecycleEvent("zcode",id,"turn-end",root);
    expect((await adapter.listSessions()).find(s=>s.id===id)?.status).toBe("idle");
  }finally{await rm(root,{recursive:true,force:true})}
});

it.skipIf(!process.env.ZCODE_ACTIVE_PROBE)("reads the exact formerly false-busy task through the real persisted adapter",async()=>{
 const {ZcodeAdapter}=await import("../src/adapters/zcode.js");
 const {writeFile}=await import("node:fs/promises");
 const adapter=new ZcodeAdapter({client:{start:async()=>{throw new Error("activation forbidden")},call:async()=>{throw new Error("activation forbidden")},close:async()=>{}},tasksIndexDbPath:process.env.HOME+"/.zcode/v2/tasks-index.sqlite",localDbPath:process.env.HOME+"/.zcode/cli/db/db.sqlite"});
 const sessions=await adapter.listSessions();
 const session=sessions.find(s=>s.id==="session_b38b92e45be8939782ee5863251407b4");
 expect(session).toBeDefined();
 await writeFile("/tmp/zcode-active-native-proof-20261023.json",JSON.stringify({observedAt:new Date().toISOString(),id:session?.id,status:session?.status,persistedTaskStatus:session?.meta?.persistedTaskStatus,nativeLastTurn:session?.meta?.nativeLastTurn,receipt:adapter.getSessionSnapshotReceipt()},null,2));
 expect(session?.status).not.toBe("running");
});
