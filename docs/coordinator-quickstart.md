# Coordinate two workers over MCP

Connect an ordinary MCP client to the owning Herder. The example uses the MCP SDK's `Client` as `client`. It needs two supported native workers, a human message from the Herder composer or an accepted goal or amendment in the source session, and a configured Notice question producer. A coordinator with no native caller metadata supplies its own registered session explicitly for human answers and timed wakes.

```js
async function call(name, args) {
  const reply = await client.callTool({name, arguments: args});
  if (reply.isError) throw new Error(JSON.stringify(reply.content));
  return reply.structuredContent ?? JSON.parse(reply.content[0].text);
}

const project = "release-47";
const source = {harness:"codex", sessionId:"<coordinator thread>", cwd:"/work/release"};
const owner = {harness:source.harness, sessionId:source.sessionId};
const {messages} = await call("human_messages", source);
// Select the actual instruction you intend to delegate. Keep its stable identifier.
const humanCitations = [{...source, eventId:messages[0].eventId}];
const {latestSequence:baseline} = await call("event_list", {limit:1});
async function start(name, message) {
  const result = await call("deliver", {project, harness:"codex", name,
    cwd:source.cwd, inputId:project+"-start-"+name, message, humanCitations});
  if (!result.ok || !result.sessionId) throw new Error(JSON.stringify(result));
  return {harness:"codex", sessionId:result.sessionId};
}
const a = await start("implementation", "Implement the approved change.");
const b = await start("review", "Independently review the change.");
const sent = await call("send_message", {...a, inputId:project+"-follow",
  mode:"steer", awaitMs:30000, message:"Report your current findings.", humanCitations});
if (sent.response?.status === "pending") {
  // responseFetchUri is the input-bound result resource for this send.
  // The operation can still be running. Observe without delivering again.
  await call("session_await", {sessionIds:[a.sessionId], afterSequence:sent.cursor,
    includeMessages:true, timeoutMs:45000});
}

// Checkpoint the cursor after handling each event. Starting before dispatch
// also catches workers that finish before the first call to session_await.
let cursor = baseline;
for (;;) {
  const next = await call("session_await", {sessionIds:[b.sessionId],
    afterSequence:cursor, includeMessages:true, timeoutMs:45000});
  if (next.truncated) throw new Error("Replay window expired. Read worker status and history.");
  if (next.message) await call("session_info", {...b, view:"digest", limit:5});
  cursor = next.cursor;
  if (next.completion) {
    if (next.completion.outcome !== "completed") throw new Error(JSON.stringify(next.completion));
    break;
  }
}
await call("worker", {action:"update", project, ...b, state:"review-ready",
  prs:["https://github.com/example/project/pull/47"]});
const roster = await call("worker", {action:"list", project});
const card = await call("human_request", {action:"create", kind:"user", ...source,
  message:"Which revision should we ship?", decisionRequestKey:project+"-ship",
  choices:[{choiceId:"reviewed",label:"Reviewed revision"},{choiceId:"hold",label:"Hold"}],
  recommendedChoiceId:"reviewed"});
// The human taps the Notice card. The existing completion callback resumes
// owner with the canonical answer reference. In that resumed session:
const {answer} = await call("human_request", {action:"get", requestId:card.request.requestId, includeAnswer:true});

await call("resume_after", {action:"wait", owner, requestId:project+"-recheck",
  trigger:{kind:"delay", delayMs:600000}, message:"Recheck both workers."});
// For an absolute wake use trigger:{kind:"at",at:"2026-12-01T12:00:00Z"}.
const memory = await call("project_memory", {action:"read", project});
const saved = await call("project_memory", {action:"write", project,
  ifMatch:memory.revision, text:"Both workers reviewed."});
if (!saved.ok) throw new Error("Reread the document before merging concurrent edits.");
const conflict = await call("project_memory", {action:"write",project,
  ifMatch:memory.revision,text:"This stale update must fail."});
if (conflict.error !== "revision_conflict") throw new Error("Expected stale-write rejection");
for (const target of [a,b]) await call("worker", {action:"resolve",project,...target});
```

### Worker messages, receipts and lifecycle

- The citation envelope carries the coordinator's instructions and a separate array of human messages. Each entry includes its source, event ID, original text, author role and receipt time. A worker can pass the entire JSON envelope to `human_messages({envelope})` to verify it. For a compacted message, read the full referenced message first. A human role in an arbitrary native transcript cannot establish human authorship. Herder reads accepted goal events and human inputs from its owner web composer.
- To page recent exchanges call `session_info({...a,view:"digest",limit:10})`, then pass the returned `conversation.beforeMessageId` to get the previous page. For complete native exports use `view:"transcript"`, `limit:50`, then pass `conversation.nextCursor` as `cursor` on each subsequent call. Entries have 240-character previews by default. Add `fullText:true` for the complete text.
- Acknowledge an actual message ID with `message_reaction({project,...a,messageId,ack:{actor:owner.sessionId,reaction:"👍"}})`. Omit `ack` to read acknowledgements. Rename with `rename({target:a,title:"Completed implementation"})`. Reopen with `worker({action:"reopen",project,...a})`. Resolve and reopen change the assignment record. Native stop and resume remain explicit actions.
- The native Codex status URL is `/api/sessions/codex/<encoded-id>/status?includeMessages=1`. For any adapter publishing message-resource updates, long-poll `event_list({uriPrefix:"herder://sessions/"+a.harness+"/"+encodeURIComponent(a.sessionId)+"/messages",afterSequence:cursor,timeoutMs:45000})`. Advance by the last processed sequence. Availability depends on the native adapter's observations.

### Watch a URL or batch updates for the human

An operator configures comma-separated HTTP(S) origins in `AGENT_HERDER_WATCH_ORIGINS`. The watcher reads up to 1 MiB and follows no redirects. A URL must be readable by the server-side watcher. For cookie-protected Herder status use the authenticated MCP feed or a watcher with the owner's existing web access.

```js
const url = "https://status.example.org/build/47";
let {revision} = await call("watch_url", {url});
for (;;) {
  const observation = await call("watch_url", {url,revision,timeoutMs:45000});
  revision = observation.revision;
  if (observation.changed) break;
}
await call("project_digest", {action:"presence",project,quietMs:60000});
await call("project_digest", {action:"queue",project,id:"build",text:"Build passed."});
await call("project_digest", {action:"queue",project,id:"review",text:"Review finished."});
const batch = {action:"flush",project,batchId:"release-47-first",send:true};
const digest = await call("project_digest", batch);
if (digest.held) await call("resume_after",{action:"wait",owner,
  requestId:project+"-digest-"+digest.quietUntil,
  trigger:{kind:"at",at:new Date(digest.quietUntil).toISOString()},
  message:"Retry this digest after the quiet period: "+JSON.stringify(batch)});
```

Report presence on human activity to extend the quiet period. Flush uses the configured Notice event producer. After a lost response, repeat the same batch ID to recover the same body and provider idempotency key. Use a new batch ID for later updates.

Run the isolated acceptance with `node_modules/.bin/vitest run tests/coordinator-toolkit.test.ts`. The two workers, human answer and notification endpoints are test fixtures.
