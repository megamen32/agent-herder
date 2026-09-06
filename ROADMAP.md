# Roadmap

## Proposed

- [x] Context-mode-backed transcript retrieval — completed 2026-07-30; Agent Herder now uses bounded Context Mode-style local ranking for `query` or lead `need`.
- [x] Workspace-scoped canonical transcript archive — completed 2026-07-30; raw-source archive, CWD isolation, retention, and navigation are available.
- [x] Simplify transcript access to raw export plus permanent navigation card — completed 2026-07-30; `export_transcript` supersedes internal context ranking and transcript search.
- [ ] Event-driven ChatGPT `E-Frontier` secretary loop — proposed 2026-08-10; Telegram DM/group inbound event -> durable dedupe/wake -> authenticated Mac mini browser worker -> ChatGPT session continuation. Plan selection and browser/source gates pending.
- [ ] quota-lens forecast v2 — proposed 2026-09-06; user request: more realistic ETA than gaussian point estimate. Tier 1 (do when quota history ≥ 3 days): interval forecast instead of point (median + 80% band from pairwise rate spread), robust burn-rate (Theil–Sen or trimmed mean) instead of gaussian mean, hour-of-day burn-risk heatmap from accumulated history. Tier 2 (only after 2–3 weeks of data): empirical-Bayes hourly rate priors (Gamma, shrinkage to global mean) → posterior ETA distribution; day-of-week factor only if variance decomposition shows effect. Rejected for now as premature: full MCMC/Kalman/ML.
