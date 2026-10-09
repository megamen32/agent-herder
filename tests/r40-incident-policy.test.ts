import { describe, it, expect } from 'vitest';
import { validateAutomationLaunchPolicy } from '../src/automation-launch-policy.js';
import { normalizeHealthExecution, healthModelForHarness } from '../src/health-remediation.js';
const incidentExecution = {runtime:'opencode', provider:'minimax-coding-plan', model:'MiniMax-M3.1-Flash-Preview', reasoning:'default', topic:'health'};
const general = {version:1, allowedHarnesses:['codex'], preferredHarness:'codex', models:{codex:'gpt-6.1-sol'}};
describe('R40 incident subscription policy',()=>{
 it('persists a separate incident route while preserving general routes',()=>{
  expect(validateAutomationLaunchPolicy({...general,incidentExecution})).toEqual({...general,incidentExecution});
 });
 it('rejects OmniRoute and Codex for incident execution',()=>{
  for (const provider of ['omniroute','auto','openai-codex']) expect(()=>validateAutomationLaunchPolicy({...general,incidentExecution:{...incidentExecution,provider}})).toThrow();
 });
 it('maps OpenCode to exact native subscription model',()=>{
  const profile=normalizeHealthExecution(incidentExecution); expect(healthModelForHarness('opencode',profile)).toBe('minimax-coding-plan/MiniMax-M3.1-Flash-Preview');
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
