import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexDeliveryReceipts } from "../src/adapters/codex-delivery-receipts.js";

describe("Codex delivery anti-replay retention (fast unit; expected2s/max20s)", () => {
  it.each([false, true])("does not evict old accepted/uncertain receipt (uncertain=%s)", async unknown => {
        const root = await mkdtemp(join(tmpdir(), "codex-permanent-receipt-"));
    try {
      const key = createHash("sha256").update("owned\0stable-input").digest("hex");
      const result = unknown ? { ok: false, admissionUnknown: true, nonRetryable: true }
        : { ok: true, admitted: true, turnId: "accepted-turn", inputId: "stable-input" };
      await writeFile(join(root, "herder-delivery-receipts.json"), JSON.stringify({
        [key]: { at: Date.now() - 3 * 86400_000, result },
      }), { mode: 0o600 });
      const dispatch = vi.fn();
      expect(await new CodexDeliveryReceipts(root).once("owned", "stable-input", dispatch)).toEqual(result);
      expect(dispatch).not.toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects new admission at finite capacity without deleting or dispatching", async () => {
        const root = await mkdtemp(join(tmpdir(), "codex-full-receipts-"));
    try {
      const records = Object.fromEntries(Array.from({ length: 2048 }, (_, index) => [
        String(index), { at: Date.now() - 3 * 86400_000, result: { ok: false, admissionUnknown: true, nonRetryable: true } },
      ]));
      const key=createHash('sha256').update('owned\0new-input').digest('hex');
      const folder=join(root,'herder-delivery-receipts.json.buckets');await mkdir(folder);
      const path = join(folder,key.slice(0,2)+'.json');
      await writeFile(path, JSON.stringify(records), { mode: 0o600 });
      const before = await readFile(path, "utf8"), dispatch = vi.fn();
      expect(await new CodexDeliveryReceipts(root).once("owned", "new-input", dispatch))
        .toMatchObject({ ok: false, nonRetryable: true });
      expect(dispatch).not.toHaveBeenCalled();
      expect(await readFile(path, "utf8")).toBe(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('a full legacy journal permits a new input while retaining all old receipts and reconnect deduplication',async()=>{
    const root=await mkdtemp(join(tmpdir(),'codex-full-legacy-'));
    try{
      const oldKey=createHash('sha256').update('old\0accepted').digest('hex');
      const oldResult={ok:true,admitted:true,turnId:'old-turn'};
      const records:Record<string,{at:number;result:Record<string,unknown>}>=Object.fromEntries(Array.from({length:2047},(_,i)=>[String(i),{at:1,result:{ok:false,admissionUnknown:true,nonRetryable:true}}]));
      records[oldKey]={at:1,result:oldResult};
      const file=join(root,'herder-delivery-receipts.json');await writeFile(file,JSON.stringify(records));const before=await readFile(file,'utf8');
      const dispatch=vi.fn(async()=>({ok:true,admitted:true,turnId:'new-turn'}));
      expect(await new CodexDeliveryReceipts(root).once('owned','new',dispatch)).toMatchObject({ok:true,turnId:'new-turn'});
      expect(await new CodexDeliveryReceipts(root).once('owned','new',dispatch)).toMatchObject({ok:true,turnId:'new-turn'});
      expect(await new CodexDeliveryReceipts(root).once('old','accepted',dispatch)).toEqual(oldResult);
      expect(dispatch).toHaveBeenCalledTimes(1);expect(await readFile(file,'utf8')).toBe(before);
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it.each(['legacy','bucket'])('malformed matching %s receipt refuses before dispatch and remains unchanged',async location=>{
    const root=await mkdtemp(join(tmpdir(),'codex-malformed-receipt-'));
    try{
      const key=createHash('sha256').update('owned\0malformed').digest('hex');
      const dir=join(root,'herder-delivery-receipts.json.buckets');await mkdir(dir);
      const file=location==='legacy'?join(root,'herder-delivery-receipts.json'):join(dir,key.slice(0,2)+'.json');
      const bytes=JSON.stringify({[key]:{at:1,...(location==='bucket'?{result:null}:{})}});await writeFile(file,bytes);
      const dispatch=vi.fn();await expect(new CodexDeliveryReceipts(root).once('owned','malformed',dispatch)).rejects.toThrow('requires review');
      expect(dispatch).not.toHaveBeenCalled();expect(await readFile(file,'utf8')).toBe(bytes);
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it('a lost operation result stays UNKNOWN across reconnects in its bucket',async()=>{
    const root=await mkdtemp(join(tmpdir(),'codex-bucket-unknown-'));
    try{
      const dispatch=vi.fn(async()=>{throw new Error('socket lost')});
      expect(await new CodexDeliveryReceipts(root).once('owned','lost',dispatch)).toMatchObject({admissionUnknown:true,nonRetryable:true});
      expect(await new CodexDeliveryReceipts(root).once('owned','lost',dispatch)).toMatchObject({admissionUnknown:true,nonRetryable:true});expect(dispatch).toHaveBeenCalledTimes(1);
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it('aggregate receipt bytes stay bounded without evicting existing evidence or dispatching',async()=>{
    const root=await mkdtemp(join(tmpdir(),'codex-bucket-budget-'));
    try{
      const folder=join(root,'herder-delivery-receipts.json.buckets');await mkdir(folder);
      const buffer=Buffer.alloc(512*1024);for(let i=0;i<32;i++)await writeFile(join(folder,i.toString(16).padStart(2,'0')+'.json'),buffer);
      const dispatch=vi.fn();const key=createHash('sha256').update('owned\0quota').digest('hex');
      // Its own bucket remains a valid empty journal; another known file supplies
      // the replaced bytes so total still exactly16MiB.
      const own=join(folder,key.slice(0,2)+'.json');await writeFile(own,'{}');
      if(parseInt(key.slice(0,2),16)<32)await writeFile(join(folder,'ff.json'),Buffer.alloc(512*1024-2));
      expect(await new CodexDeliveryReceipts(root).once('owned','quota',dispatch)).toMatchObject({ok:false,nonRetryable:true});expect(dispatch).not.toHaveBeenCalled();
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
