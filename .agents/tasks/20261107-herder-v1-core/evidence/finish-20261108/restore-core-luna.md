# Restore core — Luna

## Consumer contract handoff and ownership

Terra handoff (reported by parent): the configured Rust owner profile currently
serves only node `100`; `automation/list` is advertised but unsupported; the
old NoticePlace launch-policy route on `127.0.0.1:18787` is refused; and the
existing workspace `new_or_resume` route is missing. Terra owns
`tests/v1-restored-workflows/**` and `restore-contracts-terra.md`; do not edit or
duplicate those paths. Its read-only readiness checks are the accepted RED
baseline. The handoff report itself is not present in this checkout yet, so
these facts are attributed to the parent-provided handoff, not independently
re-audited.

## Exact implementation route

1. **Child completion / autowake — Luna (`crates/herder/**`).** Add a typed
   completion decision adjacent to existing `domain::adapter` and durable
   `store::lineage`/`store::intents`. The application boundary must resolve
   exact child→parent lineage, authenticated principal and current HumanStop;
   atomically admit one completion event/effect receipt; then call the existing
   native delivery port once with a deterministic request key. UNKNOWN remains
   terminal for replay and reconciliation uses the existing receipt pattern.
   Current public `human_request` only creates a request; completion callback
   and parent wake are not wired. New `domain::completion::transition_completion`
   is the initial decision API, not a completion claim.
2. **Cross-host management — Terra launcher/profile; Luna core API.** Keep
   `InstanceRef {node, instance_id}` as the routing identity. Extend trusted
   owner-profile composition to multiple explicitly configured instances and
   resolve remote reads/delivery through the existing AHAP adapter registry.
   Never infer a remote instance from host names or client-supplied native IDs.
   `owner_opencode.rs` currently reports only `configured_owner_instance`;
   list/read/deliver composition is the missing core integration. Terra owns
   launcher/profile and its consumer tests; Luna owns domain/application/store
   semantics under `crates/herder/**`.
3. **NoticePlace repair — Luna core contract; HTTP consumer adapter only after
   exact file ownership is assigned.** Preserve launch-policy admission,
   source deduplication, named binding and operation receipts; route the
   selected repair session through the same durable create/deliver ports.
   Current automation catalog is schema-only and no automation handler exists;
   old policy endpoint is unavailable. Do not proxy arbitrary REST or add a
   scheduler. Required API boundary is a typed policy snapshot + incident
   event -> create/deliver effects and durable receipt. Exact legacy HTTP
   handler/adapter files are outside Luna's current ownership.

## First slice API and result

`domain::completion::{CompletionState, ChildCompletion,
CompletionEffect::WakeParent, transition_completion}` decides whether a
confirmed child completion admits one wake. It returns the unchanged state and
no effect for unconfirmed/empty events, roots, duplicates, and HumanStop; an
accepted event returns a stable `child-completion:<event_id>` request key.
Focused crate tests: 3 passed. This API is only the pure decision portion; the
required next slice is its durable application/store wiring and public ingress.

## Realistic remaining effort (current owner estimate)

- Completion event ingress + durable single-winner receipt + gated delivery:
  45–75 min, plus 10–15 min focused recovery/negative tests.
- Cross-host profile/adapter composition and target-bound list/read/deliver:
  45–90 min core; Terra launcher and actual consumer readiness are separate.
- NoticePlace typed policy/incident core contract and receipt path: 45–75 min;
  external HTTP adapter ownership and live consumer proof are separate.
- Integrated real-consumer proof for all three: 30–60 min after exact profiles,
  ingress and consumer adapter are available.

Estimate excludes integration/deploy and external consumer-file changes.
No runtime or installed configuration was changed. No model fallback was used.

## Working tree notes

Owned source paths at this checkpoint: `crates/herder/src/lib.rs` and
`crates/herder/src/domain/completion.rs`. Foreign untracked
`deploy/fleet/owner-bootstrap/target/` is preserved. The completion tests are
GREEN; public ingress and durable effect receipt are NOT implemented yet.
