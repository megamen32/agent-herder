# NoticePlace consumer slice — Luna

Scope: `src/automation/v1-noticeplace-launch.ts`, `tests/v1-noticeplace-launch.test.ts`. Existing `evidence/finish-20261108/restore-core-luna.md` is other WIP and was preserved.

## Consumer contract verified

Read-only inspection of installed `/opt/noticeplace/notification_center/agent_job_helper.py`:

- `_launch_policy` / `_launch_policy_profile` read `GET /api/automation/launch-policy`; project routing selects the preferred permitted harness/model and must not infer fallback.
- `project_launch` sends `POST /api/automation/project-launch` with original `project`, `cwd`, `message`, `operation_id`, `harness=opencode`, exact model, and health purpose; the dedicated bearer is header-only. The helper uses `noticeplace.health-analysis` and preserves `incident_session_policy`.
- `_operation_id` is incident/profile/plan-derived and stable across retries. The incident facts remain in the original message for `IncidentSessionRouter` source grouping.
- Existing TS decision/effect path: `dispatchProjectLaunch` durable attempt reservation → `namedSessionRunner` → `IncidentSessionRouter` → `newOrResumeNamedSession`. Project attempt keys prevent duplicate execution; HumanStop and admission UNKNOWN are terminal outcomes. NoticePlace event/session bindings and completion callbacks remain owned by existing NoticePlace/HTTP consumers.

## Rust wire contract and exact gap for parent

Read-only inspection of `crates/herder/src/mcp/catalog.rs` and `crates/herder-compat/src/contract.rs`:

- `create` accepts `{action:"create", instance_ref, project_ref?, prompt, request_key}`. It creates a session and initial prompt with durable Rust intents, but does not accept a preselected `session_ref` or model/provider route in the request.
- `deliver` accepts `{action:"session", session_ref, message, mode:"current"|"queue"|"start", request_key}`. Reuse needs the exact prior native session reference and a separately stable delivery key.
- `compat_task` supports only `get`, `answer`, `cancel`; it is not a project-launch or generic `new_or_resume` API.
- Current selected owner profile in reviewed fleet evidence is `codex-local`; this does not prove an OpenCode `minimax-coding-plan` instance. Rust owner composition also has to authorize that exact instance and surface native HumanStop/receipt/UNKNOWN outcomes.

Therefore there is not yet enough installed Rust API to wire this adapter directly without inventing capabilities or bypassing policy. Parent must provide/review the OpenCode scoped instance plus a Rust-owned launch/identity decision with deterministic operation-to-create/deliver keys (or equivalent supported API), policy read, and receipt/HumanStop semantics. The NoticePlace call must not fall back to the legacy `dist/index.js` runtime.

## Implemented seam and evidence

The new typed consumer adapter preserves incident ID, project, cwd, full source message, operation ID, policy TTL, exact OpenCode provider route, and the internal NoticePlace authorization capability while delegating the actual admission to the existing project-launch boundary. It maps accepted, UNKNOWN/in-flight, HumanStop, and definite rejection without retrying another route. This is an isolated source seam; it is not wired into an HTTP route, Rust owner composition, or production deployment.

Verification: `npx vitest run --root . --config vitest.config.ts tests/v1-noticeplace-launch.test.ts` — 1 file, 6 tests PASS. Coverage includes duplicate operation identity, exact model/provider, original incident payload, UNKNOWN/in-flight, HumanStop, no fallback/retry, and invalid identity. `npx tsc --noEmit --pretty false` completed without diagnostics. No NoticePlace source/runtime, token, Rust core/schema, shared web entrypoint, deployment, or model send was changed/performed.

The checkout contains pre-existing unrelated Rust/evidence WIP; it remains untouched. No commit or deployment was performed.
