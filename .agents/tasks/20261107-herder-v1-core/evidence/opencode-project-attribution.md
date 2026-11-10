# D12 follow-up — OpenCode projects attribution

Verdict: no reproduced owner_reads production defect. The supplied CI receipt preserves a premutation empty-registry response and the CI classifier also requires global completeness. Those two CI-owned checks cannot establish loss of project path after registration. Do not broaden ACL or invent project attribution from CI config to make that receipt pass.

## Exact source localization

- Candidate `814759a9248df707f974168f8fb57ba56280ec6b`; supplied manifest SHA256 `83f5593155f11f7216dd6f36d81190025daef01fc73574fdda30b0e405977385`.
- CI checkout `/home/roomhacker/.codex/worktrees/ahap-opencode-consumer/agent-herder`, `tests/native/ahap_opencode_stand.py:919`: one discover.projects call BEFORE create (create begins after line969). Its projects_check is retained at final reporting lines1124–1128. No second discover.projects call occurs after the session binding is registered.
- Same file:234 `public_projects_readiness` requires `complete is True`, independently of the observed project count. Thus even correct authorized nonempty partial inventory remains INCOMPLETE under this oracle. The owner explicitly requires complete=false with a global-inventory limitation.
- Core `owner_reads.rs:368,515,544`: registered principal+exact instance corpus → listSessions filtered by native ID → cwd → optional matching native project inventory. Empty registry performs no native discovery. This is the required ACL behavior.
- `packages/agent-resume/src/harness/opencode/client.ts:1798`: location.directory/directory/path → toSummary.cwd. `src/adapters/opencode.ts:429,1185`: listSessions maps toAgentSession including cwd. `src/ahap-legacy-read.ts:25`: listSessions result is passed through. There is no evidence for adding a new directory alias or native protocol decoder to core.
- Before this test change, owner_reads.rs had no diff against candidate814759. Production bytes before cfg(test) still match candidate exactly.

## Owned change and proof

Only the existing inline test `projects_use_authorized_observation_and_not_config_or_foreign_inventory` changed:

1. Empty registry returns projects=[]/complete=false and invokes no native callback.
2. Register an exact owned session using the existing guarded fixture API; same discovery request then returns /allowed from normalized AHAP cwd.
3. Bob's registered session, Alice's other-instance session and an unregistered native session cannot contribute project paths.
4. With native listProjects, exact worktree attribution is preserved; without that optional inventory, observed authorized native session cwd still returns the project.
5. complete=false, authorized_registered_sessions scope and explicit global-inventory limitation remain mandatory. Any mutation callback would panic.

Local checks:

- `cargo test --manifest-path crates/herder/Cargo.toml --bin herder_native_stdio owner_reads::tests::projects_use_authorized_observation_and_not_config_or_foreign_inventory -- --exact`: 1 passed (green on existing production implementation).
- `cargo test --manifest-path crates/herder/Cargo.toml --bin herder_native_stdio owner_reads::tests::`: 16 passed, 0 failed, including revocation/index ACL and fake AHAP subprocess tests. No OpenCode server or model requests.
- Offline RED using the CI helper, imported with PYTHONDONTWRITEBYTECODE=1: a structured payload containing one attributed /allowed project, scope=authorized_registered_sessions and complete=false yields status=incomplete, projects_count=1. Assertion that scoped attribution is confirmed fails. No CI source/fixture was edited.
- `rustup run stable rustfmt --edition 2024 --check <owned module>` and scoped git diff --check pass. The pinned1.96.1 toolchain lacks rustfmt; installed stable formatter used without installing components.

There is intentionally no invented RED core failure or production fix. The confirmed defect is in the CI-owned observation sequence and completeness requirement; that ownership boundary is the exact blocker to completing acceptance here.

## API and next candidate requirement

Public call signature, AHAP methods, ACL, project serialization and production behavior unchanged. No adapter, Cargo/lib/catalog, runtime, deploy or credential edits. No native create/deliver/replay occurred. All fixtures in this check are local unit fixtures.

CI owner should preserve preflight's honest empty/partial response, then evaluate discover.projects after the exact authorized session has been registered (and optionally after core reopen), attributing the expected observed native cwd. Its scoped assertion must accept nonempty authorized attribution with complete=false and the explicit global-inventory limitation; it must not label global inventory complete. Do not weaken identity/ACL checks or feed CI config into core.

The supplied acceptance receipt says the disposable fixture was removed and OpenCode stopped. It cannot support a new live readback as-is. No recreation is authorized in this slice; CI owner decides the next isolated acceptance action and reuse of unchanged lane proofs. No 5/5 or installed claim.

No runtime rebuild is needed to activate this test-only change. If immutable candidate policy requires a source revision containing the regression, integrate the exact commit below and rebuild through the existing candidate builder, rehashing components. Do not assume a rebuilt binary digest or transfer old proofs blindly: shared HEAD also contains other owners' changes. This slice changed no production bytes; existing candidate component digest below is an old manifest value, not a newly built executable.

Owned source commit (shared detached checkout): `7ee42db728ed50f731e80e61c2a7bb7ef1a7328c`

Module SHA256: `90d3fec37ae84cc72e95aefb0c82236e734d78dce6aadc843dad949a815886a2`

Production prefix SHA256: `1ffb4684ef5c9c7fc73fa0e4585d6460dc85fab06a37c09015ea2699164b2358` (equal to814759).

Existing814759 core component manifest SHA256: `3d21813f041f2388ed4f060d7df94f880ecbb6532e7e99da2a305aa59c3539ae`.

No push or foreign-path publication performed; exact owned commit is available to the parent in the shared repository for integration.

UTC: 2026-11-08T02:58:43.119542+00:00
