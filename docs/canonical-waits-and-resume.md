# Canonical waits and resume compatibility

This document describes source integration and its explicit migration boundary. It does not claim that any shared runtime or scheduler has been switched. The overall deployment and native canary status belong in the process-leases runtime and implementation runbooks.

## Native API and identity

The facade uses the existing `automation`, `session`, `deliver` and `compat_task` tools. It adds no public tool names. Read-only `session.resolve` accepts an explicit harness, native session ID and optional exact node. It returns one registered SessionRef and its owner identity. Missing, ambiguous or inaccessible bindings are typed errors. Resolution reads canonical bindings and ACLs, works while HumanStop is held, and never asks a native adapter to create or discover a session.

An admitted timer has this shape:

~~~json
{
  "action": "create",
  "session_ref": "<registered waiting session>",
  "request_key": "<stable request identity>",
  "rule": {
    "kind": "timer",
    "trigger": {"kind": "delay", "delay_ms": 60000},
    "wake_message": "Read the completed operation and continue."
  }
}
~~~

An absolute trigger is `{"kind":"at","at":"2026-12-01T12:00:00Z"}`. The due instant belongs to first durable admission. Repeating the same request after its due time returns the existing record; it does not compute a new delay or reset the timer. A changed payload under an existing request key conflicts.

For dependencies, use `rule.kind: session_completion`, `dependencies: [<registered SessionRefs>]` and `wake_message`. There must be 1 to 32 unique dependencies. The authority captures exact owner, authority/scope generation and native turn identity for each dependency. Missing native turn evidence is refused, including an idle-only projection. Completion records preserve completed, failed, interrupted or cancelled outcomes; they do not recast every terminal turn as success. Self-dependencies and cross-profile cycles are rejected before the rule is recorded.

`automation.get` reads `rule_ref`; List requires a complete observation. `automation.delete` with exact `revision` cancels the wake and preserves the idempotency tombstone. Cancellation cannot erase a previously admitted UNKNOWN handoff. A paused wait also continues to block automatic work. No compatibility endpoint can authorize a stopped session by supplying a human timestamp.

The shared automation driver owns admission, due/dependency checks, HumanStop fencing, busy-session deferral, native dispatch and receipt recovery. The facade never starts a second sweep loop. `deliver.receipt` reads the exact canonical request/task binding, and `compat_task.get` can reconcile that already admitted task. Neither call creates a new delivery. A lost native response remains UNKNOWN until matching receipt evidence exists.

## Automatic continuation capability

The verified OpenCode v2 runner advertises `nativeAutomaticContinuation: unsupported-no-idle-admission-v1`. In the isolated native acceptance attempt, one canonical wake produced two assistant turns: a Hindsight synthetic input ran before the original queued user input was promoted. The inspected native prompt/inbox API has no atomic idle/turn condition for existing-session admission. Hindsight already inserts its synthetic input with `resume:false`; changing the global hook or replacing Queue with Steer does not establish safe admission.

The canonical core therefore rejects automatic ProcessCompletion, Timer and SessionCompletion admission for this capability before starting a process or binding a resource. Direct canonical resume also checks the authoritative capability before a send. Explicit Queue, Steer and fresh-session Start keep their own contracts. The fresh-start marker remains `nativeStartAdmission: steer-before-turn-v1`. This is a restriction for the observed v2 protocol, not an assertion about uninspected native families. A future implementation must prove a supported atomic admission path before enabling automatic continuation.

Local legacy TS gates also read pending timer/session waits from `automation:canonical-wait:<principal>` in the existing protected database. Registration blocks before WaitState exists. Confirmed clears only with its exact confirmed delivery intent. Cancelled clears only when there is no unresolved handoff; UNKNOWN, admitted, prepared, paused and rejected remain blocked. These checks neither execute the automation driver nor call a native session reader.

## One canonical backend for timers and scheduled delivery

`src/resume-after-runtime.ts` selects its implementation once from trusted configuration. Legacy mode retains the previous scheduler until an explicit reviewed cutover. Canonical mode uses `src/resume-after-canonical.ts`, a stateless facade over the selected native AgentHerder. Its `start()` opens no interval, event subscription or writable registry. `resume_after`, scheduled delivery and the existing project/human-request seams share the `ResumeAfterBackend` interface.

Canonical registration sends `automation.create` with a Timer rule or SessionCompletion rule. Timer delay is admitted and converted to a due instant only in the native authority. Dependencies resolve to exact scoped SessionRefs through `session.resolve`; the native authority captures real native turn identities and validates cross-profile cycles. Session idle alone is not a completion proof. A stable compatibility request key excludes the migration epoch, so a lost response, facade restart or epoch rotation cannot create another timer. Get/List read the same records; cancellation uses revision CAS and retains the tombstone.

HumanRequest-bound waits remain explicitly unsupported in canonical mode until their arbitration authority is migrated. They do not fall back to the former scheduler or treat a human-request timestamp as permission to clear HumanStop. Scheduled delivery requires an explicit harness and native session identity and does not discover or wake a local adapter just to resolve that target.

Set the canonical mode only after preparing and reviewing the pinned configuration:

~~~text
AGENT_HERDER_CANONICAL_MODE=canonical
AGENT_HERDER_CANONICAL_CONFIG=<private absolute canonical configuration>
AGENT_HERDER_CANONICAL_CONFIG_SHA256=<SHA256 of those exact bytes>
AGENT_HERDER_FLEET_MESH_CONFIG=<existing approved GPTAdmin client config>
AGENT_HERDER_FLEET_CREDENTIAL_PIN=<existing approved binding generation>
~~~

The configuration has this schema. Placeholder values below describe evidence that must be obtained; they are not an activation receipt.

~~~json
{
  "version": 1,
  "mode": "canonical",
  "epoch": "<reviewed migration identity>",
  "authority": "mcp:shell:roomhacker-server-100:AgentHerder",
  "writer_drain": {"path": "<private reviewed drain proof>", "sha256": "<digest>"},
  "resume_after": {"directory": "<original legacy wait directory>", "snapshot": "<private immutable inventory>", "sha256": "<digest>"},
  "resume_receipts": {"path": "<original ReceiptLedger file>", "snapshot": "<private immutable inventory>", "sha256": "<digest>"}
}
~~~

`node_ref` is optional and must be an exact owner-profile node, not a guessed ShellMCP host alias. `resume_receipts` is required by direct AgentResumeClient compatibility. When present it also participates in the wait admission barrier. All configured paths are canonical, private and owned by the runtime user; symlinks, shared permissions, hard links, inode replacement, changed digests and unbounded files are refused. Changing configuration or the pinned credential under an existing client invalidates it.

The common client calls only the exact native authority over the existing Fleet GPTAdmin transport. Its explicit native protocol mode accepts a bounded allowlist of scoped native DTOs and rejects other targets and legacy delivery fields. It does not call the legacy `model_quotas` tool on the native 14-tool endpoint. Recipient Codex quota enforcement remains in AHAP immediately before native consuming writes. Ordinary Fleet callers retain their existing quota preflight. Typed domain payloads and non-submission errors survive transport envelopes without recursively stripping an ordinary `result` field.

Canonical TS judges and continuation fences always query `automation.wait_status` through this same sealed authority, covering ProcessCompletion, Timer and SessionCompletion. A separate local selector or an empty store cannot establish absence. A conflicting explicit route, incomplete/unconfigured response, failed migration barrier or unavailable authority blocks before model work. There is no second clock, registry, remapping, alternate credential, local fallback or retried send.

## Retained state is evidence, not an import queue

`src/canonical-migration.ts` reads the original legacy wait files against an immutable inventory. The wait directory is sealed mode 0500 with its device/inode recorded, and each original JSON file is mode 0400 with an exact hash. The inventory lists every file. Extra entries, missing records or changed bytes block activation. Retained records remain queryable with their original outcome and explicit `migration.retained` / `dispatchBlocked` metadata. The facade never imports, rewrites, cancels or dispatches them.

The pinned writer-drain proof records the actual hostname, platform, source inventory, previous writer executable digests, PID/boot/start identities and provider observations that those identities exited. Linux activation independently checks that none of the exact prior process identities is still live. File permissions alone are insufficient: an old writer may have already passed its save-before-send point and still finish native handoff. The proof must cover all writers and every configured retained wait/receipt source. Darwin activation requires a corresponding reviewed birth-identity verifier; the current migration verifier rejects it explicitly even though the native Darwin process worker is supported separately.

New canonical admissions remain blocked while a retained wait is pending, dispatching, UNKNOWN or lacks positive settlement evidence. A legacy `cancelled` label alone does not prove non-submission. A completed accepted receipt, or an explicit rejection receipt proving no admission and no admission uncertainty, can settle the retained wait. Exact retries of a retained key return that retained result and never replay it. Direct compatibility reads the sealed former ReceiptLedger and reserves every old idempotency key, including UNKNOWN. Reconciliation must supply real old-operation evidence before a new epoch can become ready; this code provides no fake import or mass-wake operation.

Source changes and passing fixture tests do not activate this migration. The retained 47 unknown jobs, active writer inventory, native automatic-admission capability and installed consumer checks remain rollout gates until independently reconciled.

## Paired production cutover

The public native MCP child and the existing TypeScript `agent-herder.service` are separate installed surfaces. Updating only the native selector would leave an older TS scheduler able to continue an agent without consulting canonical process waits. `deploy/fleet/process-leases-rollout.py` therefore requires a paired TS readiness proof before changing the selector. Candidate build/check and isolated native canaries do not enter this production coordinator and remain available independently.

The TS service is installed first through the existing release procedure. It must run the canonical facade and the canonical process-wait gate from the same source commit as the proposed native candidate. Its calls can fail closed while the old native core lacks the new API. Preflight does not require that old core to accept `automation.wait_status`, and it does not resume an agent to test readiness.

The actual service receives two further trusted environment pins:

~~~text
AGENT_HERDER_TS_RUNTIME_MANIFEST=<private immutable runtime manifest>
AGENT_HERDER_TS_RUNTIME_MANIFEST_SHA256=<SHA256 of those exact bytes>
~~~

The version-1 manifest has `kind: herder-canonical-ts-runtime`, `capability: canonical-scheduler-wait-gate-v1`, the exact 40-character `source_commit`, an absolute `root`, `entry: index.js`, a complete relative-path-to-SHA256 `files` inventory, and `node_binary` / `node_sha256`. The manifest is outside the compiled tree. It and compiled files have mode 0400; the tree and its subdirectories have mode 0500. Files are canonical regular files with one link and the runtime user's ownership. The Node executable is either runtime-user-owned mode 0500 or root-owned mode 0555. Inventory limits are 10,000 files, 20,000 directory entries, depth 32, 512 MiB total, 64 MiB per compiled file, 256 MiB for Node and 8 MiB for the manifest. These pins cover the project compiled tree and the exact Node executable. They do not assert that external third-party `node_modules` are part of that tree.

For this server-100 coordinator the exact existing service is `agent-herder.service`, and the endpoint is `http://127.0.0.1:18787/api/canonical-runtime-status`. The new GET route uses the existing MCP owner authorization boundary. It is not an unauthenticated general `/api` readiness flag. Its response comes from the actual `resumeAfterRuntime.service` instance; the service verifies its captured canonical client and migration evidence. A consumer probe calls the same installed process-wait gate used before automatic model work. The route creates no facade, scheduler, store, adapter or session.

The operator records the authenticated GET through an already approved route, preserving the provider operation ID and exact response. No bearer value belongs in the receipt. A preflight receipt has this shape:

~~~json
{
  "version": 1,
  "kind": "herder-canonical-scheduler-proof",
  "stage": "preflight",
  "target": "shell:roomhacker-server-100",
  "unit": "agent-herder.service",
  "method": "http_get",
  "provider_operation_id": "<exact successful operation ID>",
  "observed_at_unix_ms": 0,
  "request": {
    "endpoint": "http://127.0.0.1:18787/api/canonical-runtime-status",
    "challenge": "<fresh 64-character lowercase hex challenge>"
  },
  "response": "<the complete typed JSON response, as an object>",
  "response_sha256": "<SHA256 of sorted compact response JSON>"
}
~~~

The timestamp and placeholders must be replaced with observed evidence. Pass this private receipt as `run --scheduler-proof <path>`. It expires after 60 seconds. The coordinator independently checks Linux PID, boot and start ticks, UID, `/proc` executable inode, exact two-element Node/entry argv, startup environment pins, immutable compiled inventory, canonical configuration epoch, sealed snapshots and absence of every exact legacy writer identity. Full production cutover requires both `resume_after` and `resume_receipts` evidence. A status process started outside the existing service cannot stand in for the scheduler: the proof must match systemd MainPID and own the actual listening socket. The loaded unit must need no daemon reload and have the exact immutable restart command. Canonical mode/config/manifest pins must be explicit persistent systemd `Environment` entries; referenced environment files cannot override them. Unit/drop-in/environment-file hashes are retained and rechecked. No secret values are recorded.

The release execution guard stays held through install, the operator's one typed native-child restart, and both consumer checks. After the restart, collect a fresh GET using the durable rollout `challenge` and explicit `harness` / `nativeSessionId` query parameters, with `nodeRef` only if it exactly matches the configured node. The `consumer` scheduler receipt includes the rollout `job_id` and a snake-case `request.probe` identity (`harness`, `native_session_id`, optional `node_ref`). Record it with `record --kind scheduler --receipt <path>`. The complete response must echo that probe, include the full version-1 canonical WaitStatus decision, and report the actual gate's `gateBlocked` result. The decision must be configured, complete and newer than the native restart; its blocked result must agree with the gate. A blocked decision is valid readiness evidence and does not release HumanStop or a pending wait.

The TS PID/birth, source, manifest, configuration, epoch and unit identity must still match preflight. The coordinator also independently rechecks the selected native compat/core process pair and fresh native tool schemas, including process completion, Timer, SessionCompletion, WaitStatus, resource binding, session resolution and receipt reads. Neither a TS boolean nor native `tools/list` alone completes rollout. Missing, stale, cross-PID, cross-epoch or incomplete evidence leaves the durable rollout unresolved. The coordinator never retries a restart or guesses a rollback after an uncertain outcome.

Recovery retains the paired guard. A settled candidate needs another fresh actual gate query from the same TS identity. A settled old native baseline can instead use a fresh no-probe preflight under the rollout challenge, since the canonical TS code will block calls to an unsupported old core. An UNKNOWN canonical release-guard binding still requires the separate reviewed reconciliation procedure; no readiness receipt fabricates `finished` or clears it. These are source safety gates, not evidence that the shared service has already been migrated.

The candidate helper also refuses a baseline carrying `core_release`, `products` or `product_sha256` until it can regenerate those descriptors for the replacement core. It does not copy descriptors whose binary binding would become stale. The inspected existing baseline has none of these fields.

## Source audit and validation

Canonical mode does not construct `ReceiptLedger` in `src/resume-transport.ts` or `src/resume/core-transport.ts`. Direct compatibility sends and receipt queries use the same native authority, with one attempt and subsequent read-only reconciliation. The principal-wide compatibility key binding lives inside the existing resource authority and prevents the same old key from being reused for another session or payload. It is not a TypeScript receipt registry.

The former standalone MCP and CLI retain lookup/receipt-reading utilities. Their effect aliases return `agent_resume_standalone_retired` unless a trusted Herder facade was explicitly injected. No production entrypoint constructs `JobRegistry`; the old five-second resume-after sweep is reachable only through legacy mode. These retired aliases are not a claim of automatic migration for old process jobs.

The following source checks passed on server-100 on 2026-11-13 and 2026-11-14. They used isolated fixtures and performed no shared-runtime switch or native prompt submission.

| Check | Result | Covered boundary |
| --- | --- | --- |
| Canonical facade, direct resume, legacy resume-after/scheduled delivery, caller session and wait gates | 152 tests passed across the focused run and the corrected remote completeness regression | Stable due/key after restart, UNKNOWN retention, exact bindings/CAS, no legacy clock, no fallback, sealed-authority gate, retained receipt reservations. |
| Fleet transport/public context and OpenCode runner/family | 39 tests passed | Native exact-route allowlist without a legacy quota call, legacy quota policy preserved, capability marker, existing Queue/Steer behavior. |
| Local canonical SQLite wait reader | 15 tests passed | Registration before WaitState, process finalization, Timer/SessionCompletion, exact intent, HumanStop, inode/authority mismatch and read-only state. |
| Remote completion reader | 8 tests passed | Separate controller/executor identities, immutable terminal proof, exact pins/handle/correlation, missing or changed evidence blocked. |
| TypeScript compiler | `tsc --noEmit --pretty false` passed | Current source/type integration. |
| Candidate/launcher contracts, paired adapter migration and held rollout coordinator | 17 + 12 + 22 tests passed | Optional remote bridge pin, real fresh compiler and single-entry dependency closure, preserved Node/profile pins, component ancestry and mandatory paired scheduler evidence. |
| Paired TS runtime proof verifier | 10 tests passed | Real isolated Linux Node PID/socket, immutable files, drained writer identity, stale/cross-PID/cross-epoch refusal, persistent service pins, unpinned preload refusal and complete actual gate evidence. |

The remote completeness regression now distinguishes verified absence (`configured:true`, complete read, no matching binding) from an explicitly configured but unavailable authority (`configured:false`). Only the former permits automatic continuation. Native acceptance and rollout approval remain separate evidence, including the failed OpenCode v2 duplicate-turn canary described above.

The candidate builder also packages `src/herder-process-remote-bridge.ts` as an immutable single-entry ESM companion when that entry exists in the clean source commit. It reuses the exact V1 Rolldown implementation and the same fresh workspace compilation as selected adapters. `manifest.process_remote_bridge`, its SHA256, component source commit and source/compiled/bundler evidence are checked by the helper and pinned launcher; the coordinator checks its independent ancestry. The existing Node binary pin and protected profiles remain unchanged. Packaging this file does not provision an executor, change the remote capability list or dispatch work. Already configured `remote_executors` cannot silently disappear during a later rollout.
