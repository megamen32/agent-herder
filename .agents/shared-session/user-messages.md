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
authorized by the current local watchdog-repair slice.
