# ZCode active queue route canary — 2026-10-26

## Source, installed runtime, and consumer result

- This evidence is separate from the LHC plugin source result: canonical LastHumanCommit source package 1.5.43 and its native LHC loader hook receipts are documented in `/home/roomhacker/agents-projects/LastHumanCommit/.agents/tasks/zcode-hook-loader-runtime-evidence-20261026.md`.
- Installed Agent Herder source/runtime version in this task is `683456df67b67c939b37ff9fab4fdf76c3f430df` (root reported canonical install). The ZCode API in use is installed native V4 on server-100.
- Exact isolated fixture: ZCode `session_ee676342-13d2-4f96-bbe1-d76101edb18e`, host `roomhacker-server-100`, CWD `/home/roomhacker/agents-projects/agent-herder`, model `account:zai-individual-coding-plan/GLM-5.3-Flash$high`, native owner PID 3371132 / generation 1.

## Decisive route proof

- Initial official existing-only V4 snapshot: revision 217, phase `completedSuccess`, `autoDrain=true`, pending 0, `inputRouting={mode:startNow}`, idle exact session and owner.
- Query-first stable V4 preference command `hf26-zc-set-autodrain-off-20261026-01` was accepted at revision 217. Fresh readback was revision 218, `autoDrain=false`, pending 0, phase still `completedSuccess`, same owner.
- Seed input `hf26-zc-active-45s-seed-20261026-01` was sent once (job `job_aebf3f7d5e4612412a967b29b93dd2a0bd88b1b0e744b65b4bb95412cf5d52a0`); model said it would run `sleep 45` and inspect `package.json`.
- During that native turn, the supported official V4 snapshot at `2026-10-26T08:17:41.407Z` showed exact turn `turn_eaafc71e-7762-432e-90b4-23e14741ec4f`, session `running`, `inputRouting={mode:enqueue}`, native phase `running`, `autoDrain=false`, pending 0, with active native `Bash` tool status `running`.
- After that snapshot, one distinct queue input `hf26-zc-active-enqueue-20261026-01` was sent. Herder job `job_7eb954d52a494228db2c8b30df6ce7956a28f481399087ec760633bb304a43ee` ended `admitted=true`, `ok=false`, `nonRetryable=true` with `ZCode принял сообщение в другом режиме (startNow вместо queue); повторная отправка запрещена.`
- Read-only native SQLite receipt records exact row `queue_hf26-zc-active-enqueue-20261026-01`, `delivery=startNow`, status `promoted`, promoted message `msg_mvozifb9_8868e007-5cf3-4551-9623-9eea687fbfc1`, native intent `requestedDelivery=startNow`, `admittedDelivery=startNow`, admission sequence 4. Final native turn `turn_81034ec4-58c9-42b8-b5ac-68cd0a3e68de` completed and responded with `HF26_ZCODE_ENQUEUE_FINAL_OK`; this is a response to native `startNow`, not queue acceptance.
- Final exact queue readback: revision 450, `completedSuccess`, `autoDrain=false`, pending 0, `canResume=false`. Resume was not called because the native queue was empty; no input was replayed.

## Contract and conclusion

- Herder source `src/adapters/zcode.ts:2396,2445-2452` maps a non-steering send to V4 `sendText.payload.requestedDelivery="queue"`; lines 2481–2484 reject and prohibit retry when native `inputAccepted.delivery` differs.
- Installed native V4 schema accepts `sendText.requestedDelivery` values `startNow|queue|guide` (`~/.zcode/server/zcode-server.cjs:204916-204924`), while `inputRouting` exposes `startNow|enqueue|guide|reject|choice` (`183406+`). `setAutoDrain` is a separate native preference command; there is no queue-only send command in this supported surface.
- Proven: a Herder request asking for queue, made after an exact V4 snapshot showed `inputRouting=enqueue` and an active Bash tool, was persisted and promoted as native `startNow`; Herder returned the nonretryable mismatch. Native queue acceptance and final-after-resume are not proven. The cause of the native mode conversion is not established; no ZCode core was edited.
- Stable IDs and sanitized readbacks are recorded in `.tmp/zcode-hook-loader-repair/decisive-queue-canary-intent.json`. The earlier timing-ambiguous attempt is recorded separately in the LHC runtime evidence.
