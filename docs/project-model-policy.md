# Per-project model policy

The launch policy decides where a project runs and with which model. This
document describes the per-project model lists: which models a project may run
on, and which models it must never run on.

## Where the lists live

Both lists belong to one project route of the launch policy document
(`automation-launch-policy.json`):

```json
{
  "version": 1,
  "allowedHarnesses": ["codex", "zcode", "opencode"],
  "preferredHarness": "codex",
  "models": { "codex": "gpt-6.1-sol", "opencode": "omniroute/minimax-combo-m3.1" },
  "projectRoutes": {
    "/home/roomhacker/ServersAdministartion": {
      "harnesses": ["opencode"],
      "models": { "opencode": "omniroute/minimax-combo-m3.1" },
      "aliases": ["omniroute-guard", "ServersAdministartion"],
      "allowedModels": ["omniroute/minimax-combo-m3.1"],
      "deniedModels": ["gpt-6.1-sol"]
    }
  }
}
```

- `allowedModels` — the model ids this project may run on.
- `deniedModels` — the model ids this project must never run on.

Both are optional. A missing or empty `allowedModels` means **no restriction**:
the global model of the harness decides, exactly as before this feature.

## The rules

- **Matching.** A model id matches an entry by exact comparison after trimming
  and ignoring the case, or by prefix when the entry ends with `*`. The entry
  `omniroute/minimax-*` therefore covers `omniroute/minimax-combo-m3.1`.
- **The lists name the route, not the catalog.** An entry of a list is the
  identifier of the route in the policy document, that is the `provider/model`
  of `models[harness]` or of `route.models[harness]`. It is never an
  identifier of the catalog of a runtime and never a leaf of a provider. The
  same route resolves to a different catalog identifier on every runtime: the
  route `omniroute/minimax-combo-m3.1` resolves to
  `minimax-code/mmcode/MiniMax-M3.1-Flash` on the 100, to the direct identifier
  on the 44 and on the MacBook Pro, and the catalog of opencode is empty on the
  88 while the opencode adapter is enabled. A list written with a leaf
  identifier therefore matches nothing: it refuses where the launch would have
  passed, and it stays silent where the runtime really runs the leaf. The gate
  compares the policy level identifier, so a list written with the route
  behaves the same on every runtime.
- **A denial always wins.** A model that matches `deniedModels` is never used
  in that project, even when it is also listed in `allowedModels`, and even
  when it is the effective model of a harness of the route.
- **A non-empty allow list is exclusive.** When `allowedModels` holds at least
  one entry, only those models may run in the project. Every other model is
  refused.
- **A project without a route keeps the global policy unchanged.** No new
  restriction is introduced for a project nobody configured.
- **A directory inside a routed project inherits the rules and the model of the
  project, but not its identity.** A directory inside a routed project is
  governed by that project: it inherits the allow list, the deny list, the
  harness and the model of the route that contains it. It does not become the
  project: the working folder stays the requested one and the work key stays
  its own. The two halves are decided by two different lookups, and the
  containment belongs to the model contour alone.
- **The model contour resolves by containment.** The model gate and the model
  resolution of the launch share one lookup, `findProjectModelRoute` in
  `src/project-model-policy.ts`, in this order:
  1. the exact canonical folder of the route
     (`/home/roomhacker/ServersAdministartion`);
  2. the same folder in another case
     (`/home/roomhacker/serversadministartion`);
  3. a declared alias of the route (`omniroute-guard`);
  4. and finally the route root that contains the directory
     (`/home/roomhacker/ServersAdministartion/src` is governed by the route of
     `/home/roomhacker/ServersAdministartion`).

  The order is fixed: a case variant of the key is nearer to the key than a
  declared alias, so it wins even when the alias is declared first.

  A directory inside a routed project is therefore governed by the rules of
  that project, and a session cannot escape them by starting in a
  subdirectory. The nesting is matched literally, because the production paths
  are case-sensitive, while the exact folder and the alias are matched
  case-insensitively.
- **The identity contour resolves without containment.** The lookup of the
  identity is `findProjectRouteIdentity` in `src/project-model-policy.ts`: the
  exact canonical folder, its case variant and a declared alias, and nothing
  else. A directory inside a routed project has no route of its own, so it
  keeps its own working folder and its own work key. The callers are
  `routeKeyOf` in `src/automation/project-launch-dispatch.ts`, which decides
  the working folder and the work key of a launch, and `findProjectRoute` in
  `src/automation-launch-policy.ts`, whose two callers
  (`src/web/server.ts` and `src/autopilot/unfinished-session-launcher.ts`)
  must not catch a subdirectory.
- **The root of a route is the canonical path of its key.** An alias resolves
  to the route of its key, but an alias is never a root itself: containment is
  only ever tested against the canonical path a route is configured under.
- **Containment is a segment boundary, not a string prefix.** The root `/a/b`
  contains `/a/b` and `/a/b/c`; it contains neither `/a/bc` nor
  `/a/b-backup`. A sibling project that starts with the same characters keeps
  its own route, or stays without one.
- **The longest containing root wins.** When several route roots contain the
  directory, the longest one governs it: the route of a subdirectory overrides
  the route of its parent project.
- **The result does not depend on the order of the keys.** At an equal length
  the lexicographically smaller canonical root wins, and the comparison is by
  code unit, so two documents with the same content resolve a directory to the
  same route whatever order their keys have.
- **A directory is canonicalized before it is matched.** The segments of the
  directory are resolved: the empty segments and the `.` segments are dropped
  and a `..` segment removes the segment before it, so `/a/b/../c` is `/a/c`.
  The root of a route is canonicalized by the same rule, so a directory that
  walks out of a route with `..` is matched against the route it really lies
  in and never inherits the lists of the route it left.

## The keys of a block

The route of a launch is the key of the route, and the key of a launch of a
directory inside a routed project is the root of that route. Two consequences
follow. Both are stated here before the gate is released.

- **The work key of a launch stays the identity of the requested directory.** A
  launch of the project root carries the key of the route, and a launch of a
  subdirectory carries its own path. A block of the form `project|<subdirectory>`
  therefore keeps firing, and a block of the form `project|<root>` does not
  cover the subdirectories.
- **The rules of the project still follow the root.** The model rules follow the
  containment, so the gate of the dispatch has to check the union of the keys
  `{projectWorkKey(canonicalProjectKey(input.project)), projectWorkKey(root of
  the route that governs the project)}`, so that the block of the subdirectory
  and the block of the root both fire and the fail-closed rule is not weakened.
- **The session key holds the requested directory.** The working folder of a
  launch is the requested one, so a block of the form
  `opencode|<subdirectory>|<name>` keeps matching the session of that
  subdirectory.

## The resolvers of a project route

Two lookups, with different rules. One knows the containment of a directory and
belongs to the model contour; the other knows the identity of a project and
belongs to the working folder and the work key.

- `findProjectModelRoute` in `src/project-model-policy.ts` — the containment
  lookup of the model contour. It is the only place that knows the containment
  of a directory.
- `findModelPolicyRoute` and `findModelPolicyRouteForPath` in
  `src/project-model-policy.ts` — wrappers over the containment lookup. The
  first is used by the model lists, the second by the tools gate.
- `findProjectRouteIdentity` and `findModelPolicyRouteIdentity` in
  `src/project-model-policy.ts` — the identity lookup: the exact canonical
  folder, its case variant and a declared alias, and no containment.
- `findGoverningProjectRoute` and `findGoverningProjectRouteMatch` in
  `src/automation-launch-policy.ts` — wrappers over the containment lookup.
  They decide the route of a launch and the model of that launch.
- `findProjectRoute`, `findProjectRouteKey` and `findProjectRouteMatch` in
  `src/automation-launch-policy.ts` — wrappers over the identity lookup. They
  decide which project a session is: the working folder and the work key of
  the launch, and the two callers that must not catch a subdirectory.
- `routeKeyOf` in `src/automation/project-launch-dispatch.ts` — a wrapper over
  the identity lookup, so the attempt log and the receipt of a launch name the
  project itself.
- `assertModelAllowedForDirectory` in `src/project-model-gate.ts` — resolves
  the route of a working directory through the containment lookup.
- `resolveConfiguredProject` in `src/integrator-fleet-runtime.ts:382` — its
  own lookup, by exact key and declared alias only. It stays that way on
  purpose: its contract is a single route whose first harness is `codex`, and
  it is the only path that may create a session of that route. Giving it the
  containment of the model contour would move a launch of a subdirectory into a
  route it did not ask for, and it would change the `project_route_ambiguous`
  answer into a silent choice. It changes only when the owner of that file
  agrees to it.

## Where the gate applies

One module decides, so a denied model cannot slip through another path:
`src/project-model-policy.ts` holds the rules and the two lookups, and
`src/project-model-gate.ts` is the single gate the callers use. The model
resolution of the launch uses the containment lookup, the same one the gate
uses, so a directory can never be launched by one rule and policed by another.

1. **Automatic launch** (`resolveProjectLaunch` in
   `src/automation-launch-policy.ts`). The route of the launch is the route
   that governs the project, found by the containment lookup, so a launch of a
   directory inside a routed project is governed by that project instead of
   falling back to the global profile. The effective model of a harness is
   `route.models[harness] ?? policy.models[harness]`. When that model is not
   permitted, the harness is skipped and the route moves to the next harness —
   the same treatment as an unavailable harness. When no harness of the route
   has a permitted model, the launch is refused with the explicit reason
   `model_not_permitted`, never a silent launch of a denied model. The
   dispatch reports it as a routing reason in
   `src/automation/project-launch-dispatch.ts`.
2. **Explicit model requests in the tools.** `create_session`, `new_or_resume`
   and `fleet_create_session` refuse a denied model before the session is
   created. `change_model` resolves the project of the session by its working
   directory and refuses a denied model there too. All of them resolve the
   project by the working directory, so a session in a subdirectory of the
   project is governed by the route of that project, and a route reached by an
   alias is enforced as well. The refusal is an error with the code
   `model_not_permitted_for_project`; the message names the project, the model
   and the lists that decided it.
3. **The model the project would use on its own.** When a tool names no model,
   the model the project would run on for that harness decides:
   `route.models[harness] ?? policy.models[harness]`. A project that forbids
   that model therefore refuses to start a session at all, instead of falling
   back to the default of the harness. The same rule applies to the
   `fallbackModels` of `new_or_resume`: a fallback is a model the project would
   run on, so the project rules apply to it too.

The tools receive the policy through a provider that reads the same stored
document as the launcher (`readLaunchPolicyForGate` in `src/index.ts`).

The receipt of a launch names the route that governed it. `routeKey` is the key
of the route, and `workspaceReplaced` states that the root of the route
replaced the requested working folder, which is the case for a directory inside
the root of a route. The fact is therefore readable from the receipt and not
only from the routing text. The `model` of the receipt is the identifier of
the route in the policy document, not the identifier the runtime puts into its
catalog: the same route resolves to a different catalog identifier on every
runtime.

## How the operator configures it

Everything is done in the web UI, on the **Projects** tab. For every project
card there is a **Модели проекта** block with two sections:

- **Разрешённые модели** — the models this project may run on. An empty list
  means "без ограничений".
- **Запрещённые модели** — the models this project must never run on.

Both lists are filled from the model catalog of the harnesses of the route
(`GET /api/models?harness=`) and accept any model id typed by hand, so a model
that is not in the catalog can be named as well. Every entry has a **Убрать**
button.

The block also shows the **effective model of every harness of the route**
(`route.models[harness] ?? policy.models[harness]`) and highlights a violation:
when that model is denied or is outside the allowed list, the operator sees
that the harness will stop being used in this project.

A model that is listed as allowed and as denied at the same time is ambiguous.
The form shows an error for it and the policy is not saved until the conflict
is removed.

The document is written through the existing `PUT /api/automation/launch-policy`
with the `If-Match` ETag of the read document. A concurrent change of the
document in another tab is not overwritten: the edit stays in the form and the
usual conflict message is shown. The merge of a concurrent change is per part,
so an edit of the model lists does not overwrite a route change made at the
same time, and the other way round. A change of the same part on both sides is
a real conflict and is reported.

## Validation

The document is validated on every write:

- an entry must be a nonempty model id of at most 256 characters;
- an entry must not contain control characters;
- one list holds at most 64 entries, and no entry repeats inside it;
- one normalized entry cannot be allowed and denied at the same time.

## Compatibility

`allowedModels` and `deniedModels` are optional parts of a route. An older
editor that does not know them omits them, and the stored lists are preserved
on the next write — the same way the operator cohort guard of a route is
preserved. A project that has no lists behaves exactly as before.
