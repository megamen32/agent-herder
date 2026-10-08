# Broken-session continuator TDD, 2026-10-08

Owner: root/broken_session_continuator_tdd. Existing canonical checkout only.

User requested deterministic recovery of confirmed broken existing sessions
without LLM dependency, separate from the semantic autopilot.

Implemented and focused verified: provider-wide native disconnect fanout with
generation/timestamp fencing; matching cold failure ingestion after controller
death; exact interrupted-disconnect handling; fresh native active/permission/stop/
forget checks before controls; independent no-LLM recoverPending entrypoint.
Adjacent forgotten-session audit correction was reviewed with its semantic owner.

TDD red cases were observed before each change; final focused suite 63/63.
No app/DB/LLM/native session was launched by the tests. Foreign web UI WIP remains
untouched and must not be described as a clean whole checkout.

Outstanding: safe live activation and a real native recovery canary. Shared SDK
stdio shutdown makes a controller restart unsafe without native ownership proof.
Do not mutate the shared unfinished ledger from a parallel one-shot runner.
Root performs separately authorized manual recoveries; exact owner admission,
fresh resource/stdio gates and same native turn readback remain mandatory.

Published core: `30dcb974c989ac1d31eec3a379103bea657d3f95`.
Published finite observer: `98cb8aa3a93b8640699b7ca8a0478cd4abacf1fe`.
Three observer tests PASS. Actual UnixWS read-only canary completed six checks
in 26.04s, measured peak RSS 99,584KiB; zero controls/LLM/shared-ledger writes.
Cabinet and delivery latest native turns are interrupted/idle with no exact
durable recovery cause: HOLD. Receipt is
`.tmp/broken-session-continuator/native-watch.json`.

Full goal remains unfinished. Smallest next action: bind verified OOMd death of
session-71098.scope to each exact owning native turn/generation, then fresh
owner/case and reserve admission, activate the published recovery entrypoint
without disposing shared SDK sessions, and read back the recovered native turn.
Global OOMd death and idle inventory alone cannot supply per-turn evidence.
Current fresh memory observation no longer has the prior numeric UID deficit;
this does not bypass any case, lifecycle, stdio or explicit human-stop gate.
