/** Exact completed canary turns, never a census of another native controller. */
export function validateCodexCanaryProof(
  proof: any,
  expected: {nativeId: string; cwd: string; hostId: string; pairs: Array<{prompt: string; token: string}>; now: number},
  digest: (text: string) => string,
) {
  // This function is also serialized into the private native-reader child.
  // Keep it self-contained and free of transport, environment and file effects.
  const reject = (): never => {throw Error('codex_canary_completion_unproven');};
  const text = (value: any) => typeof value === 'string' && value.trim() === value && value.length > 0 && !/[\x00-\x1f]/.test(value);
  const fresh = (value: any) => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && expected.now - Date.parse(value) >= -5000 && expected.now - Date.parse(value) <= 30000;
  if (!proof || proof.capability !== 'registered-canary-completed-turns'
      || proof.source !== 'codex-native-thread-read-completion' || proof.native_session_id !== expected.nativeId
      || !text(expected.cwd) || proof.cwd !== expected.cwd || proof.canonical_status !== 'idle'
      || !fresh(proof.observed_at) || !Array.isArray(expected.pairs) || expected.pairs.length !== 2
      || new Set(expected.pairs.map(pair => pair.prompt)).size !== 2
      || new Set(expected.pairs.map(pair => pair.token)).size !== 2) reject();
  const completion = proof.canonical_completion_receipt, session = completion?.session;
  if (!session || session.id !== expected.nativeId || session.harness !== 'codex'
      || session.cwd !== expected.cwd || session.hostId !== expected.hostId || session.status !== 'idle'
      || typeof completion.transcriptTail !== 'string' || completion.transcriptTail.length > 120000
      || !/^[a-f0-9]{64}$/.test(completion.fingerprint) || completion.fingerprint !== proof.fingerprint
      || digest(completion.transcriptTail) !== proof.canonical_transcript_sha256) reject();
  let turns: any;
  try {turns = JSON.parse(completion.transcriptTail);} catch {reject();}
  if (!Array.isArray(turns) || turns.length < 2 || !Array.isArray(proof.completed_turn_ids)
      || proof.completed_turn_ids.length !== 2 || new Set(proof.completed_turn_ids).size !== 2
      || !proof.completed_turn_ids.every(text) || proof.latest_turn_id !== proof.completed_turn_ids[1]
      || completion.turnId !== proof.latest_turn_id || turns.at(-1)?.id !== proof.latest_turn_id
      || new Set(turns.map(turn => turn?.id)).size !== turns.length) reject();
  const passive = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan', 'webSearch', 'imageView',
    'enteredReviewMode', 'exitedReviewMode', 'contextCompaction']);
  const stateful = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabToolCall']);
  for (const turn of turns) {
    if (!text(turn?.id) || turn.status !== 'completed' || turn.error !== null || !Array.isArray(turn.items)) reject();
    for (const item of turn.items) {
      if (!text(item?.id) || !text(item.type)) reject();
      if (stateful.has(item.type)) {
        if (item.status !== 'completed' || item.error != null || item.success === false
            || (item.type === 'commandExecution' && item.exitCode !== 0)) reject();
      } else if (!passive.has(item.type)) reject();
    }
  }
  const messages = proof.native_messages_receipt;
  if (!Array.isArray(messages)) reject();
  const messageText = (message: any) => typeof message?.text === 'string' ? message.text : message?.content;
  for (const [index, pair] of expected.pairs.entries()) {
    const turnId = proof.completed_turn_ids[index];
    const user = messages.filter((message: any) => message?.role === 'user' && messageText(message) === pair.prompt);
    const assistant = messages.filter((message: any) => message?.role === 'assistant' && messageText(message) === pair.token);
    if (user.length !== 1 || assistant.length !== 1 || user[0].turnId !== turnId || assistant[0].turnId !== turnId) reject();
    const canonical = turns.filter((turn: any) => turn.id === turnId);
    if (canonical.length !== 1) reject();
    const items = canonical[0].items;
    const users = items.filter((item: any) => item.type === 'userMessage');
    const final = items.at(-1);
    if (users.length !== 1 || items[0] !== users[0] || !Array.isArray(users[0].content)
        || users[0].content.some((item: any) => item?.type !== 'text' || typeof item.text !== 'string')
        || users[0].content.map((item: any) => item.text).join('\n') !== pair.prompt
        || final?.type !== 'agentMessage' || final.phase !== 'final_answer' || final.text !== pair.token) reject();
  }
  if (turns.findIndex((turn: any) => turn.id === proof.completed_turn_ids[0])
      >= turns.findIndex((turn: any) => turn.id === proof.completed_turn_ids[1])) reject();
  return proof;
}
