# Codex completion after a Herder parent crash

The shared native app-server may survive Herder and finish the **same turn**.
Herder must not resume that turn, replay its input, or infer a failure from a
changed controller generation. A lost notification previously left its old
`UnfinishedSessionStore` active row indefinitely.

The existing semantic Autopilot cycle now checks only already persisted,
non-subagent Codex turns from an older Herder generation. It uses the supported
[`thread/read` API](https://learn.chatgpt.com/docs/app-server#read-a-stored-thread-without-resuming)
with `includeTurns: true`; this does not load or subscribe to the thread.

Eligibility requires the exact thread, cwd and latest tracked turn, idle or
notLoaded runtime without pending flags, complete history, one original user
item in that turn, settled supported tools and a final-answer assistant item.
Missing history, unknown tool states/types, errors, pending work, a new user or
turn, and history above 120,000 characters defer reconciliation.

Native `completed` is **technical evidence**, not business success and not a
Stop-hook invocation. The existing completion judge must explicitly return
`completed` with positive confidence against the full instructions and effects.
Semantic policy/session opt-out, manual Stop and pending questions remain
fences. The no-LLM recovery loop never waits for this judgement or sends a new
continuation on this path.

After judgement, Herder reads native history again. Inside the existing strict
store transaction, after its queue/read wait, it compares both the original
active row and original inventory row, rechecks policy/questions/Stop and native
fingerprint, then checks the synchronous native-event generation. Only then
are the verdict and removal written in one transaction. Newer in-memory turn
identity is never unconditionally deleted.

This is a fresh-read fence, **not an atomic native compare-and-set**: the public
read API cannot lock an external Desktop writer. Native changes after the last
read remain a boundary limitation; the route dispatches no input and does not
claim that it stopped or serialized other writers.

## Native hook availability is separate

Pinned Codex `rust-v0.162.1` Stop payload has `session_id`, `turn_id`, cwd,
transcript_path, last_assistant_message and stop_hook_active. No guessed alias
is added. Its native plugin loader omits hooks for `AgentPlugin` manifests:
[source](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core-plugins/src/loader.rs#L897).
A real `plugin/read` returned zero hooks for the installed Herder package.
Cold reconciliation neither fabricates a hook receipt nor fixes that distinct
packaging boundary. A supported Codex legacy projection is a separate delivery.

## Verification

`tests/codex-cold-completion.test.ts`: fast unit, expected under 2 seconds,
maximum 10 seconds; reproduces lost terminal observation, unfinished and human
outcomes, full-history refusals, new Desktop turns, and late holds/questions/
native changes during the store wait. It also preserves a concurrent newer
inventory verdict. Native transport and judge are isolated fixtures.

Ordinary source release runs this test, existing Codex adapter and launcher
regressions, and TypeScript checking under the 180-second aggregate deadline.
Actual acceptance remains Root's new isolated parent-SIGKILL consumer: one
initial input, surviving same turn, each effect once, no manual continuation,
explicit completed inventory and cleared exact active row. The earlier actual
150-second failed fixture is retained unchanged and excluded from retrofit.
