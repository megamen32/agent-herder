# Roadmap

## Active P0 — Agent Herder: unified process leases and native resume (handoff 2026-11-15)

- [ ] **Закончить внедрение единого Herder (`resource` + `automation`), без standalone Agent Resume scheduler.** Автопродление lease вне LLM, durable process receipt и ровно одно возобновление исходной сессии. **Полный handoff:** [`docs/implementation/process-leases-handoff-20261115.md`](docs/implementation/process-leases-handoff-20261115.md). [Архитектурный план](https://chatgpt.com/space/page_835ee164266081918e5e4297ac92a2a3).
- [x] **Основа внедрена:** canonical resource ledger v2 (27 ресурсов / 28 mappings), миграция шести authority, сохранение UNKNOWN/трёх чужих holds; OpenCode process→renew→single wake E2E — PASS.
- [ ] **P0 / Reconcile & ZCode:** заново сопоставить live TS/native SHA, `main`, PID и claims (срез 15.11 ~04:30 уже может устареть). Проверить оригинальную задачу `a0ede4a0a45666d18b4d23353ade599d` без replay; затем доказать **один** ZCode native wake/input/assistant turn и idle.
- [ ] **P0 / Rollout & acceptance:** при необходимости парно обновить TS+Rust под новым release claim (не fence 122); проверить Codex, поддерживаемые OpenCode, ZCode, ChatGPT/browser и Hermes по реальному native admission; исключить второй scheduler. Зафиксировать production receipts, commit/push и release cleanup.
- **DoD:** работающий production Herder, единая authority, E2E каждого фактически поддерживаемого harness, no duplicate spawn/wake и сохранённые UNKNOWN; неподтверждённые harness явно отмечены.

## Proposed

- [x] Context-mode-backed transcript retrieval — completed 2026-07-30; Agent Herder now uses bounded Context Mode-style local ranking for `query` or lead `need`.
- [x] Workspace-scoped canonical transcript archive — completed 2026-07-30; raw-source archive, CWD isolation, retention, and navigation are available.
- [x] Simplify transcript access to raw export plus permanent navigation card — completed 2026-07-30; `export_transcript` supersedes internal context ranking and transcript search.
- [ ] Event-driven ChatGPT `E-Frontier` secretary loop — proposed 2026-08-10; Telegram DM/group inbound event -> durable dedupe/wake -> authenticated Mac mini browser worker -> ChatGPT session continuation. Plan selection and browser/source gates pending.
- [ ] quota-lens forecast v2 — proposed 2026-09-06; user request: more realistic ETA than gaussian point estimate. Tier 1 (do when quota history ≥ 3 days): interval forecast instead of point (median + 80% band from pairwise rate spread), robust burn-rate (Theil–Sen or trimmed mean) instead of gaussian mean, hour-of-day burn-risk heatmap from accumulated history. Tier 2 (only after 2–3 weeks of data): empirical-Bayes hourly rate priors (Gamma, shrinkage to global mean) → posterior ETA distribution; day-of-week factor only if variance decomposition shows effect. Rejected for now as premature: full MCMC/Kalman/ML.

## Backlog

- [ ] 2026-11-24 Двухэтапные ответы между сессиями: по умолчанию ранний реальный текст и итоговый ответ; `expect_reply=false` отключает оба и напоминания. При отсутствии итога существующий хук напоминает получателю ответить и подсказывает точный способ. Только текст assistant, с корреляцией и дедупликацией через существующие delivery/reply_to; без циклов ответа и второго планировщика. Поручение владельца 10.11.2026, план `20261107-herder-v1-core`, `SESSIONREPLIES13`.
- [ ] **2027-01-16 Связь последнего редактирования файла с сессией.** Добавить read-only просмотр того, кто последним изменил файл в рамках Agent Herder: путь, время, session/harness/host identity, change provenance и источник уверенности должны связываться с фактическим file event или commit, а не угадываться по имени агента. Предусмотреть запрос «кто последний редактировал файл?» и переход к связанной сессии/её receipt. Это будущая roadmap-задача; в текущем цикле реализация, схема хранения и runtime hooks не меняются.
