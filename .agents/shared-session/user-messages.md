# Durable user-message record

## 2026-08-11 — immutable health objective

The user requires an end-to-end health incident outcome: host/service/log
degradation is deduplicated, diagnosed, presented as exactly three plans,
explicitly selected by the user, remediated through Hermes, supervised for
useful progress, independently verified, and reported resolved through
NoticePlace with elapsed time and trace IDs. The implementation route is the
selected Normal plan; acceptance is the business chain, not green tests.

## 2026-08-11 — current authorization

The user explicitly authorized one `remediation retry plan-003` for the
existing selected incident. The attempt was consumed: delivery
`dlv_2c7160a0bc604e19b2ff86e7ad4ac918` reached `failed` attempt 5. No new retry,
Telegram message, deployment, restart, secret change, or external action is
authorized by the current local runtime-switch slice.

## 2026-08-11 — runtime correction

The user explicitly changed remediation runtime: do not use Hermes; use the
existing OpenCode harness. This supersedes the local Hermes watchdog-repair
route. No live OpenCode retry, deploy, restart, Telegram send, or other external
action is authorized merely by this correction.

## 2026-08-12 — current Agent Herder MVP request

The newest explicit user request in Codex task session
`019feaff-f476-7592-8e53-e2f2351fbb84` is: `сделай быстрый минимально рабочий
результат`. It continues the Agent Herder objective recorded in
`/home/roomhacker/agents-projects/.agents/tasks/work-20260811-agent-herder-runtime-settings-ui.md`:
after a judge returns `continue`, append one goal to the same Codex thread with
durable, target-bound admission semantics. This request supersedes the old
health-remediation P0 for this task lineage only. It does not authorize a live
health retry, global hook edit, service restart, all-session activation, live
timeout, deployment, or production-session continuation.

The authoritative bounded task lineage is now
`.agents/tasks/work-20260812-agent-herder-same-thread-mvp.md`. The older
workspace-root runtime-settings UI card is preserved as history and is not the
acceptance contract for this narrowed request.
