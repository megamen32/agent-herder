# Canonical release ownership cutover

The TypeScript project release tool is a compatibility facade after an explicit
seal. Before that seal, the existing version 1 authority continues unchanged.
No build, test, facade initialization or process runtime installation migrates
live release leases.

## Existing authority and audit

The legacy authority is `AGENT_HERDER_RELEASE_LEASES`, defaulting to
`~/.local/state/agent-herder/project-release-leases.json`. Its project identity is
the canonical Git common directory. Sibling `deploy-<sha256(project)>.lock` and
`deploy-unit-<sha256(unit)>.lock` files serialize existing deployment effects.
The same JSON file also holds advisory session and project integration metadata.

A read-only snapshot on server-100 at 2026-11-13 21:05 UTC found 27 project entries.
The Herder project `/home/roomhacker/agents-projects/agent-herder/.git` had fence
118 and no owner record. Three other projects retained expired owner records.
This observation is an audit snapshot, not permission to erase those records or
evidence that their effects stopped. No capability hashes were printed.

Old TypeScript writers reject an unsupported ledger version. The old Python
deployment gate ignores the version and reads `projects[project].lease`
directly. Changing only the version is therefore insufficient. The seal must
contain no legacy `lease` field anywhere, including `lease: null`, and old
effects must be reconciled before the seal is written.

## Explicit mapping and compatibility protocol

The installed bridge configuration is a private JSON file:

```json
{
  "version": 1,
  "process_config": "/absolute/installed/process-runtime.json",
  "ledger": "/absolute/legacy/project-release-leases.json",
  "seal_id": "reviewed-cutover-identity",
  "principal_ref": "installed-administrator",
  "mappings": [{
    "project": "/absolute/repository/.git",
    "resource_ref": "release-resource",
    "revision": 1,
    "previous_fence": 118,
    "deployment_target": {"fleetDir": "/absolute/fleet", "unit": "example.service"}
  }]
}
```

An alias must explicitly name the same canonical resource, descriptor revision
and deployment target. Aliases resolve to the same current claim and monotonic fence counter.
The unit is the local effect identity. A second fleet directory cannot map the
same unit to a different resource or deployment target.
Resource registration already enforces unique external identity under the
registry lock. Metadata does not grant access: the bridge uses the installed
principal policy and the existing canonical resource authority.

The sealed ledger uses `version: 2` and
`canonical: {version: 1, config, bridge, seal_id}`. Its `projects` entries keep
advisory metadata only. Unmapped projects fail closed; there is no fallback to
another ownership database. Canonical lease operations never rewrite legacy
ownership. Advisory integration updates may still rewrite their own ledger.

The bridge runs as `herder_resource_bridge --config ABSOLUTE_CONFIG`. JSON lines
on stdin carry `action`, `project`, `owner`, `token`, `fence`, `ttlSeconds` and the
optional exact `deploymentTarget`. Responses are `{ok: true, result: ...}` or a
stable error envelope. Secrets never appear in argv or error output. Lease
timestamps retain epoch millisecond fields `acquiredAt` and `expiresAt`.

The token maps to the canonical claim UUID through SHA-256. The numeric fence is
compatibility metadata in the canonical resource directory, advanced before
claim creation under its compatibility lock. Gaps are allowed; reuse or decreases
are not. Only `owner.json` authorizes ownership. An expired generation cannot be
renewed or recovered as a new lease.

## Effect lifetime

Python deployment and TypeScript integration cleanup open a persistent `guard`
channel. Rust verifies exact principal, nonce and descriptor revision, persists
occupancy and holds `TargetExecutionLock` throughout the effect. Normal `check`
requires a live lease. A `check` with `cleanup: true` is permitted only through
that already admitted guard after its TTL expires. A fresh expired guard is
rejected.

Successful completion sends `finished`, creating terminal evidence and clearing
that guard's occupancy while the execution lock remains held. The outer claim
remains until explicit release or TTL. EOF, exceptions, process death and failed
completion keep unresolved occupancy. Freeing an OS lock alone does not permit
takeover. Recovery requires a separate reviewed reconciliation of the original
effect, not a new token or an automatic retry.

In sealed mode, `endSession` does not release canonical claims. This prevents an
agent's turn from ending its running build's lease. A manual claim without a
bound execution remains until explicit release or its finite TTL.

## Reviewed migration sequence

1. Upgrade the facade, offline admin route, Python deployment consumers and
   pinned bridge artifact before changing the ledger. Stop or drain older
   writers and effects that could still use the old admission path.
2. Register and review exact resource descriptors, aliases, targets and revision
   pins. Preserve the greatest prior fence for every shared resource.
3. Reconcile every remaining legacy owner record. Expired records and unknown
   effects are blockers. This implementation does not silently import or discard
   active owners; preserve the old authority until they are resolved.
4. Run `prepare_canonical_release_cutover.py` with explicit ledger, bridge config
   and bridge paths. It reads only known files and produces a proposal, expected
   source digest and blockers. It never creates locks or performs a cutover.
5. Acquire a dedicated migration lease through the existing authority. Its
   acquisition increments the old fence. Review the mapping seeds and the exact
   source digest after this acquisition, rather than reusing an earlier audit
   snapshot. Verify the upgraded consumers in isolated sealed fixtures, record
   their running PID/start/boot identities and artifact hashes, then drain them
   as well as every old writer during the critical section.
6. Invoke the explicit `apply` operation below. It holds the existing ledger
   transaction lock, all legacy effect locks, the canonical resource registry
   lock and each mapped resource's effect and claim locks. It archives the exact
   original bytes, checkpoints the operation, rechecks all source digests and
   atomically seals version 2. Only its own admitted migration generation is
   retired. Any other owner, even an expired one, remains a blocker.
7. Verify the existing public tool, offline CLI and Python consumer against the
   same resource and proof. Check that an old writer fails closed and that an
   interrupted guard leaves durable UNKNOWN occupancy. Releasing the same nonce
   through the canonical API must make it unavailable to stale proofs.
   Subsequent native rollout jobs acquire a new canonical proof for the same
   mapped resource. A proof from the old authority cannot continue the rollout.

Rollback after a canonical acquisition cannot restore a version 1 writable
ledger blindly. Reconcile canonical claims and occupied effects first. The
private archive preserves evidence, not a second active authority.

## Apply manifest and durable checkpoint

`deploy/fleet/apply_canonical_release_cutover.py` has explicit `apply` and
`reconcile` commands. It does not stop services, remove abandoned effects,
upgrade consumers or invoke deployment. The operator supplies a reviewed runtime
inventory after the merged consumer upgrade. Files containing authority,
proof, manifest, checkpoint or runtime evidence must be canonical, private and
owned by the executing account. The pinned bridge must be an existing executable
owned by that account and must not be group or world writable.

The manifest records all known writer entrypoints and their exact historical
process identities. The tool verifies those identities have stopped and scans
the current local process table for any matching writer entrypoint. Unobservable
process data fails closed. This is an inventory of known writers under the
existing host access policy, not a sandbox against arbitrary privileged code.
Stopping a PID while leaving a restartable legacy service configured is not a
complete operator drain; the reviewed maintenance procedure must also prevent
those writers from restarting until their configuration has been upgraded.

```json
{
  "version": 1,
  "host": "authority-hostname",
  "seal_id": "reviewed-cutover-identity",
  "ledger_sha256": "sha256-after-migration-lease-acquisition",
  "writer_entrypoints": ["/absolute/old-release/dist/index.js"],
  "drained_processes": [{
    "pid": 1234,
    "start_ticks": 5678,
    "boot_id": "observed-kernel-boot-id",
    "entrypoint": "/absolute/old-release/dist/index.js"
  }],
  "consumer_verifications": [{
    "kind": "typescript_facade",
    "artifact": "/absolute/merged-release/dist/project-release-admin.js",
    "artifact_sha256": "sha256-of-tested-artifact",
    "receipt": "/absolute/private/typescript-verification.json",
    "receipt_sha256": "sha256-of-verification-receipt"
  }],
  "occupancy_selectors": ["/absolute/config/gptadmin-entry.json"]
}
```

The abbreviated `consumer_verifications` array above must contain exactly one
record for each of `typescript_facade`, `python_gate` and `native_rollout`.
Each private receipt contains `protocol: "canonical-release-v1"`, its matching
`kind`, `result: "passed"`, `artifact_sha256`, a nonempty `checks` array and
`observed_process: {pid, start_ticks, boot_id}` from the actual verification
process. A copy of an upgraded artifact alone does not meet this contract.
All three verification processes must have completed before apply.

Every listed selector must have a resolved rollout occupancy pointer at
`.<selector-name>.process-leases-rollout.json`. The pointer and its referenced
private `state.json` must use schema 1, agree on the job ID, job directory and
selector, and match the final state digest. Only `completed`,
`recovered_baseline` or `recovered_candidate` counts as terminal evidence.
An active, malformed, missing or mismatched checkpoint blocks cutover even when
no OS lock is held and the old lease has expired.

```sh
python3 deploy/fleet/apply_canonical_release_cutover.py apply \
  --ledger /absolute/state/project-release-leases.json \
  --config /absolute/config/release-bridge.json \
  --bridge /absolute/merged-release/herder_resource_bridge \
  --proof /absolute/private/migration-proof.json \
  --manifest /absolute/private/cutover-inventory.json \
  --checkpoint /absolute/private/cutover-checkpoint.json
```

The source ledger is compared byte for byte with the approved digest. The
checkpoint records the source/archive/sealed hashes, configuration and binary
hashes, complete project mapping inventory, every prior fence, per-record hashes
and the exact retired migration owner. The archive is written and fsynced before
the seal. Advisory metadata is preserved. Any reserved `lease` field in nested
metadata also blocks cutover; it is never silently erased.

The helper uses the same `.lock` directory and heartbeat as the TypeScript
transaction protocol. It never steals an existing transaction lock. All effect
and canonical locks are nonblocking, so an occupied resource causes an abort
instead of a lock-order deadlock. No source file changes until every barrier and
the final compare-and-swap checks succeed. The successful return still says
`consumer_verification_required: true`; writing a seal does not prove the live
tool or native consumer has adopted it.

## Reconcile an interrupted cutover

```sh
python3 deploy/fleet/apply_canonical_release_cutover.py reconcile \
  --checkpoint /absolute/private/cutover-checkpoint.json
```

Reconcile checks the durable archive and compares the current ledger with the
recorded source and sealed hashes. It records one of these observations without
changing ownership:

| Observation | Required next step |
| --- | --- |
| Original source is unchanged | Review the failed attempt, obtain a fresh live guard and prepare a fresh checkpoint. |
| Exact seal is present | Verify the live canonical consumers and acquire a new canonical proof for further effects. |
| The same seal has subsequent changes | Review the intervening advisory or canonical activity before continuing. |
| Neither source nor seal can be established | Keep the outcome unknown and investigate the durable evidence. |

A missing or modified archive fails closed. An existing checkpoint cannot be
reused by `apply`. The helper does not remove stale transaction directories,
rewrite version 1, free another owner's lease, remove UNKNOWN occupancy, rerun a
build or resume agents. A crash after the ledger rename but before the final
checkpoint is distinguished from a crash before the seal using the archived
and sealed hashes, so a lost acknowledgement cannot create a second authority.
