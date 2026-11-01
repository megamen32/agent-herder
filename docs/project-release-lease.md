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
