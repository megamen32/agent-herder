import type { ProjectLaunchDispatcher, ProjectLaunchDispatchResult } from './project-launch-dispatch.js';
import { NOTICEPLACE_HEALTH_AUTHORIZED, NOTICEPLACE_HEALTH_PURPOSE } from './noticeplace-health-launch.js';

/** Exact provider-qualified route required for NoticePlace incident repair. */
export const NOTICEPLACE_V1_MODEL = 'minimax-coding-plan/MiniMax-M3.1-Flash';

/** Original NoticePlace identity is carried intact to the existing durable launch seam. */
export type NoticePlaceV1Launch = {
  incidentId: string;
  project: string;
  cwd: string;
  message: string;
  operationId: string;
  model: typeof NOTICEPLACE_V1_MODEL;
  incidentSessionPolicy?: { enabled: boolean; ttlSeconds: number };
};

export type NoticePlaceV1Receipt = {
  incidentId: string;
  operationId: string;
  purpose: typeof NOTICEPLACE_HEALTH_PURPOSE;
  result: ProjectLaunchDispatchResult;
  state: 'accepted' | 'unknown' | 'stopped' | 'rejected';
};

/**
 * Consumer seam for the existing policy/incident router and named-session
 * execution path. Rust remains the authority for its create/deliver decisions;
 * this adapter preserves NoticePlace's identities and returns its durable
 * launch receipt without inventing retries or a parallel scheduler.
 */
export function createNoticePlaceV1LaunchAdapter(dispatch: ProjectLaunchDispatcher) {
  return async (input: NoticePlaceV1Launch): Promise<NoticePlaceV1Receipt> => {
    if (!input.incidentId.trim() || !input.operationId.trim()
      || !input.project.trim() || !input.cwd.trim() || !input.message.trim()) {
      throw new Error('NoticePlace launch requires the original incident, operation, project, cwd and message');
    }
    const result = await dispatch({
      [NOTICEPLACE_HEALTH_AUTHORIZED]: true,
      project: input.project,
      cwd: input.cwd,
      message: input.message,
      operationId: input.operationId,
      harness: 'opencode',
      model: input.model,
      mode: 'sync',
      incidentSessionPolicy: input.incidentSessionPolicy,
    } as Parameters<ProjectLaunchDispatcher>[0] & { incidentSessionPolicy?: NoticePlaceV1Launch['incidentSessionPolicy'] });
    const state = result.outcome === 'accepted' ? 'accepted'
      : result.outcome === 'admission_unknown' || result.outcome === 'in_flight' ? 'unknown'
        : result.outcome === 'human_hold' ? 'stopped' : 'rejected';
    return { incidentId: input.incidentId, operationId: input.operationId, purpose: NOTICEPLACE_HEALTH_PURPOSE, result, state };
  };
}
