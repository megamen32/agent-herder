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
- **The route is found by path or by alias.** A project is recognized by its
  absolute path, case-insensitively, and by any alias declared for the route.
  A session that runs in a subdirectory of the project is governed by the route
  of that project.

## Where the gate applies

One module decides, so a denied model cannot slip through another path:
`src/project-model-policy.ts` holds the rules, and `src/project-model-gate.ts`
is the single gate the callers use.

1. **Automatic launch** (`resolveProjectLaunch` in
   `src/automation-launch-policy.ts`). The effective model of a harness is
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
