import { localSessionHostId } from '../types/index.js';
/** Read one exact V2 session and its current controller; never enumerate history. */
export async function readMinimaxNativeSession(control, id) {
    const result = await control.getSession(id);
    if (result.status === 404)
        return null;
    if (!result.ok)
        throw Error('minimax_native_session_unavailable');
    const body = result.body;
    const row = body?.session;
    if (!row || row.session_id !== id)
        throw Error('minimax_native_session_identity_mismatch');
    const current = await control.call('GET', `/session/${encodeURIComponent(id)}/turn-continuation`);
    const state = current.body?.state;
    if (!current.ok || ![0, 1, 2, 3].includes(state))
        throw Error('minimax_native_current_turn_unavailable');
    const observedAt = new Date().toISOString(), status = state === 2 ? 'running' : 'idle';
    const updated = typeof row.updated_at === 'number' ? row.updated_at : typeof row.created_at === 'number' ? row.created_at : Date.now();
    return { id, harness: 'minimax-code', hostId: localSessionHostId(), cwd: typeof row.workspace_dir === 'string' ? row.workspace_dir : '', title: typeof row.title === 'string' ? row.title : id, status, lastActivity: new Date(updated).toISOString(), needsPermission: state === 3, model: row.model?.model_id,
        meta: { activityEvidence: 'native_active_turn', activityObservedAt: observedAt, activityExpiresAt: new Date(Date.now() + 15000).toISOString(), nativeContinuationState: state, nativeStatusType: row.status?.status_type, ...(typeof row.parent_session_id === 'string' ? { parentSessionId: row.parent_session_id } : {}) } };
}
