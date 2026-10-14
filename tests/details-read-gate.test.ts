// Fast unit: slow native history must survive a stream of refresh events.
// Expected .1s, emergency 2s per case.
import {expect,it} from 'vitest';
import {DetailsReadGate} from '../src/web-ui/details-read-gate.js';
it('accepts the pending history after repeated background refreshes',async()=>{
 const gate=new DetailsReadGate();
 const first=gate.begin('zcode:original',true)!;
 let release!:()=>void;const response=new Promise<void>(r=>release=r);
 let shown=false;const read=response.then(()=>{shown=gate.isCurrent(first);gate.finish(first);});
 for(let i=0;i<100;i++)expect(gate.begin('zcode:original',false)).toBeUndefined();
 release();await read;expect(shown).toBe(true);
 const next=gate.begin('zcode:original',false)!;expect(next).toBeDefined();
 expect(gate.isCurrent(first)).toBe(false);expect(gate.isCurrent(next)).toBe(true);
});
it('does not apply an old session or clear a newer pending read',()=>{
 const gate=new DetailsReadGate(),old=gate.begin('zcode:old',true)!,current=gate.begin('zcode:new',true)!;
 gate.finish(old);expect(gate.isCurrent(old)).toBe(false);expect(gate.isCurrent(current)).toBe(true);
 expect(gate.begin('zcode:new',false)).toBeUndefined();
 gate.invalidate();expect(gate.isCurrent(current)).toBe(false);expect(gate.begin('zcode:new',false)).toBeDefined();
});
it('lets an explicit reload supersede a pending read of the same session',()=>{
 const gate=new DetailsReadGate(),old=gate.begin('zcode:one',true)!,current=gate.begin('zcode:one',true)!;
 expect(gate.isCurrent(old)).toBe(false);expect(gate.isCurrent(current)).toBe(true);
});
