# Exact c5a84dec candidate verification

Manifest: bcdd172d52d7728f6bb9fa3ce225d873c08056e5d98fd7c11bfcbbb5dc399937.

## Fresh isolated full consumer: PASS

`zcode-c5a-full-{command.json,run.log,result.json}` retain exact command and full
consumer report. Two distinct native inputs and answers, native full export,
search, native project provenance, restart/readback, and archive confirmed.
Session: session:6bd2645f2c976bc673328de804dc7d03.
Final archive: archived=true, effect=confirmed, isError=false. Launcher exited 0
and cleaned its own fresh root. Fake-model HTTP count: 0 -> 3 (separate from two
proven native answers). No real provider or browser.

## Original retained 82b session: UNKNOWN, not retried

`zcode-c5a-retained-{command.json,run.log,result.json}` retain the one attempted
archive with the same authority/workspace/session, a new protected profile and
exact c5a runner. Original unsupported/effect=none proof was checked first.
No model server or model send. Actual reply: archive_outcome_unknown/effect=unknown.
The isolated supervisor/core were shut down normally; retained root preserved.

A subsequent separate read-only diagnostic (no archive/send) established:
readSession(existing-only) -> "ZCode Agent runtime is not running."
listArchivedTasks succeeds, target absent; SQLite exact row remains archived=0,
deleted=0. Diagnostic source/log: zcode-c5a-retained-diagnostic.py/.log.
No UNKNOWN mutation was repeated or relabelled PASS.

## Discovered source defect and bounded correction

The archive preflight added in c5a required live-agent readSession, preventing
archive of a retained session after runtime shutdown. Native official
archiveTask already checks the exact workspace/task row inside its transaction
and refuses absent/deleted rows before update. Removed only this redundant
agent-runtime read, retaining exact task/workspace parameters, acknowledgement
identity check and archived-list readback. Changed source paths:
`src/adapters/zcode.ts`, `tests/zcode-archive.test.ts`.

RED: zcode-c5a-stopped-runtime-red.log, one regression fails with the observed
runtime-not-running error. GREEN: zcode-c5a-stopped-runtime-green.log.
This source delta is NOT in the tested immutable c5a candidate. A new candidate
is required for native proof of the corrected stopped-runtime path. Retained
UNKNOWN remains unrepeated. Existing fresh c5a full proof applies only to its
exact bytes. No install, commit/push or model resends.
