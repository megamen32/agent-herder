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
