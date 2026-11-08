import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchProjectLaunch, ProjectLaunchAttemptLog } from '../src/automation/project-launch-dispatch.js';
import { NOTICEPLACE_HEALTH_AUTHORIZED, validateNoticeplaceHealthLaunch } from '../src/automation/noticeplace-health-launch.js';
import { NOTICEPLACE_V1_MODEL } from '../src/automation/v1-noticeplace-launch.js';

let directory='';
afterEach(async()=>{if(directory)await rm(directory,{recursive:true,force:true});});
describe('installed NoticePlace health route pin',()=>{
  it('passes the exact requested subscription route through real dispatcher validation',async()=>{
    expect(validateNoticeplaceHealthLaunch({harness:'opencode',model:NOTICEPLACE_V1_MODEL,operationId:'np-op-1'})).toBeUndefined();
    directory=await mkdtemp(join(tmpdir(),'noticeplace-route-'));
    const policy={version:1 as const,allowedHarnesses:['opencode' as const],preferredHarness:'opencode' as const,models:{opencode:NOTICEPLACE_V1_MODEL},projectRoutes:{'/srv/infra':{harnesses:['opencode' as const],models:{opencode:NOTICEPLACE_V1_MODEL}}}};
    const runner=vi.fn(async request=>({ok:true,created:true,harness:'opencode',name:'noticeplace',cwd:request.cwd,sessionId:'native-session',inputId:request.inputId,delivery:'accepted' as const,model:request.model}));
    const result=await dispatchProjectLaunch({[NOTICEPLACE_HEALTH_AUTHORIZED]:true,policy,project:'/srv/infra',cwd:'/srv/infra',message:'repair',operationId:'np-op-1',harness:'opencode',model:NOTICEPLACE_V1_MODEL,mode:'sync'},new ProjectLaunchAttemptLog(join(directory,'attempts.json')),runner);
    expect(result.outcome).toBe('accepted');
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0]?.[0].model).toBe('minimax-coding-plan/MiniMax-M3.1-Flash');
  });
});
