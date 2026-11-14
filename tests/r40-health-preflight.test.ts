import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from '../src/web/server.js';
import type { HarnessAdapter } from '../src/types/index.js';
import { dispatchProjectLaunch, ProjectLaunchAttemptLog } from '../src/automation/project-launch-dispatch.js';

const direct = {
  runtime: 'opencode' as const,
  provider: 'minimax-coding-plan' as const,
  model: 'MiniMax-M3.1-Flash',
  reasoning: 'default' as const,
  topic: 'health' as const,
};

it('admits the selected subscription profile and refuses a model the policy denies before creating a session', async () => {
  let creates = 0;
  const adapter = {
    type: 'opencode', name: 'OpenCode',
    async init() {}, async listSessions() { return []; }, async listModels() { return ['omniroute/auto/minimax']; },
    async createSession() { creates++; throw new Error('must not create'); },
  } as unknown as HarnessAdapter;
  const directory = await mkdtemp(join(tmpdir(), 'r40-preflight-'));
  const policy = {
    version: 1 as const,
    allowedHarnesses: ['opencode' as const],
    preferredHarness: 'opencode' as const,
    models: { opencode: 'vendor/general' },
    incidentExecution: direct,
    projectRoutes: {
      '/tmp': {
        harnesses: ['opencode' as const],
        models: { opencode: 'minimax-coding-plan/MiniMax-M3.1-Flash' },
        deniedModels: ['*gpt*', '*claude*', '*codex*', '*anthropic*'],
      },
    },
  };
  const log = new ProjectLaunchAttemptLog(join(directory, 'attempts.json'));
  const run = async (request: { model?: string }) => {
    creates++;
    return { ok: true, created: true, harness: 'opencode' as const, name: 'test', cwd: '/tmp', model: request.model, sessionId: 'fixture', delivery: 'accepted' as const };
  };
  const store = { load: async () => ({ kind: 'valid' as const, policy }) };
  const server = createWebServer({
    adapters: new Map([['opencode', adapter]]),
    converter: { async convert() { throw new Error('unused'); } },
    sessionObservationManagedExternally: true,
    automationLaunchPolicyStore: store as never,
    projectLaunchDispatch: request => dispatchProjectLaunch({ ...request, policy }, log, run),
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const addr = server.address(); if (!addr || typeof addr === 'string') throw Error('bind');
    const post = (model?: string) => fetch(`http://127.0.0.1:${addr.port}/api/health/remediation`, {
      method: 'POST',
      body: JSON.stringify({
        incident_id: 'r40-preflight', plan_id: 'repair', harness: 'opencode', name: 'r40', cwd: '/tmp',
        message: 'Read only.', execution: direct, ...(model ? { model } : {}),
      }),
    });
    // The selected subscription profile runs on the route of the project.
    const admitted = await post();
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toMatchObject({ model: 'minimax-coding-plan/MiniMax-M3.1-Flash' });
    expect(creates).toBe(1);
    // A model the policy denies is refused before any native execution, and
    // no other provider takes its place.
    const refused = await post('omniroute/cx/gpt-6-luna');
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toContain('Другие модели не допускаются');
    expect(creates).toBe(1);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
    await rm(directory, { recursive: true, force: true });
  }
});
