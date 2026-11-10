# Roadmap

## Proposed

- [x] Context-mode-backed transcript retrieval — completed 2026-07-30; Agent Herder now uses bounded Context Mode-style local ranking for `query` or lead `need`.
- [x] Workspace-scoped canonical transcript archive — completed 2026-07-30; raw-source archive, CWD isolation, retention, and navigation are available.
- [x] Simplify transcript access to raw export plus permanent navigation card — completed 2026-07-30; `export_transcript` supersedes internal context ranking and transcript search.
- [ ] Event-driven ChatGPT `E-Frontier` secretary loop — proposed 2026-08-10; Telegram DM/group inbound event -> durable dedupe/wake -> authenticated Mac mini browser worker -> ChatGPT session continuation. Plan selection and browser/source gates pending.
- [ ] quota-lens forecast v2 — proposed 2026-09-06; user request: more realistic ETA than gaussian point estimate. Tier 1 (do when quota history ≥ 3 days): interval forecast instead of point (median + 80% band from pairwise rate spread), robust burn-rate (Theil–Sen or trimmed mean) instead of gaussian mean, hour-of-day burn-risk heatmap from accumulated history. Tier 2 (only after 2–3 weeks of data): empirical-Bayes hourly rate priors (Gamma, shrinkage to global mean) → posterior ETA distribution; day-of-week factor only if variance decomposition shows effect. Rejected for now as premature: full MCMC/Kalman/ML.

## Backlog

- [ ] 2026-11-24 Двухэтапные ответы между сессиями: по умолчанию ранний реальный текст и итоговый ответ; `expect_reply=false` отключает оба и напоминания. При отсутствии итога существующий хук напоминает получателю ответить и подсказывает точный способ. Только текст assistant, с корреляцией и дедупликацией через существующие delivery/reply_to; без циклов ответа и второго планировщика. Поручение владельца 10.11.2026, план `20261107-herder-v1-core`, `SESSIONREPLIES13`.
