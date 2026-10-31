# OpenCode search coverage accounting: verified diagnosis and patch plan

Status: source fix committed as `6099a19` after the releaser confirmed immutable candidate `49b2c13f33a7587e80f4e0158c1b9bd12ecab05b` was captured. The installed candidate was not changed or rebuilt.

## Verified cause

`src/session-search-sources.ts` exposes SQLite message parts through lazy `chunks` iterators and increments `textSessions`/`chunks` only when that iterator is consumed. `src/session-search.ts` intentionally returns early for an unchanged `revision` before consuming `session.chunks`. The incremental path therefore reports zero newly consumed text on a successful unchanged scan even when the durable search index still contains searchable chunks. The `tests/l72-session-search-incremental.test.ts` second-scan assertion already protects the important no-reread behavior, but does not assert how source receipts distinguish durable coverage from work performed in this scan.

Read-only server-100 evidence at 2026-10-25:

- Native OpenCode SQLite has 3,200 `session` rows, 81,331 `message` rows, 321,301 `part` rows, including 34,022 `type=text` parts with a text field. Its schema matches the current persisted reader (`session` → `message` → `part`).
- The Herder index contains 3,200 OpenCode sessions and 85,982 OpenCode chunks, while the latest OpenCode receipt says 0 `textSessions` / 0 `chunks`. Those receipt fields describe consumed chunks in that scan, not durable searchable coverage.
- A real `session_search_local` query for `resume_after` returned OpenCode session `ses_ec120b023ffeKJ7OLe2jaW4kiL`, part `prt_13effd59d001S3cD8sEjVXlpOI`, and a matching excerpt. Read-only lookup linked that part to message `msg_13effcaa4001ds11XSVA4yoZFW`.
- The user's exact MiniMax/idle quote is not yet identified. The literal `пробуждение` was absent from this host's OpenCode text parts; this is host-local evidence only, not evidence of absence across the fleet. Fleet receipts are partial in other ways, and semantic corpus indexing was still running during the read.

## Minimal source change after release freeze

Owned paths:

- `src/session-search.ts`
- `tests/l72-session-search-incremental.test.ts`

Preserve current incremental ingestion and its no-reread guarantee. Keep the existing receipt fields compatible, but explicitly expose two different measurements per host and harness:

- `indexedTextSessions` / `indexedChunks`: durable, currently searchable text in this local index for that receipt's harness, counted from the index after successful or partial source completion.
- `processedTextSessions` / `processedChunks`: text sessions / chunks actually consumed and (re)processed during this scan; these are zero for unchanged revisions. Existing `textSessions` / `chunks` can remain compatibility aliases for processed counts until callers migrate.

Never count across harnesses or hosts. On partial/unavailable source reads, label indexed counts as retained searchable index state, not proof that the source was fully observed. Do not force chunks to be reread just to populate coverage. Do not return transcript content or snippets in coverage metadata.

## Discriminating RED → GREEN test

Extend the existing incremental OpenCode fixture in `tests/l72-session-search-incremental.test.ts`:

1. First scan indexes two sessions with 40 text parts each. Assert native text rows were read, `indexedTextSessions === 2`, `indexedChunks === 80`, and the durable search for `alpha-needle-7` returns the fixture's exact native session and chunk.
2. Second scan leaves the source unchanged. Assert `contentRows(path) === 0` (no native message/part reread), the same two sessions and 80 chunks remain indexed, `processedTextSessions === 0` and `processedChunks === 0`, and search returns the same session/chunk and revision as the first scan.
3. Insert one new text part in only `ses-beta`, advance its published session timestamp, then scan again. Assert only that session's native content is read; durable counts become 2 sessions / 81 chunks, newly processed counts are nonzero only for the changed session, and `beta-needle-new` matches `ses-beta`.

This red case distinguishes “no text in source” from “no text reread because the index already has it” without touching a live native database. Run the focused incremental/search tests and `npx tsc --noEmit`; broader checks only if those changes expose regressions.

## Implementation result

The checked unified patch is `search-coverage-accounting.patch` (SHA-256 `d5570ff896bf4fd04a0ed9f142d84944357503494a5fb68b628a64a0ee3acfab`); `git apply --check` passed against branch base `49b2c13f33a7587e80f4e0158c1b9bd12ecab05b`. It changes only `src/session-search.ts` and `tests/l72-session-search-incremental.test.ts`.

The source now records durable, harness-scoped indexed text-session/chunk counts separately from text/chunks consumed in the current scan. The L72 regression checks initial 2/80 indexed and processed, unchanged 2/80 durable with 0/0 processed and no native content reread, then one-session update to 2/81 durable with 1/41 processed. Focused verification passed: `npx vitest run tests/l72-session-search-incremental.test.ts tests/session-search.test.ts --reporter=dot` (12/12), `npx tsc --noEmit`, and `git diff --check`. Commit: `6099a19 Report durable session search coverage`.

## Corpus/query follow-up

After the metric fix is released, repeat bounded lexical and semantic searches for the user's quoted concepts on each host with explicit host receipts. Record returned exact session/message IDs and only bounded visible snippets. Preserve per-host `partial`, unavailable, freshness, and corpus-index progress. Do not ask the user for a link before these searches; do not wake sessions, replay queued inputs, or claim “not found” when a host or index is partial.
