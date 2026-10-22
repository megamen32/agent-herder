import { describe, it, expect } from 'vitest';
import { validateAutomationLaunchPolicy } from '../src/automation-launch-policy.js';
import { normalizeHealthExecution, healthModelForHarness } from '../src/health-remediation.js';
const incidentExecution = {runtime:'opencode', provider:'omniroute', model:'minimax-combo-m3.1', reasoning:'default', topic:'health'};
const general = {version:1, allowedHarnesses:['codex'], preferredHarness:'codex', models:{codex:'gpt-6.1-sol'}};
describe('R40 incident OmniRoute combo policy',()=>{
 it('persists a separate incident route while preserving general routes',()=>{
  expect(validateAutomationLaunchPolicy({...general,incidentExecution})).toEqual({...general,incidentExecution});
 });
 it('rejects the paid subscription and Codex for incident execution',()=>{
  for (const provider of ['minimax-coding-plan','auto','openai-codex']) expect(()=>validateAutomationLaunchPolicy({...general,incidentExecution:{...incidentExecution,provider}})).toThrow();
 });
 it('maps OpenCode to exact native OmniRoute combo model',()=>{
  const profile=normalizeHealthExecution(incidentExecution); expect(healthModelForHarness('opencode',profile)).toBe('omniroute/minimax-combo-m3.1');
 });
 it('accepts a hand-typed free route of the incident model',()=>{
  for (const model of ['omniroute/glm-5.3-flash-minimax-m3.1','omniroute/any-provider/any-model','minimax-combo-m3.1']) {
   const saved=validateAutomationLaunchPolicy({...general,incidentExecution:{...incidentExecution,model}});
   expect(saved.incidentExecution?.model).toBe(model);
   expect(healthModelForHarness('opencode',saved.incidentExecution!)).toBe(model.includes('/')?model:`omniroute/${model}`);
  }
 });
 it('allows the paid subscription route through the gateway as the incident model',()=>{
  for (const model of ['omniroute/minimax-coding-plan/MiniMax-M3.1-Flash','omniroute/minimax/MiniMax-M3.1-Flash','minimax-coding-plan/MiniMax-M3.1-Flash']) {
   const saved=validateAutomationLaunchPolicy({...general,incidentExecution:{...incidentExecution,model}});
   expect(saved.incidentExecution?.model).toBe(model);
  }
  // A route of another provider stays refused: that is a substitution.
  for (const model of ['minimax/MiniMax-M3.1-Flash']) {
   expect(()=>validateAutomationLaunchPolicy({...general,incidentExecution:{...incidentExecution,model}})).toThrow();
  }
 });
 it('rejects a provider substitution and an unbounded incident model',()=>{
  expect(()=>validateAutomationLaunchPolicy({...general,incidentExecution:{...incidentExecution,model:'zai/GLM-4.6'}})).toThrow();
  expect(()=>validateAutomationLaunchPolicy({...general,incidentExecution:{...incidentExecution,model:'x'.repeat(257)}})).toThrow();
  expect(()=>validateAutomationLaunchPolicy({...general,incidentExecution:{...incidentExecution,model:'bad\nmodel'}})).toThrow();
 });
});

import { AutomationLaunchPolicyStore } from '../src/automation-launch-policy.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('reads back incident choice from durable policy after restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'r40-policy-'));
 try { const path=join(root,'policy.json'); await new AutomationLaunchPolicyStore(path).replace({...general,incidentExecution});
 expect(await new AutomationLaunchPolicyStore(path).load()).toEqual({kind:'valid',policy:{...general,incidentExecution}});
 } finally {await rm(root,{recursive:true,force:true});}
});
