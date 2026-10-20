# Context economy

Agent Herder keeps full reports out of automatic prompt delivery when they exceed
1,200 characters. The recipient gets a short preview and one short resource
link. `read_message({messageId})` also accepts the short ID. Read the
complete original before acting on an incomplete preview; the preview grants no
authority. Follow `nextOffset` until it is null. Limits are characters (UTF-16
string offsets), not tokens. The maximum chunk is 8,000 characters.

Existing clients with a cached tool catalog can read the same bounded content
through the standard MCP resource `herder://messages/{messageId}/{offset}/{limit}`.
New previews contain one short resource link, `herder://m/<id>`; the ID is normally eight characters. Prefix collisions extend only that reference. Full digests remain private; old64-character references still work. The preview includes no duplicate hash or tool-call block. This needs no native session
restart and uses the same digest/integrity checks as `read_message`.

The immutable UTF-8 original is stored privately under
`~/.local/state/agent-herder/long-messages/` (or the service-owned
`AGENT_HERDER_LONG_MESSAGES_DIR`). Its private storage key is the SHA-256 of its exact bytes; the public reference is a collision-checked short prefix.
Writes finish before a reference is delivered; reads verify the digest. Short
bodies and explicitly human-requested messages remain inline. `send_message`,
`deliver` and automatic `new_or_resume` use the same compaction. Original input
IDs and delivery/no-replay guards remain authoritative. Stored reports survive
service restarts; they are not automatically expired with inbox acknowledgements.

Passive file-activity awareness uses a short ownership-change notice and the
existing `coordination_note_list({"cwd":"…"})` API. Read current ownership before
editing; use a `path` filter when relevant. Unchanged awareness is silent across
channels and time. Working ownership uses only board-scoped +N/-N counts; lookup instructions
live in MCP hints. Avoid/decision notes still carry material changes and
releases; immediate path-conflict responses remain visible. Full current notes
are available by `coordination_note_get` and existing MCP resources. TTL-only
heartbeat updates do not count as new information.

The hook reserves explicit write operands and patch targets. It does not scan
report text, JavaScript member expressions, URLs or quoted redirection symbols
as paths. Unsupported dynamic shell/Python writes cannot be inferred reliably:
use explicit declared ownership for those files. This is coordination evidence,
not a complete shell parser or enforcement of file writes.

## Reproduce the historical measurement

Run against a private native journal with compiled current modules:

```sh
node scripts/replay-context-economy.mjs \
  --transcript=/absolute/path/to/native-session.jsonl \
  --output=/private/replay-output \
  --modules=/absolute/path/to/compiled/modules \
  --cutoff=2026-10-20T18:59:55.264Z
```

The script needs local Python `tiktoken` for an `o200k_base` estimate; there are
no model calls and no historical actions are resent. It processes `response_item`
messages once, reconstructs visible peer snapshots through the real renderer,
and preserves original coordination/conflict blocks unchanged. Original note
identities, hidden/truncated paths, model decisions and current compacted state
cannot be reconstructed. Every report is reconstructed exactly from inline text
or the actual long-message store. Original service blocks remain in the private
replay artifact. Results distinguish initial prompt savings from the cost if all
long reports are subsequently read. This is a text-volume comparison, not a bill
or evidence of identical future model behavior.

`result.json` is safe to share after reviewing its source path; `source-blocks.json`
and the message files retain private original content and should stay private.

## Measured local replay

A fixed private historical snapshot contains117 incoming reports and446 passive
peer blocks. The current replay preserves every report exactly; its result
separates initial prompt volume from the cost if every long report is read.
See the task evidence for the measured revision and numbers. On-demand ownership
reads add tokens. No equivalent billed-cost savings or identical model decisions
are claimed. Raw transcripts are not included in the repository.

## Context Mode: use files rather than repeating message text

`save_message_to_file({"messageId":"…","cwd":"/absolute/workspace"})`
materializes the verified original inside that existing workspace under
`.agent-herder/messages/<id>.txt`. The response contains only the absolute
path, byte count and server host. Short-ID exports omit duplicate hashes and warnings; legacy full-ID exports keep their older metadata contract. It does not echo the report body.
Existing identical exports are reused; conflicting contents and symlink escapes
are refused. The directory/file permissions are 0700/0600.

Use the returned path with Context Mode on the **same host and filesystem**:

```js
ctx_execute_file({
  path: "/absolute/workspace/.agent-herder/messages/<id>.txt",
  language: "javascript",
  code: "const lines = FILE_CONTENT.split('\\n'); console.log(JSON.stringify({unknownLines: lines.filter(l => /UNKNOWN/.test(l)).length}));"
})
```

Only printed results enter the conversation. For repeated topical questions,
index the file once with `ctx_index({path, source: "herder:<messageId>"})`, then
retrieve relevant passages with `ctx_search({queries: ["…"], source: "…"})`.
Do not pass the entire report back as a `content` argument or print all
`FILE_CONTENT`: either defeats the purpose. Targeted extraction answers a
question; it does not establish that every instruction/limit in the original
has been read before execution.

Context Mode 1.0.169 confines `ctx_execute_file` to its project root. Export to
that actual project root, not the Herder private store or a different host's
path. Agent Herder uses Context Mode's existing interface; it does not require
it as a dependency, auto-index every report, install it, or change its runtime.

Current notification policy: ordinary messages remain complete. Long messages
use320 characters of semantic preview plus a26-character short link, normally
with an8-character collision-checked ID. Per-message SHA, JSON call, duplicate
fallback link, reading instructions and reply boilerplate are absent. Reading
rules live in compact MCP hints. The complete report remains exact and privately
verified. Full composed messages are bounded after adding ownership context;
original message text, rather than service metadata, supplies a capped preview.
