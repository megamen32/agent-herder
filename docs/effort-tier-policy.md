# Codex effort and service tier

The Herder MCP tools `create_session`, `new_or_resume` and immediate `deliver` select settings for the Codex app-server on the owning host. The project launch policy still selects the allowed model. Other harnesses keep their native defaults.

| Task class | Target effort | Default tier |
| --- | --- | --- |
| investigation, monitor, judge | low | normal |
| edit, review | medium | normal |
| architecture, debug, refactor | high | normal |
| triage (urgent incident triage) | medium | fast when available |

Supply `taskClass` for deterministic classification. Otherwise Herder checks the opening 240 characters of the session name or message for English and Russian task cues and defaults to edit. For example, an idle session can receive `{"sessionId":"…","harness":"codex","activation":"always","message":"Inspect the failing test","reasoningEffort":"low","serviceTier":"normal"}`.

**OmniRoute provenance.** Herder ports the discrete effort vocabulary and explicit-input precedence of the default rule from `src/lib/reasoningRouting/policy.ts`. Migration 202 models a declared list of efforts per model, with a missing list meaning unknown. Herder gets that list from the executing app-server's paginated `model/list`. It selects the nearest declared level at or below the target, or the lowest declared level if all are higher. An unknown list leaves native effort unset. An explicit unsupported effort fails before turn submission.

OmniRoute migration 054 records the effective service tier for usage accounting and identifies Fast with priority. Task classification and quota gating belong to Herder. Fast requires a matching advertised tier and a positive recipient Codex quota decision. `latencySensitive` overrides the task's latency default and `serviceTier` takes precedence over both. A missing capability or quota confirmation selects normal. The existing admission guard can still refuse the operation entirely.

**Readback.** `settingsDecision` gives the selected effort, tier and reasons. `effectiveSettings` gives native model, effort, tier, sandbox and approval readback. Missing evidence appears as null. `session_settings` reads a loaded thread's settings. `model action=set` rejects extra fields and returns the native settings from the switch. Turn starts use a turn-only tier override. Steering an active turn keeps its settings.

A repeated local create with the same harness, canonical directory and unique name returns the original session ID with `alreadyExisted:true`. Remote named creates reuse the owner's durable intent receipt. If that receipt was interrupted, the owner can recover it by reading the unique native thread with the same harness, name and canonical directory. `ready` reports whether the owning adapter could read the exact session at that time. Retry the same identity after a lost caller response. A crash before the owner records a native ID can still require reconciliation. The separate Rust-native control protocol and scheduled-delivery overrides are outside this MCP policy.
