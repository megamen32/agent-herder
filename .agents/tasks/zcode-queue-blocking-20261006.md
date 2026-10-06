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

First final-runtime proof on0a4f846/PID113237: own same-ID native queue replied
ОЧЕРЕДЬ ПРОШЛА while a durable color choice was pending. Session-level off stayed
off after actual human resume/completion; automatic message while held was
rejected, no replacement. Color timeout receipt15deb485 resumed once in the
same nativeID and got a final red confirmation; this was timeout, not a human
button click. Current canary is explicitly stopped/heldtrue with autopilot off.

Acceptance exposed repeated same-turn terminal choices: native turn8ca1e242
created15deb485 ande9e5d09c; turnf60461cb createdbce38566 and57ee5698. The latter
judged generated coordination board notes as the user's task. Root released
onlysrc/autopilot/index.ts andtests/autopilot-core.test.ts for the correction.
Root cause: persisted choice receipts were discarded on reload; terminal
receipts and in-process locks also keyed only by changing evidence hash.

Correction preserves choice reload and per-native-turn terminal/active guard;
continue may still re-evaluate new evidence, and a pending terminal notice
retries its exact old payload/key. A failed choice card keeps one registry
request and durable notice. Judge/card projections remove only complete
canonical leading board+exact generated caption before truncation. Bounded
4MiB transcript projection preserves trailing real requests before final16KiB
judge evidence limit; original native prompt/cache/evidence/digest/ancestry
remain unchanged. Literal/incomplete tags are retained.

Independent root review PASS; root absolute Node core28/28 in3.43s and
related6files45/45 in6.84s. Own smaller64-task/single-CPU50s runner failed to
finish startup; no broad suite/budget escalation by this agent. Root ran one
approved shared-budget2CPU/2GiB120s scope. Typecheck green. Foreign root
tracker/obsolete surface assertion and status owner's commits preserved.

Pending: root's ONE coherent build/restart, then fresh same-ID signed human
selection/duplicate/no-noise proof, strict final hold and original settings
restoration. No new sessions or vendor-source changes.
Evidence: Codex visualizations zcode-queue/pre-terminal-fix.json and inspected
browser screenshots (including expired blank page before any cleanup).
