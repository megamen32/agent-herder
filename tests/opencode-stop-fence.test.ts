import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionSupervisor} from '../src/session-supervisor.js';
import {HumanStopStore} from '../src/human-stop-store.js';
import type {HarnessAdapter} from '../src/types/index.js';

it.each(['cancelTurn','stopSession'] as const)('persists OpenCode %s fence before native cancellation',async action=>{
 const root=await mkdtemp(join(tmpdir(),'opencode-stop-fence-'));
 try {
  const path=join(root,'stops.json'),store=new HumanStopStore(path);
  let calls=0;
  const nativeStop=async()=>{expect(await new HumanStopStore(path).isHeld('opencode','own')).toBe(true);calls++;return {ok:true};};
  const adapter={type:'opencode',name:'fixture',getSession:async()=>null,stopSession:nativeStop,cancelTurn:nativeStop} as unknown as HarnessAdapter;
  const supervisor=new SessionSupervisor(new Map([['opencode',adapter]]),{} as any,undefined,{humanStopStore:store});
  await expect(supervisor[action]('opencode','own')).resolves.toEqual({ok:true});
  expect(calls).toBe(1);
  expect(await new HumanStopStore(path).isHeld('opencode','own')).toBe(true);
  const restarted=new SessionSupervisor(new Map([['opencode',adapter]]),{} as any,undefined,{humanStopStore:new HumanStopStore(path)});
  expect(await restarted.isAutomationHeld('opencode','own')).toBe(true);
  expect(await restarted.releaseHumanStop('opencode','own')).toBe(true);
  expect(await restarted.isAutomationHeld('opencode','own')).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});
