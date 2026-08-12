# Worker/file registry

| Task | Owner | Allowed files | Status |
| --- | --- | --- | --- |
| hermes-watchdog-semantic-progress | no active Worker | superseded by user runtime correction | stopped |
| opencode-health-runtime-switch | pending Worker | read-only Agent-Herder and NoticePlace seam mapping | waiting for continued Overseer |
| agent-herder-codex-same-thread-mvp | Worker `019ff429-cf8a-7c63-bc11-7b0311c237ce` (paused) | `src/adapters/codex-app-server.ts`, `tests/codex-app-server.test.ts`, its existing fake fixture, root task evidence | stopped on Overseer verdict; zero edits; waiting for corrected Overseer audit |
| agent-herder-codex-same-thread-mvp-v2 | Worker `019ff429-cf8a-7c63-bc11-7b0311c237ce` (paused pending audit) | `src/adapters/codex-app-server.ts`, `tests/codex-app-server.test.ts`, its existing fake fixture, `.agents/tasks/work-20260812-agent-herder-same-thread-mvp.md` | fresh bounded lineage after second RETHINK |
| agent-herder-codex-same-thread-mvp-review | fresh Reviewer pending | read-only task-owned adapter/test/fixture diff and task evidence | independent review gate after Worker green |
| agent-herder-agent-resume-production-join | Worker `019ff429-cf8a-7c63-bc11-7b0311c237ce` pending Overseer | `/home/roomhacker/agents-projects/agent-resume/agent_resume.py`, `/home/roomhacker/agents-projects/agent-resume/tests/test_resume_bound_target.py`, root task evidence | production-path correction; preserve foreign Hermes dirty files |
