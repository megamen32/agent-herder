# Adviser package: Agent Herder UI completion architecture

Role: Adviser
Status: todo
Owner: L
Allowed paths: `/home/roomhacker/agents-projects/agent-herder`
Excluded: edits, deployment, restart, secrets, security/ACL, database, observability.

Goal: independently identify the minimum complete architecture and product seams needed for truthful all-tab status plus skill discovery/add/enable UX.
Acceptance check: report current UI/API topology, hidden architecture decisions, recommended vertical slices, business canary, risks, and what must not be claimed.
Model/budget: gpt-5.6-sol, high, 30/60/120 active minutes, relative cost medium.
Stop: return NEEDS_REDECOMPOSITION if canonical product or scope is ambiguous.
Report contract: append detailed evidence here; return only a concise TL;DR to L.

## Adviser report — 2026-08-09

### Result

`NEEDS_REDECOMPOSITION`

The existing source is sufficient to identify the minimum architecture seams,
but not to define a truthful "all-tab" completion target. The checked-out
product has no tab model and no skill domain, and the checkout is not on the
configured canonical `main`. L needs a product-boundary decision before a
Worker can safely turn this into one implementation package.

### Bounded question

What minimum UI/API architecture is required to make status truthful across
the product and to support skill discovery, add, and enable as distinct user
journeys, given the current Agent Herder code?

### Repository state and evidence boundary

- Inspected checkout: branch `agent/session-lineage-tools`, HEAD `28aa548`.
  Local `main` is `d5e7db2` and `origin/main` is `7bb4072`; therefore the
  inspected feature set must not be called canonical-main behavior without an
  explicit branch decision.
- Existing `graphify-out/graph.json` was queried first. It identified
  `src/web/server.ts`, `src/index.ts`, `src/adapter-registry.ts`, shared types,
  adapters, and HTTP/UI tests as the relevant topology. Every material claim
  below was then checked against those files directly.
- Focused current-code proof: `npx vitest run tests/adapter-registry.test.ts
  tests/http-api.test.ts tests/web-ui.test.ts tests/lazy-polling.test.ts`
  reported 8 files and 32 tests passed. This proves the current fake-backed API
  contracts and static HTML assertions only, not a live all-tab or skills flow.

### Current UI/API topology

1. Process composition
   - `src/index.ts:52-90` creates one mutable adapter map, one persisted
     `AdapterRegistry`, factories for six built-in harnesses, and definitions
     whose default enablement originates in environment gates.
   - `src/index.ts:98-255` initializes adapters with adapter-specific eager or
     lazy behavior. The same mutable map is consumed by MCP and web paths.
   - `src/index.ts:522-557` loads persisted registry state, initializes
     adapters, then serves one HTTP UI/API and one stdio MCP server from the
     same process.

2. UI shape
   - There are no application tabs. `src/web/index.html:609-702` is one static
     page containing global filters, a collapsible adapter-enrollment panel, a
     collapsible named-session form, a session tree, and a selected-session
     detail pane. Mobile view switches only between `tree` and `detail`.
   - Client state is local in-memory state for `sessions`, `adapters`, and the
     selected session (`src/web/index.html:705-752`). There is no route/store
     boundary for tabs or resource domains.
   - Adapter cards call `GET /api/adapters`; their button is labelled `Add` or
     `Disable`, but the operation is actually adapter enable/disable
     (`src/web/index.html:775-799`). This existing `Add` must not be reused as
     evidence of skill installation.
   - The 2-second timer refreshes sessions and selected details only
     (`src/web/index.html:1612-1619`). Adapter status refreshes on initial load,
     explicit refresh, filter refresh, or adapter mutation through
     `refreshAll`, so it is not continuously observed.

3. HTTP contracts
   - Adapter inventory and mutation are only `GET /api/adapters` and
     `POST /api/adapters/:id {enabled}` (`src/web/server.ts:46-63`).
   - Sessions use list/create/new-or-resume, detail, and action endpoints
     (`src/web/server.ts:122-220`); conversions are separate
     (`src/web/server.ts:222-243`).
   - No `/api/status`, `/api/skills`, catalog, install/add, enable-scope,
     operation-receipt, or reconciliation endpoint exists. A repository search
     outside task/graph artifacts finds no skill model or implementation.

4. Status sources
   - Session status is a five-value shared union (`running`, `idle`,
     `needs_input`, `stopped`, `error`) in `src/types/common.ts:5-10`, but each
     adapter infers it differently. Examples: Hermes currently returns `idle`;
     ACP starts from `idle`; Qoder and file-backed Codex/Claude commonly reduce
     state to running/stopped; OpenCode catches failure of its status endpoint.
     Thus a common label does not imply a common observation guarantee.
   - `SessionSupervisor.listSessions` omits an unready lazy adapter unless it
     supports lazy discovery (`src/session-supervisor.ts:64-90`). Omission is not
     represented as a provider-level degraded/unknown result in the session
     response.
   - Adapter status is derived from desired `enabled`, map membership `active`,
     optional `isReady()`, and an in-memory error map
     (`src/adapter-registry.ts:69-85`). It has no probe timestamp, status source,
     freshness/TTL, transition, or reason code.

### Truthfulness gaps that affect architecture

- `status: "active"` means an adapter object is present, even when
  `ready: false`; the UI renders this as `active · sleeping (lazy)`. This is a
  lifecycle description, not proof that the external runtime is reachable.
- If an adapter does not implement `isReady`, registry `ready` is true whenever
  an object exists. That is capability-by-absence, not an observed readiness
  probe.
- Startup failures in `initAdapters` remove several adapters from the live map
  but do not feed the failure into `AdapterRegistry.errors`. Persisted
  `enabled: true` can therefore be paired with `active: false` and the derived
  string `disabled`, hiding the actual initialization failure.
- Hermes and ZCode are lazy and do not declare lazy discovery. While sleeping,
  the supervisor omits them from session listing; absence of sessions therefore
  cannot mean absence of sessions in the owning runtime. Codex has a separate
  safe file-backed lazy-discovery path, so the semantics differ by provider.
- Declared control capabilities are rendered as availability, but they carry no
  observed/versioned provenance. Session action gating is also inconsistent:
  Resume is enabled from session state alone, while stop/cancel/recover/fork
  consult capability flags (`src/web/index.html:1069-1103`).
- Existing tests prove fake adapter success/failure, HTTP shapes, and HTML
  substrings (`tests/adapter-registry.test.ts:21-43`,
  `tests/http-api.test.ts:72-164`, `tests/web-ui.test.ts:6-81`). They do not run
  browser interactions against a real harness or prove status freshness.

### Hidden product and architecture decisions L must surface

1. Canonical delivery source: current feature branch, local `main`, or
   `origin/main`. Their histories differ.
2. Information architecture: the exact tabs, their ownership, and what
   "all-tab status" means. The present product has only tree/detail views.
3. Skill identity and source of truth: runtime-native catalogs, local
   filesystem skills, remote registries, or a merged catalog; stable key must
   include source/provider and version, not display name alone.
4. Lifecycle vocabulary: `available`, `added/installed`, `enabled`, `loaded`,
   and `usable` are separate states. Decide whether "Add" copies an artifact,
   registers a source reference, or only flips configuration.
5. Enablement scope: Agent Herder global, one harness, one workspace/project,
   or one session. Persisted desired state and runtime-observed effective state
   must both be represented.
6. Status contract: distinguish desired/configured, process attached,
   reachable, ready, degraded, error, stale, and unknown; define timestamps,
   TTL, source, reason codes, and whether a probe may wake a lazy transport.
7. Operation model: synchronous mutation versus an operation resource with
   phases and receipts. Installation and runtime reload can outlive one HTTP
   request and can partially succeed, so a bare boolean is not a truthful
   general contract.
8. Reconciliation ownership: whether Agent Herder is authoritative or only
   observes runtime-owned configuration changed by other tools. Without this,
   multi-writer drift will be misreported as success or failure.
9. Failure and rollback semantics: what happens when add succeeds but enable or
   runtime load fails, and whether disable preserves installed data.

### Minimum vertical slices after those decisions

This is a dependency order, not a selection among the unresolved product
choices.

1. Status contract and one adapter end to end
   - Introduce a shared resource envelope containing desired state, observed
     state, `checkedAt`, source, stale flag, and reason/error.
   - Make one adapter expose a non-waking status probe and return it through a
     versioned status/API contract.
   - Render loading, empty, stale, degraded, error, disabled, sleeping, and
     ready distinctly. Do not infer reachability from map membership.

2. Tab/router shell and resource-state UX
   - Define exact tab IDs/routes and isolate each tab's loading/error/empty/data
     state. Preserve selection in URL/history as the current session detail
     does, rather than adding more global mutable state.
   - Add one aggregate status summary derived from resource envelopes; tabs
     must not manufacture their own incompatible labels.

3. Read-only skill discovery for one selected provider
   - Add `SkillDescriptor` with stable source-qualified ID, version, provenance,
     compatibility, install state, enable state/scope, and observed timestamps.
   - Add a provider interface and read-only catalog endpoint first. Keep catalog
     availability separate from locally installed inventory.

4. Add/install for that provider
   - Add a command endpoint returning an operation ID/receipt. Re-read installed
     inventory before marking success. Record destination and version in the
     receipt without leaking file content or credentials.

5. Enable/disable for one explicit scope
   - Persist desired enablement independently of installation. Reconcile with
     the runtime and report both desired and effective state. Disable should not
     silently uninstall.

6. Provider expansion and aggregate status
   - Only after one full slice is proven, add provider drivers and capability
     descriptors. Unsupported add/enable actions must remain explicit rather
     than being rendered as failed generic operations.

### Business canary required for acceptance

Run against an isolated, disposable Agent Herder instance and one real selected
skill provider after the hidden decisions are resolved:

1. Open every defined tab and verify each has an explicit loaded, empty, stale,
   or error state with no silent blank panel.
2. Make one adapter/provider unavailable without removing its configuration.
   Verify it remains visible as configured-but-unreachable/degraded with a
   fresh timestamp and reason; verify the Sessions view explains any omitted
   inventory rather than implying zero sessions.
3. Discover a known skill that is not installed. Add it and require an
   operation receipt plus inventory re-read; it must appear installed but not
   enabled if those are separate selected semantics.
4. Enable it for the selected scope. Re-read persisted desired state and the
   runtime's effective inventory, then exercise one harmless, read-only
   capability through the real consuming harness.
5. Disable it and prove installed data remains while effective availability is
   removed. Confirm unrelated sessions/adapters are unchanged.

A fixture-only API test is useful regression proof but is not this business
canary. If persistence across process lifetime is a selected claim, repeat the
readback after restarting only the disposable instance; production restart is
outside this advisory scope and remains an authorization boundary.

### Risks

- A generic "skill" abstraction may erase provider-specific install and load
  constraints; capability descriptors are safer than pretending every provider
  supports every command.
- Polling all providers every two seconds could wake lazy transports or create
  expensive/noisy health checks. Status freshness needs per-provider policy.
- Combining desired and observed state into one status recreates the current
  misleading `active/sleeping` condition.
- Using display names as identity can install or toggle the wrong same-named
  skill from another source or version.
- Optimistic UI mutation can claim success before disk/runtime reconciliation.
- Adding tabs before defining domain ownership will spread current global state
  and polling races across more surfaces.
- Branch ambiguity can make completed work land on a non-canonical line and
  invalidate acceptance against `main`.

### Claims that must not be made from current evidence

- "All tabs are complete" — there is no tab architecture or enumerated tab
  contract in the current product.
- "All harness status is live/truthful" — status semantics, freshness, and
  lazy omission differ by adapter.
- "Active means reachable/ready" — it currently means map membership.
- "No sessions means the harness has none" — lazy unready providers may be
  skipped.
- "Skills can be discovered, added, or enabled" — no skill domain/API/UI exists.
- "Add and enable persist/effectively load a skill" — no operation receipt or
  runtime readback exists.
- "Green tests are end-to-end acceptance" — the focused suite is fake-backed
  and HTML-string based.
- "The inspected code is canonical main" — HEAD and both main refs differ.

### Decomposition request to L

Create separate selected work items only after the human names: (a) canonical
branch/commit, (b) exact tab inventory, (c) first skill provider/source,
(d) add/install semantics, and (e) enablement scope. The first implementation
item should be the status contract plus one adapter vertical slice; skill
discovery/add/enable should be a second package only when its provider boundary
is concrete.
