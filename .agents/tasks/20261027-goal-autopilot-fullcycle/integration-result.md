# Integration worker result

Scope: existing Autopilot Stop/background controller and judge adapter. No runtime, default model, OAuth server, publication, or deployment changes.

## Integrated

- An armed, exact session goal enters `evaluateArmedGoal` from the existing controller; a per-session goal works with the global legacy selector disabled. `HumanStop`, explicit session disable, and disarm remain gates. `on` resumes that saved objective; `off` stops it.
- The immutable goal snapshot supplies the full primary event stream. Stop-hook `lastUserMessage` and generated continuation text are never ingested as goal amendments. The owner API records an exact native message cursor at arm time. The native background path validates and advances only the bounded delta after that cursor against accepted goal events and generated-prompt receipts; a missing cursor anchor or unknown human input blocks evaluation. An explicitly armed empty session is allowed when its exact baseline is empty.
- Existing configured judge base URL/model are used unchanged. Results disclose configured provider and model with `subscription: false`; this is not native Codex Goals or a Codex subscription adapter. Stage-specific strict JSON contracts cover extraction, evidence reconciliation, next action, and final coverage/supersession audit. Provider-reported token usage is persisted only when valid usage fields are returned; no cost or cache savings are claimed.
- Evidence collection reads only explicit human-declared file refs from events that are provenance-linked to each requirement, inside the exact project tree, with bounded stable reads. Unavailable file refs and unsupported materials are passed as incomplete audit materials; no generated path discovery, tool-text evidence, or model-created evidence is used.
- Requirement projection and evaluation metadata use CAS against the pre-evaluation fence. A completion candidate is not applied in the runner: the existing background job performs a second native idle/history fingerprint, exact Codex native-Goals admission check, policy and HumanStop checks, goal-fence check, rereads declared files and compares SHA versions, then applies the one-use completion ticket. New input, stop, evidence change, policy change, native Goals activation, or a changed native session makes the result stale.
- Background continuation retains the existing job and delivery idempotency path, records the generated prompt in HumanStopStore, and rechecks the goal fence plus native input history immediately before delivery. A per-goal admission lock serializes native admission against accepted human input; accepted/UNKNOWN outcomes store action/evidence fingerprints. An unchanged repeated action with unchanged primary revision and evidence is stopped visibly. No total budget, scheduler, or extra controller was added.
- Native Goals admission is read-only and exact-thread scoped. Codex active/paused/unknown native Goals block this controller; OpenCode and ZCode are admitted; unsupported harnesses fail closed. The gate runs before evaluation and again at native admission. No native Goals state is modified.

## Native control-plane research

Codex has a supported `thread/read` full-turn route in the existing `CodexAppServerAdapter`/`getSessionMessages` path, with ownership and history-availability checks. The shared HarnessAdapter history path is bounded and does not certify arbitrary full-history coverage. This repository does not expose a supported Codex-subscription judge/control adapter for this Herder controller. I did not create a second native Goals controller or claim subscription routing. The configured judge route is explicitly displayed as the configured provider/model.

## Checks

- `npx tsc --noEmit --pretty false` — passed after the root-owned goal API exports were present.
- Focused goal evaluation, evidence collector, and store tests — 15 passed.
- No live session, provider request, runtime, or deployment was exercised.

## Remaining integration boundary

The authenticated owner API/UI must supply the complete initial human objective and explicit file refs, then accept amendments with stable input identity before native delivery. Stop-hook text is intentionally not a substitute. End-user browser acceptance remains outside this worker's scope.
