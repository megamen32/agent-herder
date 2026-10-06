# ZCode completion and queued input

Owner: Codex 01a1106f-30c3-79f0-9260-ca4810dc1f2a.

The native Stop hook called `on` on every completion, overwriting a user's
session-level off setting. A durable choice then polled for up to seven days
inside the native turn. ZCode could display the final answer while the turn
remained occupied and new input waited.

Controlled native session: `sess_5af9af6c-51ee-4f04-9891-b82f9c446eeb`.
At 12:27:48 UTC its completed question created choice
`be34651d-39d5-4814-9658-e37e4a7ad47c`; process 3759025 remained in Stop.
Browser composer input while this choice was pending did not start a new
answer. Session autopilot was visibly switched off; the existing waiter still
remained. Explicit Stop returned 200 and context consume=0 reported held=true.
Only this owned canary was used. Screenshots were inspected and stored outside
Git in the task's Codex visualizations directory.

Verified native runtime source: `~/.zcode/server/agents/glm/zcode.cjs`,
`T0n`/`Wio` pass `last_assistant_message`, `transcript_path`, turnId and
stop_hook_active to process hooks. No vendor sources were edited.

Fix: Stop evaluates existing policy without toggling it on; choice returns
immediately. Signed choice selection uses the existing Herder native writer,
exact session/cwd, durable bound receipt and duplicate guard. Human-stop gates
and generated prompt registration remain unchanged. No replacement sessions,
phone actions or business mutations.

Red: disabled hook continued; choice hook failed a two-second exit deadline.
Green: hook/choice HTTP 16 tests; native adapter/human-stop integration 66 tests.
Test budget: one worker/CPU, 768 MiB soft/1 GiB hard RAM, 128 MiB swap,
64 tasks, IOWeight20, bounded 30–50 second scopes. Typecheck separately bounded.

Pending: coordinated Herder build/restart, real post-change same-ID choice and
queued prompt proof, strict held rejection proof and final owned-canary cleanup.
