import { describe, expect, it, vi } from 'vitest';
import { createNoticePlaceV1LaunchAdapter, NOTICEPLACE_V1_MODEL, type NoticePlaceV1Launch } from '../src/automation/v1-noticeplace-launch.js';
import { NOTICEPLACE_HEALTH_AUTHORIZED, NOTICEPLACE_HEALTH_PURPOSE } from '../src/automation/noticeplace-health-launch.js';
import type { ProjectLaunchDispatchResult } from '../src/automation/project-launch-dispatch.js';
import { immutableNoticePlaceReleaseRoot } from '../deploy/fleet/noticeplace-release-path.mjs';

const input: NoticePlaceV1Launch = {
  incidentId: 'inc_exact-17', project: 'ServersAdministartion', cwd: '/srv/infra',
  message: '{"id":"inc_exact-17","project":"ServersAdministartion","host_id":"server-100","source_id":"np","signal_type":"service"}\nrepair this incident',
  operationId: 'operation-exact-17', model: NOTICEPLACE_V1_MODEL,
};

function receipt(outcome: ProjectLaunchDispatchResult['outcome']): ProjectLaunchDispatchResult {
  return { operationId: input.operationId, project: input.project, attempts: [], outcome, routingReason: 'fixture', selectedHarness: 'opencode', model: NOTICEPLACE_V1_MODEL };
}

describe('NoticePlace V1 launch consumer seam', () => {
  it('resolves one immutable SHA bundle and rejects mutable dist launch paths', () => {
    const immutable='file:///opt/agent-herder/releases/0123456789abcdef0123456789abcdef01234567/deploy/fleet/launch-v1-noticeplace.mjs';
    expect(immutableNoticePlaceReleaseRoot(immutable)).toBe('/opt/agent-herder/releases/0123456789abcdef0123456789abcdef01234567');
    expect(() => immutableNoticePlaceReleaseRoot('file:///opt/agent-herder/deploy/fleet/launch-v1-noticeplace.mjs')).toThrow('noticeplace_launcher_must_run_from_immutable_release');
  });
  it('preserves exact launch identity, capability, provider route and duplicate key', async () => {
    const dispatch = vi.fn(async () => receipt('accepted'));
    const launch = createNoticePlaceV1LaunchAdapter(dispatch as never);
    const first = await launch(input);
    const duplicate = await launch(input);
    expect(dispatch).toHaveBeenCalledTimes(2); // Existing dispatcher owns durable coalescing.
    for (const [request] of dispatch.mock.calls) {
      expect(request.project).toBe(input.project);
      expect(request.cwd).toBe(input.cwd);
      expect(request.message).toBe(input.message);
      expect(request.operationId).toBe(input.operationId);
      expect(request.model).toBe('minimax-coding-plan/MiniMax-M3.1-Flash');
      expect(request.harness).toBe('opencode');
      expect(request[NOTICEPLACE_HEALTH_AUTHORIZED]).toBe(true);
    }
    expect(first).toMatchObject({ incidentId: input.incidentId, operationId: input.operationId, purpose: NOTICEPLACE_HEALTH_PURPOSE, state: 'accepted' });
    expect(duplicate.operationId).toBe(first.operationId);
  });

  it.each([
    ['admission_unknown', 'unknown'], ['in_flight', 'unknown'], ['human_hold', 'stopped'], ['no_harness', 'rejected'],
  ] as const)('keeps %s as %s without retrying elsewhere', async (outcome, state) => {
    const dispatch = vi.fn(async () => receipt(outcome));
    const result = await createNoticePlaceV1LaunchAdapter(dispatch as never)(input);
    expect(result.state).toBe(state);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0].model).toBe(NOTICEPLACE_V1_MODEL);
  });

  it('rejects incomplete incident identity before touching the consumer', async () => {
    const dispatch = vi.fn();
    await expect(createNoticePlaceV1LaunchAdapter(dispatch as never)({ ...input, incidentId: '' })).rejects.toThrow(/original incident/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('preserves opaque incident IDs without imposing an inc_ prefix', async () => {
    const dispatch = vi.fn(async () => receipt('accepted'));
    const result = await createNoticePlaceV1LaunchAdapter(dispatch as never)({ ...input, incidentId: 'ticket-42' });
    expect(result.incidentId).toBe('ticket-42');
  });
});
