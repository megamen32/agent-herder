import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { CodexAdapter } from "../src/adapters/codex.js";

const roots:string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p,{recursive:true,force:true}))); });
it("rejects a native index path outside the adapter storage", async () => {
  const root=await mkdtemp(join(tmpdir(),"codex-storage-")); const outside=await mkdtemp(join(tmpdir(),"codex-outside-")); roots.push(root,outside);
  await mkdir(join(root,"sessions")); const path=join(outside,"rollout-test.jsonl"); await writeFile(path,'{"type":"session_meta","payload":{"id":"test"}}\n');
  const db=new DatabaseSync(join(root,"state_5.sqlite")); db.exec('create table threads (id text, rollout_path text, cwd text, model text, preview text, updated_at_ms integer, thread_source text, agent_role text, is_pinned integer)');
  db.prepare('insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('test',path,outside,null,null,Date.now(),null,null,0); db.close();
  expect(await new CodexAdapter({codexDir:root}).getRawTranscript('test')).toBeNull();
});
