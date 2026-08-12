# Roadmap

## Proposed

- [x] Context-mode-backed transcript retrieval — completed 2026-07-30; Agent Herder now uses bounded Context Mode-style local ranking for `query` or lead `need`.
- [x] Workspace-scoped canonical transcript archive — completed 2026-07-30; raw-source archive, CWD isolation, retention, and navigation are available.
- [x] Simplify transcript access to raw export plus permanent navigation card — completed 2026-07-30; `export_transcript` supersedes internal context ranking and transcript search.
- [ ] Event-driven ChatGPT `E-Frontier` secretary loop — proposed 2026-08-10; Telegram DM/group inbound event -> durable dedupe/wake -> authenticated Mac mini browser worker -> ChatGPT session continuation. Plan selection and browser/source gates pending.
