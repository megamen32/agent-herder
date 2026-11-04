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

A registered MCP child and the owner fleet service may use different operating
system users, entrypoints and release authorities. Updating one does not update
the other. The portable configured controller rejects owner profiles; owner
updates remain a separate legacy explicit node-side workflow.

The registered-child installer below is also a separate existing deployment
integration, not parameterized by the portable fleet configuration. Verify its
actual entrypoint, service lock identity, OS user and canonical ledger before
using it. Do not substitute an illustrative path or infer authority from a home
directory. For example, the synthetic tuple
{"fleetDir":"/srv/example/agent-herder","unit":"example-hub.service"}
illustrates the shape only; it must be replaced by the independently verified
existing child target. Acquire once through that target's existing native admin
CLI. The unit name is the OS-lock identity, not permission to restart the hub.

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

### Project-only acquisition

The CLI already uses the same optional deploymentTarget schema as MCP. Omit
deploymentTarget entirely for a project-only lease; when supplied, it must
contain both fleetDir and unit. Supplying just one field is rejected before any
ledger transaction. Herder's target-bound rollout requirements are unchanged.

A project-only lease protects canonical repository coordination, not an actual
deployment target. Without a target, the store does not retain a
deployment-in-progress marker after expiry or session cancellation. Callers must
keep the operation bounded within its TTL, check ownership immediately before
mutations and renew explicitly as needed. Native updater serialization,
expected-revision compare-and-swap and rollback guards remain separate required
boundaries; a project-only lease does not replace them.

## Portable deployment configuration

The updater does not load repository topology. Supply an explicit local
--deployment-config /absolute/private/deployment.json, or set
AGENT_HERDER_DEPLOYMENT_CONFIG. The file must be outside any Git worktree,
owned by the current controller user, mode0600, regular and not a symlink.
Use deploy/fleet/deployment.example.json only as a synthetic schema example.
Its documentation-network addresses and example identities are not deployable
defaults. The legacy repository nodes.json is intentionally empty.

Each selected node declares its exact host/address/SSH user and port, platform,
UID/home, absolute fleet and state directories, service unit, web port and
existing Python executable/version. Darwin additionally declares the loaded
user/gui domain. The updater derives the restart command from those fields;
arbitrary commands and SSH options are not settings. Missing fields, unknown
keys, duplicate hosts or authority mappings and unsafe paths are refused.

authorityTarget is an explicit local lease tuple (fleetDir and unit)
on the controller. It is not inferred from the remote filesystem. Keep the
mapping aligned with the actual existing release authority. The protected
lease proof and ledger remain on that authority and are never transferred.
No credentials or new persistent access are created by these settings.

The normalized selected descriptor is frozen by SHA-256. Only that descriptor,
not the complete deployment configuration, is copied into this run's private
SSH staging directory. The remote process validates its fields and digest,
actual hostname, UID/home/platform and its unit lock. The authority handshake
binds that digest alongside the run, target and revisions. A changed mapping or
descriptor cannot reuse the old handshake. Existing lease/fence checks,
pre-mutation CAS checks, exact-generation rollback and UNKNOWN-outcome
reconciliation remain mandatory.

Portable bundle manifests use delivery3 and contain source/payload hashes and
relative build-tool identity, not deployment nodes, exclusions, private refs,
builder paths or operational receipts. Target selection and acceptance evidence
belong to the operator's private deployment records, separate from the immutable
portable bundle. This changes future builds only; never edit an already accepted
release manifest to retrofit this format.

Before publication, review every newly introduced commit and packaged artifact,
including examples and tests. Do not merge private maintenance ancestry into a
public branch. Removing current configuration does not erase values already
published in historical commits. Keep local deployment plans, credentials,
process receipts and incident records out of Git and out of release archives.

Profiles sharing one existing serialized authority namespace must explicitly use
the same nonempty authorityGroup and identical tuple. A group cannot name two
tuples, and duplicate tuples without the same group are refused. This preserves
shared authority locking without fabricating target paths; the remote descriptor
digest still binds the exact selected host and target.

This portable configured controller currently admits fleet profiles only.
Owner profiles are rejected rather than silently ignoring their configured
identity or authority. The existing explicit owner node-side workflow is
separate; no owner runtime is changed by this refactor.

## Deploy guard: only main reaches live

Rollout (build-release-candidate.py, rollout-candidate.py node and controller paths, via
ReleaseGate.candidate_descends_from) enforces in deploy/fleet/main_guard.py, with no flag bypass:

1. After a fresh fetch, the candidate commit must be reachable from origin/main. Otherwise:
   "ОТКАЗ: ветка не влита в main, сделай PR / REFUSED: open a PR", with git log of the commits outside main.
2. The really running live revision must be an ancestor of the candidate. Otherwise:
   "в live есть коммиты, которых нет в main: влей их, потом выкатывай", with git log of those commits.
3. node-config.json sourceSha, the current symlink and (owner node) the running process release
   must agree, else error with a fix hint (release_live_revision_mismatch /
   release_revision_changed_since_admission).

Emergency only: set AGENT_HERDER_EMERGENCY_UNMERGED_ROLLOUT="<reason>" in the environment; the use is
appended first to ~/.local/state/agent-herder/rollout-journal.jsonl (an unwritable journal refuses).
Tests: tests/test_main_guard.py. The lease ledger check itself (project_release_lease check) has no
revision knowledge and is unchanged; the rules run at the rollout gate that holds the lease.
