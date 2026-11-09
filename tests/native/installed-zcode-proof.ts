/** Validate only the pinned official server and this run's complete native chat. */
export function validateZcodeCanaryProof(
  proof: any,
  expected: {nativeId: string; cwd: string; hostId: string; createModel: string; pairs: Array<{prompt: string; token: string}>; now: number},
  digest: (value: string) => string,
) {
  // Serialized into the protected reader child; no imported closure or effects.
  const reject = (): never => {throw Error('zcode_official_canary_unproven');};
  const text = (v: any) => typeof v === 'string' && v.length > 0 && v.trim() === v && !/[\x00-\x1f]/.test(v);
  const fresh = (v: any) => typeof v === 'string' && Number.isFinite(Date.parse(v))
    && expected.now - Date.parse(v) >= -5000 && expected.now - Date.parse(v) <= 15000;
  if (!proof || proof.capability !== 'official-server-canary'
      || proof.source !== 'zcode-native-session-read+official-supervisor'
      || proof.native_session_id !== expected.nativeId || proof.cwd !== expected.cwd
      || !text(expected.cwd) || !expected.cwd.startsWith('/') || proof.host_id !== expected.hostId
      || !fresh(proof.observed_at) || !Array.isArray(expected.pairs) || expected.pairs.length !== 2
      || new Set(expected.pairs.map(pair => pair.prompt)).size !== 2
      || new Set(expected.pairs.map(pair => pair.token)).size !== 2) reject();
  const before = proof.official_before, after = proof.official_after;
  const model = typeof expected.createModel === 'string' && text(expected.createModel)
    ? /^([^/\s$]+)\/([^/\s$]+)\$([^/\s$]+)$/.exec(expected.createModel) : null;
  if (!model || proof.create_model !== expected.createModel) reject();
  for (const snapshot of [before, after]) {
    if (!snapshot || !Number.isSafeInteger(snapshot.pid) || snapshot.pid < 1
        || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0
        || !fresh(snapshot.observedAt) || typeof snapshot.expiresAt !== 'string' || !Number.isFinite(Date.parse(snapshot.expiresAt))
        || Date.parse(snapshot.expiresAt) <= expected.now || (Date.parse(snapshot.expiresAt) - Date.parse(snapshot.observedAt) <= 0 || Date.parse(snapshot.expiresAt) - Date.parse(snapshot.observedAt) > 16000) || !Array.isArray(snapshot.tasks)
        || snapshot.tasks.some((task: any) => !text(task?.sessionId) || !text(task.workspacePath) || !task.workspacePath.startsWith('/'))
        || new Set(snapshot.tasks.map((task: any) => task.sessionId)).size !== snapshot.tasks.length
        || snapshot.tasks.some((task: any) => task.sessionId === expected.nativeId)) reject();
  }
  if (before.pid !== after.pid || before.generation !== after.generation
      || proof.official_pid !== after.pid || proof.official_generation !== after.generation) reject();
  const receipt = proof.native_transcript_receipt;
  if (!receipt || receipt.complete !== true || receipt.source?.kind !== 'native-api'
      || receipt.source?.location !== 'zcode app-server session/read' || receipt.source?.format !== 'json'
      || receipt.timestampCoverage !== 'native' || typeof receipt.text !== 'string'
      || receipt.text.length > 1048576 || digest(receipt.text) !== proof.native_transcript_sha256) reject();
  let raw: any;
  try {raw = JSON.parse(receipt.text);} catch {reject();}
  const session = raw?.session, projection = raw?.projection, runtime = raw?.runtime;
  const selected = raw?.settings?.model?.current;
  const canonical = session?.status === 'completed' ? 'stopped' : session?.status === 'idle' ? 'idle' : undefined;
  if (!canonical || proof.canonical_status !== canonical || session.sessionId !== expected.nativeId
      || session.workspace?.workspacePath !== expected.cwd || session.workspace?.workspaceIdentity !== expected.cwd
      || session.model?.providerId !== model[1] || session.model?.modelId !== model[2]
      || selected?.providerId !== model[1] || selected?.modelId !== model[2] || selected?.options?.reasoningLevel !== model[3]
      || projection?.sessionId !== expected.nativeId || !['completed', 'idle'].includes(projection.status)
      // Native session/read omits lastError after a successful turn.
      || projection.lastError != null || !Number.isSafeInteger(runtime?.eventSeq) || runtime.eventSeq < 0
      || !Number.isSafeInteger(runtime.stateRevision) || runtime.stateRevision < 0
      || !Array.isArray(raw.messages)) reject();
  for (const rows of [projection.pendingPermissions, projection.activeToolCalls, projection.backgroundJobs, runtime.pendingRequestIds])
    if (!Array.isArray(rows) || rows.length !== 0) reject();
  const ids = proof.completed_message_ids, users = proof.user_message_ids;
  if (!Array.isArray(ids) || ids.length !== 2 || !ids.every(text) || new Set(ids).size !== 2
      || !Array.isArray(users) || users.length !== 2 || !users.every(text) || new Set(users).size !== 2) reject();
  const messageText = (m: any) => Array.isArray(m.parts)
    ? m.parts.filter((part: any) => part?.type === 'text').map((part: any) => typeof part.text === 'string' ? part.text : '').join('') : '';
  let previousAssistant = -1;
  for (const [index, pair] of expected.pairs.entries()) {
    const user = raw.messages.filter((m: any) => m.info?.role === 'user' && m.info?.synthetic !== true && messageText(m) === pair.prompt);
    const assistant = raw.messages.filter((m: any) => m.info?.role === 'assistant'
      && m.info?.semantics?.origin === 'agent_runtime' && m.info?.semantics?.kind === 'assistant_response'
      && messageText(m) === pair.token);
    if (user.length !== 1 || assistant.length !== 1) reject();
    const u = user[0].info, a = assistant[0].info;
    if (u.sessionId !== expected.nativeId || a.sessionId !== expected.nativeId
        || u.messageId !== users[index] || a.messageId !== ids[index] || a.parentMessageId !== u.messageId
        || !['stop', 'completed'].includes(a.finish) || a.error != null
        || !Number.isFinite(a.time?.created) || !Number.isFinite(a.time?.completed)
        || a.time.completed < a.time.created || a.time.completed > expected.now + 5000) reject();
    const ui = raw.messages.indexOf(user[0]), ai = raw.messages.indexOf(assistant[0]);
    if (ui <= previousAssistant || ai <= ui) reject();
    previousAssistant = ai;
  }
  return proof;
}
