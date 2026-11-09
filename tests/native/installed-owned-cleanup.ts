/** Cleanup authority is limited to a native session admitted by this exact run. */
export interface OwnedCanaryBinding {
  runId: string; coreSessionRef: string; nativeId: string; harness: string; hostId: string; cwd: string;
  createReceiptId: string;
}
export interface OwnedCanaryState {
  nativeId: string; harness: string; hostId: string; cwd: string; observedAt: string;
  status: string; terminal: boolean; cancellation: 'supported' | 'unsupported';
  generation: string; raw: unknown;
}
export interface OwnedCleanupPort {
  read(): Promise<OwnedCanaryState>;
  hold(): Promise<void>;
  cancel(state: OwnedCanaryState): Promise<{accepted: boolean; raw: unknown}>;
  archive(): Promise<void>;
  record(kind: string, value: unknown): Promise<void>;
}
export async function cleanupOwnedCanary(
  binding: OwnedCanaryBinding, port: OwnedCleanupPort,
  options: {now?: () => number; sleep?: (ms: number) => Promise<void>; deadlineMs?: number} = {},
) {
  const reject = (code: string): never => {throw Object.assign(Error(code), {code});};
  const text = (value: unknown): value is string => typeof value === 'string' && value.trim() === value
    && value.length > 0 && value.length <= 2048 && !/[\x00-\x1f]/.test(value);
  if (!binding || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(binding.runId)
      || !text(binding.coreSessionRef) || !binding.coreSessionRef.startsWith('session:')
      || binding.coreSessionRef === 'session:' || !text(binding.nativeId) || binding.nativeId.startsWith('session:')
      || !['chatgpt', 'zai', 'opencode', 'codex', 'zcode'].includes(binding.harness)
      || !text(binding.hostId) || !text(binding.cwd) || !binding.cwd.startsWith('/')
      || !text(binding.createReceiptId)) reject('owned_cleanup_binding_missing');
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const timeout = options.deadlineMs ?? 45000;
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60000) reject('owned_cleanup_deadline_invalid');
  const read = async () => {
    const state = await port.read();
    const age = typeof state?.observedAt === 'string' ? now() - Date.parse(state.observedAt) : NaN;
    if (state?.nativeId !== binding.nativeId || state.harness !== binding.harness || state.hostId !== binding.hostId
        || state.cwd !== binding.cwd || !Number.isFinite(age) || age < -5000 || age > 15000
        || !text(state.generation) || state.raw == null
        || !['supported', 'unsupported'].includes(state.cancellation)
        || (state.terminal && !['idle', 'stopped', 'error'].includes(state.status))) reject('owned_cleanup_native_state_unproven');
    return state;
  };
  let state = await read();
  await port.record('state_before', state);
  if (!state.terminal) {
    // This hold prevents further automation; it is never cancellation evidence.
    await port.hold();
    state = await read();
    if (!state.terminal && state.cancellation === 'supported') {
      await port.record('cancel_intent', {binding, generation: state.generation, outcome: 'UNKNOWN'});
      try {
        const result = await port.cancel(state);
        await port.record('cancel_receipt', {accepted: result.accepted === true, raw: result.raw});
      } catch (error) {
        const receipt = error && typeof error === 'object' && 'receipt' in error ? (error as any).receipt : undefined;
        await port.record('cancel_unknown', {outcome: 'UNKNOWN', ...(receipt === undefined ? {} : {receipt})});
      }
      // One dispatch only, including UNKNOWN. Reconcile by a fresh native read.
    }
    const end = now() + timeout;
    while (!state.terminal && now() < end) {await sleep(500); state = await read();}
    if (!state.terminal) reject(state.cancellation === 'unsupported'
      ? 'owned_cleanup_cancel_unsupported_not_terminal' : 'owned_cleanup_terminal_unconfirmed_no_replay');
  }
  await port.record('terminal_state', state);
  await port.archive();
  return {terminal: true, archived: true};
}
