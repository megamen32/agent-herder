---
status: incomplete
---
# Evidence and discussion checkpoint

User clarified actual surface is ZCode Desktop and asked to pause/explain concurrent turns. No lifetime source fix has been made; no Desktop/runtime restart or original-session input was sent.

## Verified
- Herder436876 and owned SDK437103 retain original process generations since00:28MSK. Original session parent_id is NULL.
- Original turn_d1b2a871-7f22-4560-bc81-43278cb91339 had one model request11:03:20.594–11:07:32.868MSK,252274ms,attempt1. Desktop human continuation11:05:13.554MSK started turn_9b9e9912-1f74-48c9-bebc-9f883c16860b. Both produced later tool/model records, with original turn still reported running by registered Herder agent_info. This does not establish the exact cause of the user's observed stopped UI.
- Native plugin observed the Desktop turn at11:05:16.200MSK; existing permitted integration does not prevent two host runtimes opening the same session. SDK createZCodeAgentService owns a separate processManager per host. Native parent_id does not relate this to the originating Codex/MCP caller.
- Real controlled MCP caller2172536 admitted exactly one input to own sess_4ae3b8fc-9944-40c2-9166-514ea55faf96 and killed itself at11:13:59.050MSK. Same native session completed11:14:28.611MSK with exact LIFETIME_OK_323 and no additional send. Independent fresh MCP observer and readonly native DB confirmed completion, one input and dead caller.
- Initial model selector lacked required reasoning: explicit created=false/not_attempted retained; corrected selector$low then created exactly one canary.
- Own canary autopilot/autostart both disabled and read back. Archive is unsupported by current ZCode adapter (HTTP502); retained idle canary/history, no forced deletion.

## Remaining
Actual Desktop execution/state ownership is unresolved. Need supported single-owner path or a precisely staged Desktop-source candidate under runtime-source policy, followed by actual Desktop acceptance. Do not claim fix, reinterpret all cancellation as crash, restart shared native runtime or replay either original input. Existing approval of catalogue refresh is specific to catalogue observation; it is not blanket Desktop core-edit authority.

Private secret-safe evidence: .tmp/zcode-independent-lifetime-20261015/{acceptance.json,original-timeline.json,after-caller-death.json,caller-receipt-2.json,cleanup-policies.json}.
Tests: focused integration; expected60s/emergency600s; actual native completion29.561s after caller kill. Existing sealed native budget, no suite/build.
