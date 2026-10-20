# Integrator transcript paging

`src/integrator-transcript.ts` pages a supported native JSONL export through
the existing `HarnessAdapter.getRawTranscript(sessionId)` owner seam. It does
not read adapter paths or private session storage directly, persist a shadow
transcript, register an MCP tool, or connect sessions to an integrator runtime.

## Supported source

The reader accepts complete `jsonl` exports from `native-file` or `native-api`
sources for Codex, Claude, and Qoder, up to 16 MiB. It normalizes Codex
`response_item` messages and function/MCP tool events, plus Claude-compatible
JSONL user/assistant messages and `tool_use` / `tool_result` blocks. Unsupported
formats/harnesses, observed-only or incomplete exports, malformed complete
records, mismatched native session metadata, and oversized exports fail closed.
An incomplete trailing JSONL write is excluded from the current snapshot until
it becomes a valid complete event. Other native JSON formats need an explicit
normalizer before they can be paged.

## Stable pages during append

`createRawTranscriptPageReader({scope, getRawTranscript})` binds the owner seam
to `(hostId, harness, nativeSessionId)`. The first page freezes the byte length,
event count, and SHA-256 hash of the largest complete JSONL event prefix. Each
continuation fetches the canonical export again and verifies that exact prefix,
source metadata, and requested session identity. Appended complete events fall
outside the frozen prefix, so the existing cursor continues without omissions
or duplicates. A new first-page request sees the larger prefix and includes
those events.

Rewrites or truncations within the prefix, source metadata changes, malformed
prefix cursors, partial event boundaries, invalid UTF-8, and inconsistent
sequence/counts are rejected. A valid unfinished UTF-8 sequence at current
EOF is treated as an incomplete append and excluded; impossible bytes such as
`0xFF` are rejected even after a complete prefix. Prefix length uses byte
offsets at JSONL event boundaries; event text is decoded as UTF-8 after the
boundary is fixed. The page limit is 1..100. The iterator also rejects
duplicate event IDs across the whole page walk. Native event IDs are preserved
when present; otherwise a deterministic snapshot-local ID is derived from
record position and bytes.

Continuations contain a reader-issued opaque token backed by a bounded
in-memory registry (up to 2,048 entries, 30-minute sliding expiry). The
registry binds the token to the immutable snapshot hash, byte extent, event
count, exact scope, and next position. Outer cursor fields are checked against
the sequence/count returned for that issued token, so coordinated cursor edits
cannot skip an event. Replaying the same cursor returns the same page. A reader
restart expires all its cursors; callers restart at page one. The registry
stores cursor metadata only, not transcript contents, and is not an authorization
service or persistent secret store.

Native role `user` does not establish a verified person identity: its author is
reported as `unknown` with source role `user`. Assistant roles and tool names /
call IDs remain distinct source metadata. Identity is never inferred from text.

The cursor is a continuation and snapshot guard, not an authorization token.
Callers and native adapters still own authentication and exact host routing.
No shared-session ACL or end-user visibility is claimed here.

## Verification boundary

Focused tests use the actual `CodexAdapter.getRawTranscript()` fixture with 52
messages plus eight tool events. They prove appends between every page leave
the original 60-event snapshot complete and duplicate-free; a fresh cursor
then includes both appended events. Tests also cover cursor replay, coordinated
sequence tampering, restart expiry, valid incomplete multibyte EOF versus
invalid trailing UTF-8, malformed prefixes, rewrite/truncation, source/session
metadata mismatch, and oversized/unsupported sources. These checks do not
prove runtime registration, shared ACL, integration with the other S42 lanes,
or full C2 consumer acceptance.
