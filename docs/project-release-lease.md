# Project release coordination

Use one release authority host for a project. A task works in its own Git worktree
and branch, commits scoped changes, pushes that branch, and opens a draft PR.
A lease does not approve a PR, a merge, a deployment or a rollback.

## MCP contract

`project_release_lease` accepts `action` (`acquire|renew|release|status|check`),
`cwd`, and for mutations an `owner` with `hostId,harness,nativeSessionId`.
Deployable acquisitions also set exact `deploymentTarget: {fleetDir,unit}`;
fleetDir is canonicalized on the authority host. Acquire TTL is 30..1800 seconds (default 300). The local authority requires a
local owner host. Worktrees normalize to the same canonical Git common directory.
Use the same authority for every release of this repository; clones on separate
hosts are not automatically one global lock.

Acquire returns a one-time capability token and monotonic fence. Store it in a
protected local proof file, never commit it or paste it into a plan/transcript.
Renew/release/check require the owner, token and fence. Status returns only the
session address, expiry, remaining seconds and existing SendMessage target.
A competing session reads status and can message the owner; it cannot release
that owner's lease with its own proof.

Existing coordination lifecycle/session-end endpoints accept terminal reports
and confirmed StopAgent releases the local session's reservations. Native ZCode
already installs SessionEnd into its coordination hook. Its report releases only
when the original event has a valid timestamp; missing/invalid timestamps use
TTL, never delivery time. Codex has no new unsupported hook registration here;
its confirmed StopAgent/controller-end reports and TTL provide cleanup. Normal turn-end does not mean session-end.
A process crash without a hook leaves the reservation until TTL expires.
Renew explicitly during long releases. Hooks are best-effort; the final gate is
authoritative. There is no infinite or silent automatic reservation.

## Deployment boundary

`deploy/fleet/rollout-node.py --release-proof /protected/proof.json ...`
now requires the proof, checks the authority ledger, serializes the full rollout
on per-project and actual-service OS locks, compares the live configuration revision immediately
before mutations and refuses candidates not descended from the installed commit.
The proof JSON has `project,owner,token,fence`; project is the canonical git
directory returned by acquire. Ledger path is the authority's existing
`AGENT_HERDER_RELEASE_LEASES` (or default state path).
A failed rollout's rollback is allowed only while it still owns the lease and
the current revision is its previous or candidate revision. If a session ends
or TTL expires during a rollout, its fence is retained for cleanup while the OS
lock is held; takeover stays blocked until that process exits. Status shows
`deploymentInProgress` even after expiry. Cancellation cannot be renewed. It cannot roll back a later release.
An intentional backwards rollout needs a separately authorized recovery path;
do not disable the ancestry check to force an ordinary deployment.

Both rollout-node and rollout-candidate require admission at the existing
entrypoints. Owner readiness verifies a new actual process generation, exact
release entrypoint and ownership of the listening port, not just HTTP 200.

This guards this repository's fleet rollout entrypoints. Direct shell writes,
other projects' release scripts and old installed runtimes are not magically
covered. Integrate their final mutation boundary before claiming fleet-wide
enforcement. Existing running services were not changed by this PR.

## Evidence required at handoff

Record task/branch, pushed commit, draft PR, tested commit, release owner session,
expiry and intended/live revision. Never record the lease capability. Report a
prepared PR separately from a merged or deployed result.

## Last-worker integration and worktree cleanup

A terminal lifecycle report inventories only that Git project and records a
durable integration responsibility in the existing lease ledger. Only when all
registered participants ended does it register one bounded continuation through
existing resume_after. A stable request ID and a bounded startup replay recover
a crash before registration. Human-stop remains authoritative; a confirmed
manual StopAgent never immediately wakes the stopped session.

project_integration status/inventory shows remaining work. The last worker
acquires a project release lease, claims the exact integration ID, reconciles
known branches through PRs with the required specific merge authorization,
verifies the whole project, and finishes with verification evidence or blockers.
Starting another participant invalidates the prior claim and creates a fresh
bounded continuation when the participants finish. No endless polling daemon or
automatic merge of unknown branches is introduced.

Cleanup is explicit for exact path and HEAD under the same ledger transaction.
It requires a known ended occupant, no other active participant, unchanged HEAD,
merged ancestry into the recorded integration target, clean tracked/untracked
AND ignored content, and an unlocked linked worktree in this Git project.
Primary, unknown, active, dirty, conflicted and unmerged artifacts remain visible.
Normal git worktree remove is used without force; the branch remains recoverable.
No existing worktree was removed while preparing this PR.

Current lifecycle integration target is main. Projects using another target stay
blocked for explicit configuration, not silently cleaned against a caller-chosen
task branch. Hooks without original terminal timestamps retain unknown activity.
This does not prove inactivity for sessions that never reported lifecycle events.
Early draft PRs are useful visibility for unfinished branches; link only plans
whose content is safe for the actual audience. SSO protection must be verified,
not inferred from a hostname.


## Offline owner administration when canonicalization blocks installation

The source CLI `agent-herder-release-admin` uses the same validated command
handler, canonicalization, hostname check and store transactions as MCP. It does
not start a second authority and cannot initialize a ledger. Before invoking it,
the authorized operator must independently establish the running authority's
exact effective ledger path and hostname. The live configured store path must
be canonical and non-symlink; alias paths are rejected because they split ledger
transaction lock names and can diverge on atomic rename. A root native user is not evidence of
the process HOME or an absent AGENT_HERDER_RELEASE_LEASES override.

Pass `--ledger /verified/existing/ledger.json --authority-host VERIFIED_HOST`
and `--request /protected/request.json`. The request file contains the same JSON
arguments as the MCP tool. Acquisition additionally requires
`--proof-out /protected/new-proof.json`; the path must not already exist. The CLI
writes the capability with mode 0600 and omits it from stdout. Renew, check and
release use a protected request file with the acquired proof. Do not put tokens
in command arguments, transcripts or source control.

Even status uses the store transaction and rewrites the existing ledger. Never
use guessed-path status as authority discovery. Both the CLI and rollout must
use the same verified ledger; pass the corresponding AGENT_HERDER_RELEASE_LEASES
to the normal rollout command. The existing release gate, lease TTL, fencing,
target binding, revision checks and rollback rules remain mandatory.


## Registered GPTAdmin root MCP child (different from owner fleet node)

The registered child of `gptadmin-hub.service` starts
`/home/roomhacker/agents-projects/agent-herder/dist/index.js` under root.
The regular `rollout-candidate.py --node 100` deploys the separate UID1000
`agent-herder.service` and **does not** update this registered root child.

For the existing root authority, use only the independently verified canonical
ledger at `/root/.local/state/agent-herder/project-release-leases.json`.
The owner coordinates acquisition **once** through the existing native admin CLI;
the deployment target must be exactly
`{"fleetDir":"/home/roomhacker/agents-projects/agent-herder","unit":"gptadmin-hub.service"}`.
The unit name is the OS-lock identity; the installer does not restart the hub.

After a validated, target-bound proof is available, execute the new
`deploy/fleet/rollout-mcp-child.py --sha <verified-full-sha> --release-proof <protected-path>`
from the same authority host as root. Without the proof, only `--dry-run`
preflight is supported. It verifies the immutable candidate bundle, checks
Git ancestry as the repository owner, locks the same ledger and unit via
`ReleaseGate`, and atomically redirects the registered entrypoint to the
complete versioned release. The previous entrypoint is backed up under
`/root/.local/state/agent-herder/release-backups/gptadmin-agentherder-child/`.
The manually repaired mixed legacy dist is eligible only when exact reviewed
release-control file hashes match the known prior release; arbitrary drift is
rejected. Neither service identity, credentials nor security settings change.

**Deployment receipt alone is not live acceptance.** Confirm a newly spawned
root child and verify its actual owner-aware behavior using the documented
`project_release_lease(status)` on both ExManager main/worktree, which must
return the same canonical project key. Do not repeat unknown acquisitions or
force a hub/consumer restart. Manual rollback remains subject to the existing
release ownership and recovery policy.
