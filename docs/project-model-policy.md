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
- **One lookup finds the route of a directory.** Every caller that needs the
  route of a directory goes through one function, `findProjectModelRoute` in
  `src/project-model-policy.ts`. The launch permission and the model gate
  resolve the project of a session by the same rule, in this order:
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

- **The block key of a subdirectory becomes the root of the route.** A block of
  the form `project|<subdirectory>` stops firing, and a block of the form
  `project|<root>` starts to cover the subdirectories. The gate of the dispatch
  therefore has to check the union of the keys
  `{projectWorkKey(canonicalProjectKey(input.project)), projectWorkKey(root of
  the route)}`, so that the old block of the subdirectory and the new block of
  the root both fire and the fail-closed rule is not weakened.
- **The session key holds the root of the route.** The working folder of a
  launch of a routed project is forced to the root of the route, so a block of
  the form `opencode|<subdirectory>|<name>` stops matching: the directory of
  the session key is the root of the route.

## The resolvers of a project route

One lookup knows the containment of a directory. Every other resolver is a
thin wrapper over it, or a deliberate exception.

- `findProjectModelRoute` in `src/project-model-policy.ts` — the one lookup.
  It is the only place that knows the containment of a directory.
- `findModelPolicyRoute` and `findModelPolicyRouteForPath` in
  `src/project-model-policy.ts` — wrappers over the one lookup. The first is
  used by the model lists, the second by the tools gate.
- `findProjectRoute`, `findProjectRouteKey` and `findProjectRouteMatch` in
  `src/automation-launch-policy.ts` — wrappers over the one lookup. They are
  used by the launch permission, the web UI and the dispatch.
- `routeKeyOf` in `src/automation/project-launch-dispatch.ts` — a wrapper over
  the one lookup, so the attempt log and the receipt of a launch name the
  same route.
- `assertModelAllowedForDirectory` in `src/project-model-gate.ts` — resolves
  the route of a working directory through the one lookup.
- `resolveConfiguredProject` in `src/integrator-fleet-runtime.ts:382` — its
  own lookup, by exact key and declared alias only. It stays that way on
  purpose: its contract is a single route whose first harness is `codex`, and
  it is the only path that may create a session of that route. Giving it the
  containment of the one lookup would move a launch of a subdirectory into a
  route it did not ask for, and it would change the `project_route_ambiguous`
  answer into a silent choice. It changes only when the owner of that file
  agrees to it.

## Where the gate applies

One module decides, so a denied model cannot slip through another path:
`src/project-model-policy.ts` holds the rules and the one route lookup
(`findProjectModelRoute`), and `src/project-model-gate.ts` is the single gate
the callers use. The launch permission of `src/automation-launch-policy.ts`
uses the same lookup, so a directory can never be launched by one rule and
policed by another.

1. **Automatic launch** (`resolveProjectLaunch` in
   `src/automation-launch-policy.ts`). The route of the launch is the route
   found by the one lookup above, so a launch of a directory inside a routed
   project is governed by that project instead of falling back to the global
   profile. The effective model of a harness is
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
4. **Deliveries.** A session that was born outside herder's tools never passed
   through the tool gate: a session the user started in the app, or a session
   that a note delivery woke up. Such a session could still run a model the
   project forbids. Every delivery therefore checks the model itself, with the
   same rules: a delivery that names a model is checked against that model, a
   delivery that names none is checked against
   `route.models[harness] ?? policy.models[harness]` of the project of the
   session. The gate lives in `src/project-model-delivery-gate.ts` and covers
   the tools `send_message` and `deliver`, the local mesh delivery
   (`mesh_deliver` of the local mesh) and the delivery to another machine
   (`mesh_deliver` of the remote mesh). The refusal is the same error with the
   same code `model_not_permitted_for_project`, it names the project and the
   model, and it is not retryable: the mesh ledger keeps the refusal, so the
   same intent is never delivered again.

The tools receive the policy through a provider that reads the same stored
document as the launcher (`readLaunchPolicyForGate` in `src/index.ts`). The
delivery gate reads the same document with its **state**
(`readLaunchPolicyStateForGate`): a document that cannot be read is not a
permission, so every delivery is refused while it is broken.

### The work place of a session

The project of a session is its work place, and the work place is resolved the
same way everywhere:

- the **declared** work place of the session (the coordination store, written by
  `workspace_declare`) wins, because it is the directory the session really
  works in;
- otherwise the **own working directory** of the session;
- a harness that reports a **pseudo project** - one working directory for the
  whole runtime, as MiniMax Code does - does not know where its session works.
  Its work place stays unknown until the session declares it, and a delivery
  into such a session is refused while the policy restricts models anywhere.

Two answers are refused instead of guessed: a policy document that cannot be
read, and a work place that cannot be determined. A project **without a route**
keeps the global policy and is unaffected, and a policy without any model list
restricts nothing, so the gate stays quiet for a fleet that does not use the
feature.

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
