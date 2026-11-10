# OpenCode public projects — measured result

PASS for authorized project attribution, with honest partial inventory. No additional core fix required.

Core commit: `7ee42db728ed50f731e80e61c2a7bb7ef1a7328c` (includes d64c76f9).
Built executable SHA256: `71b357f8b710e0fe484d36c3f7c0a9124853940052aea4508a736d4c2b828569`.
Built binary retained at `/home/roomhacker/.codex/worktrees/herder-quota-receipt/agent-herder/.tmp/d12-projects-7ee42db7/herder_native_stdio`; mode0555. Parent owns next immutable candidate publication. No new source commit after7ee42db7 is necessary.

## Exact tested path

Newly built Rust public MCP → unchanged814759 AHAP OpenCode JS bundle → pinned native OpenCode2.2.4 → isolated local fake model. Dependencies were SHA256-checked before any mutation. Dedicated network namespace has only loopback, no IPv4/IPv6 external routes; filesystem namespace has fresh protected HOME and fresh authority created by existing bootstrap with v4 migration under its guard. No native adapter, registry SQL insertion or CI-config project injection was added.

Instance `d12-projects-f53350ec37cd41dba93163878bc79efe`. Session `session:37c770724f7c06929f9af46bdeeb2851` binds native `ses_e46c6e97bffeLO0fQTqayVukqf`. Public create key `d12-create-09a2f6e390cc40ddbe6831ba2940f826` was emitted before its sole submission. One public create + initial prompt, one fake-model request, zero separate deliver, zero replay. Original prior CI operation identifiers/receipts untouched.

## Public observations

1. Before registration: count0, complete=false, scope authorized_registered_sessions, limitation No native project observed for the authorized registered corpus. This reproduces the old receipt at its actual premutation position.
2. After public create Task completed, public sessions/list confirmed the exact registered native ID and native cwd `/herder-owner-home/work`.
3. Public discover(action=projects) returned the following structuredContent:

```json
{
  "complete": false,
  "limitations": [
    "Only projects observed in authorized registered sessions are exposed; inventory is not globally exhaustive."
  ],
  "projects": [
    {
      "native": null,
      "project_ref": "/herder-owner-home/work",
      "source": "authorized_native_session"
    }
  ],
  "scope": "authorized_registered_sessions"
}
```

4. Close/reopen the built core against the same protected authority; public discover still count1 with the same path/source/scope/limitation. Model counter remained1. This reopens only the disposable test core; it is not an installed service restart.

The returned `native:null` is the documented fallback: no matching optional native project-inventory record was attached, but the exact authorized native session's observed cwd supplies valid provenance. Lack of a matching listProjects/worktree record does not produce an empty result after registration in this measured path. No global completeness is claimed.

## Tests and qualification

- cargo build succeeded.
- First parallel lib run:181/182PASS; one Codex fixture initialization timeout at create.rs:157/Rpc request1. Preserved as a failure, not hidden or fixed outside scope.
- Exact failing test alone:1/1PASS.
- Serial full lib run:182/182PASS (15.56s); complete output in lib-serial.log.
- Previous owned inline owner_reads proof:16/16PASS; source remains the exact7ee42db7 test commit.
- This public probe exited0 with PASS_PROJECT_ATTRIBUTION. Core and native OpenCode process stopped; launcher removed the disposable root. Raw receipts/log and runnable probe retained alongside.

## Root and next integration step

Existing core project mapping is correct for the measured registered session. CI helper previously queried projects before create and reused that result; its separate requirement for complete=true conflicts with explicitly partial authorized inventory. CI owner should consume the post-registration project response with exact session/cwd attribution and retain complete=false plus global limitation. Core source requires no compensating ACL/config fallback.

The **old814759 core binary itself was not rerun** here: this is the requested newly built7ee42db7 core, reusing exact814759 adapter/Node/bootstrap components. Its core digest differs from814759's3d21813f...; no cross-candidate whole-lane PASS is inferred. Integrator can build the next immutable candidate from7ee42db7 (already includesd64c76f9), record its actual digest, and decide component-qualified reuse of other lane proofs. This closes the measured projects-attribution gap only; no5/5 or installation claim.
