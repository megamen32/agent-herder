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

The tools receive the policy through a provider that reads the same stored
document as the launcher (`readLaunchPolicyForGate` in `src/index.ts`).

The receipt of a launch names the route that governed it. `routeKey` is the key
of the route, and `workspaceReplaced` states that the root of the route
replaced the requested working folder, which is the case for a directory inside
the root of a route. The fact is therefore readable from the receipt and not
only from the routing text.

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
