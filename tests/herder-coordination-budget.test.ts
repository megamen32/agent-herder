import { describe, expect, it, vi } from 'vitest';
import { CoordinationDeliveryBudget } from '../src/coordination-delivery-budget.js';
// Unit; catches agent ACK loops and duplicate payload amplification; <1s/max5s.
describe('agent exchange budget',()=>{
 it('coalesces a stable input and rejects changed content under the same ID',async()=>{
  const budget=new CoordinationDeliveryBudget();const send=vi.fn(async()=> 'accepted');
  const input={target:'codex:t',sender:'zcode:s',inputId:'one',message:'decision'};
  expect(await Promise.all([budget.run(input,send),budget.run(input,send)])).toEqual(['accepted','accepted']);
  expect(send).toHaveBeenCalledTimes(1);
  expect(await budget.run({...input,message:'different'},send)).toContain('input_id_conflict');
 });
 it('bounds a pair and target without creating a backlog and recovers after the window',async()=>{
  let now=0;const budget=new CoordinationDeliveryBudget(()=>now);const send=vi.fn(async()=> 'accepted');
  for(let i=0;i<6;i++)expect(await budget.run({target:'t',sender:'s',inputId:String(i),message:String(i)},send)).toBe('accepted');
  expect(await budget.run({target:'t',sender:'s',inputId:'seventh',message:'seventh'},send)).toContain('rate_limited');
  expect(send).toHaveBeenCalledTimes(6);
  now=60001;
  expect(await budget.run({target:'t',sender:'s',inputId:'seventh',message:'seventh'},send)).toBe('accepted');
 });
 it('does not replay an unknown result after a disconnect',async()=>{
  const budget=new CoordinationDeliveryBudget();const send=vi.fn(async()=>{throw Error('transport lost')});
  const input={target:'t',sender:'s',inputId:'unknown',message:'work'};
  expect(await budget.run(input,send)).toContain('admission_unknown');
  expect(await budget.run(input,send)).toContain('admission_unknown');
  expect(send).toHaveBeenCalledTimes(1);
 });
});

it('preserves intentional identical messages with different explicit IDs',async()=>{
 const b=new CoordinationDeliveryBudget();const send=vi.fn(async()=> 'accepted');
 await b.run({target:'t',sender:'s',inputId:'first',message:'same'},send);
 await b.run({target:'t',sender:'s',inputId:'second',message:'same'},send);
 expect(send).toHaveBeenCalledTimes(2);
});

it('permits a proven pre-admission failure to be retried with the original ID',async()=>{const b=new CoordinationDeliveryBudget();const input={target:'t',sender:'s',inputId:'one',message:'decision'};expect(await b.run(input,async()=> 'Failed to send message: ZCode Agent runtime is not running.')).toContain('Failed');const send=vi.fn(async()=> 'accepted');expect(await b.run(input,send)).toBe('accepted');expect(send).toHaveBeenCalledTimes(1)});
