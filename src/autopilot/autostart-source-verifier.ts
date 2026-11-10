/** One bounded official-SDK tick on the existing owner cycle, without a scheduler. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir,hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
export function createAutostartSourceVerifierTick(options: {
  autopilotStateDir: string;
  env?: NodeJS.ProcessEnv;
  run?: typeof execute;
}): (() => Promise<void>) | undefined {
  const env=options.env ?? process.env;
  if (!env.NOTIFY_CENTER_EVENT_URL || !env.NOTIFY_CENTER_TOKEN) return undefined;
  // This bounded predicate must use the exact source stores; unsupported overrides fail closed.
  const expected=join(options.autopilotStateDir,'unfinished-sessions.json');
  const unsupported=env.AGENT_HERDER_UNFINISHED_SESSION_STORE && env.AGENT_HERDER_UNFINISHED_SESSION_STORE!==expected;
  // The helper bounds itself: it admits checks for at most 18 seconds and the
  // official SDK gives every request 8 seconds, so one tick cannot run for
  // more than about 26 seconds. This timeout stays above that bound on
  // purpose: a kill would leave the intent of the last submitted check in
  // the state of the verifier, and the next tick can then only reconcile it
  // against a receipt that never arrived - which silences the source for
  // good and lets the server expire its checks.
  const tickTimeoutMs=45_000;
  return async()=>{
    if(unsupported) throw new Error('source verifier requires the canonical unfinished store');
    const {stdout}=await (options.run ?? execute)('python3',[
      fileURLToPath(new URL('../../deploy/noticeplace/autostart_source_verifier.py',import.meta.url)),
      '--autopilot-state',options.autopilotStateDir,
      '--human-stop-store',env.AGENT_HERDER_HUMAN_STOP_STORE || join(homedir(),'.local/state/agent-herder/human-stops.json'),
      '--codex-root',env.CODEX_HOME || join(homedir(),'.codex'),
      '--host-id',hostname(),'--tick','--verifier-state',join(options.autopilotStateDir,'noticeplace-source-verifier'),
    ],{env,timeout:tickTimeoutMs,maxBuffer:64*1024});
    console.error(`[agent-herder] source verifier ${String(stdout).trim()}`);
  };
}
