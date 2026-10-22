# Per-project model policy in Agent Herder — worker task note

Session: `mvs_279c034457e244f1babd9b0ed3ba94a4` (worker).
Coordinator: `mvs_91586e10a9f94982aaab486d7e45798e` (Projects contour + per-project model policy).

## Original request

Owner request (via coordinator): make the Agent Herder "Projects" tab self-sufficient —
for every project the operator must be able to set, through the web UI, which models are
allowed and which are forbidden for that project, and the restriction must actually hold:
a forbidden model must not reach the launch.

## Result — delivered and merged

The feature is in `origin/main` of `megamen32/agent-herder`:

- `9cbe389` — `feat(projects): per-project allowed and denied model policy`
  (the original local commit `f6019ea`, rebased by the coordinator).
- `72827a0` — `fix(projects): gate the model a project would use on its own`
  (follow-up: a session started without an explicit model fell back to the harness
  default; the effective project model is now gated too, and `new_or_resume` fallback
  models are gated as well). Rebased on the branch as `d72dacf`.

Merged into `main` through `8f724b3`; `main` HEAD `faab6df` contains both.
The live UI release on server-100 is `faab6df`, so the feature is in the published UI.

### Files owned by this worker

New:
- `src/project-model-policy.ts` — the matching rules (browser-safe, no node imports).
- `src/project-model-gate.ts` — the single gate every caller uses.
- `docs/project-model-policy.md` — fields, semantics, where the gate applies.
- `tests/project-model-policy.test.ts` — 28 tests.
- `tests/project-model-gate-tools.test.ts` — 9 tests over the real MCP tools.

Changed:
- `src/automation-launch-policy.ts` — `allowedModels` / `deniedModels` on the route,
  validation, normalized output, preservation in `store.replace()`.
- `src/automation/project-launch-dispatch.ts` — routing reason for the refusal.
- `src/mcp/session-tools.ts` — gate on `create_session`, `new_or_resume`, `change_model`.
- `src/mesh/fleet-node.ts` — gate on `fleet_create_session`.
- `src/index.ts` — the policy provider for the tools.
- `src/web-ui/launch-policy-settings.tsx` — route type, parsing, comparison, merge parts,
  model catalog hook.
- `src/web-ui/projects-settings.tsx` — the "Модели проекта" block, per-part merge,
  known-project paths.
- `src/web-ui/styles.css` — the `projects-model-*` styles.
- `tests/projects-settings.test.ts` — merge and form assertions.
- `README.md` — one paragraph in the existing launch-policy section.

### Behaviour

- Denied model: never used in the project, even if also allowed or the harness default.
- Non-empty allow list: exclusive.
- Empty or absent allow list: no restriction, the global harness model decides.
- Matching: exact after trim, case-insensitive, or prefix when the entry ends with `*`.
- `resolveProjectLaunch` skips a harness whose effective model is forbidden and refuses
  explicitly with `reason: "model_not_permitted"` when no harness is left.
- The explicit model tools refuse with `model_not_permitted_for_project`.
- A project without a route keeps the global policy unchanged.

### Verification

- `npx tsc --noEmit` — clean.
- `npx vite build --config vite.config.ts` — builds; no node module reached the browser bundle.
- New tests use `os.tmpdir()` and pure functions; they do not depend on
  `/home/roomhacker/...` and are green on any host.
- Baseline comparison (macOS, environmental red is pre-existing): before 16 failed files /
  57 failed tests; after 15 failed files / 56 failed tests. No new red file, no new red test.
- Pointed run over the 7 affected files: 114 tests, all green.

## Left open — needs the coordinator's decision

1. **Live policy on server-100** was not migrated: the live
   `automation-launch-policy.json` has no `allowedModels` / `deniedModels` for any project.
   Migration is the runtime owner's work (`mvs_03faeb0f1aa74d1093d6b2088b16a421`), through
   `PUT /api/automation/launch-policy` with `If-Match`.
2. **Default policy for new projects**: an empty allow list means "no restriction". If the
   owner wants new projects to start from an allow list, that is a product decision.
3. **Global `change_model` without `sessionId`** is not gated: there is no project session,
   and the global harness model does not belong to a project. Needs an owner ruling.
4. **Model contract alignment**: the model/route contract is owned by
   `mvs_c9470a6497b04f2682693d2c437e3dc4` (free-form route, refusal of the paid
   `minimax-coding-plan/*`). This worker's policy reads the same document and never
   introduces a route of its own; a denied model is a project-level rule on top of it.
   Any change to the model catalogue or route rules belongs to that owner.

## Coordination notes

- `mavis session send` is unavailable on this machine: `/Users/user/.minimax/bin/mavis` is a
  broken symlink to `.../resources/daemon/cli.js`, which no longer exists after the app was
  repackaged into `app.asar`. Messages therefore go through the shared chat file channel.
- Agent Herder does not index native MiniMax Code sessions, so it is not a usable channel
  between these sessions.
