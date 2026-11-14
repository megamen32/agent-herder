# Process leases: native runtime and rollout

Agent Herder owns supervised execution, generic resource claims, completion receipts and the decision to resume an agent. The process worker, resource bridge and optional remote transport bridge are immutable companion executables in the same release. None is a separate resume service.

This runbook covers the native public MCP, the TypeScript automatic continuation gates, and the release coordinator. The user workflow is documented separately in [supervised-jobs.md](supervised-jobs.md).

## Installed surfaces and reviewed baseline

The following observations were made on server-100 on 2026-11-13. Re-read the selected configuration and process identity before any release.

| Surface | Actual entry or state | Consequence |
| --- | --- | --- |
| Public native MCP | GPTAdmin child AgentHerder; https://mcp.bezrabotnyi.com/server/agentherder/mcp | Restart and probe this exact child. |
| Launcher | /home/roomhacker/.local/bin/agent-herder-v1 | Python source without a .py extension. |
| Child selector | /home/roomhacker/.config/agent-herder/gptadmin-entry.json | Selected by HERDER_V1_ENTRY in the child configuration. |
| Default CLI selector | /home/roomhacker/.config/agent-herder/v1-entry.json | A different file; switching the public child does not switch the default CLI. |
| Baseline manifest | /home/roomhacker/herder-artifacts/releases/ahap-opencode-resume-bce62de3-v1/manifest.json | SHA256 4a711887a69126c02ac870b42c896f806db312382f83120f998a45c00a1fe770. |
| Composite components | Core and browser adapter a7fbc548; compat, Node, bootstrap, Codex and ZCode cebecc13; OpenCode bce62de3 | Preserve each component's provenance. The top manifest commit is not the running core commit. |
| Trusted profiles | Six: local Codex, remote44 Codex, noticeplace OpenCode, ChatGPT browser, ZCode and ZAI | Preserve authority and wrapper pins. Only the explicit reviewed adapter transition creates new sibling profile paths. |
| TypeScript service | agent-herder.service; source c9bc35a6; 127.0.0.1:18787 | Its scheduler code needs a coordinated cutover. Production core rollout must prove the installed TS gate and matching canonical configuration. |
| NoticePlace bridge | agent-herder-v1-noticeplace.service; source b33f5b37; 127.0.0.1:18797 | Its existing target is the native MCP. |
| Fleet transport child | HerderFleet | Different authority from AgentHerder. Do not use a remapped fleet route for canonical process waits. |

After the Hub restart, a read-only check observed compat PID 1954122 and native core PID 1954772, with the core directly parented by that compat. Their exact executable paths, profile arguments, selector environment and core digest matched the baseline. Earlier PIDs 2606612 and 2607240 no longer existed. These numbers are historical observations, not rollout inputs.

Use process-leases-rollout.py inspect to verify freshly observed PIDs. It checks UID, Linux boot ID, process start ticks, parent relation, the executable through /proc, exact trusted-profile arguments, selected configuration, and stable identity before and after the read. It does not print arbitrary environment values.

Do not use rollout-mcp-child.py for this release. That helper addresses an older TypeScript child. Preserve the separately retained local main change 98593d9c; an older checkout must not replace newer installed components.

## Candidate contract

deploy/fleet/process-leases-candidate.py builds and checks a clean committed source tree. Its install and rollback functions require an in-process admission from the continuously held rollout coordinator. Calling those commands directly does not bypass release ownership.

A candidate contains:

- fixture/herder_native_stdio and fixture/herder_process_worker.
- fixture/launch-v1-core.py and fixture/process-runtime.json.
- fixture/process-wait-status.py when the source includes the read-only wait reader.
- fixture/herder_resource_bridge when the source contains that Cargo bin.
- fixture/herder-process-remote-bridge.mjs when the source contains the trusted remote transport entry.
- manifest.json, selector.json, process-leases-build.json and the build log.
- For an explicit adapter update: adapter-migration.json, check-selector.json, profile-payloads and the selected immutable AHAP bundles.

The manifest pins every new executable, reader and configuration digest. The worker is selected by process-runtime.json.worker, and the launcher passes the verified HERDER_PROCESS_CONFIG. HERDER_PROCESS_WORKER is not exported by the new launcher; an inherited override is cleared. An optional resource_bridge and sha256.resource_bridge pin the resource companion; the launcher also verifies that pin. An optional process_remote_bridge and sha256.process_remote_bridge pin the remote companion and its source provenance. It uses the retained Node pin, a fresh workspace compilation and the existing V1 bundler. Packaging a bridge does not register an executor or launch remote work. A later candidate cannot silently remove configured remote_executors. A legacy source commit without these optional companions remains buildable.

The process configuration contains version 1, the real execution node, immutable worker path, durable execution root, local resource StorageAuthority and administrators from the selected trusted profiles. All six currently selected profiles use principal local-owner. Only configured administrators gain the process/resource capability; merely knowing a session identity does not grant it.

Use stable store identities across releases. The reviewed candidate uses execution root /home/roomhacker/.local/state/agent-herder/process-executions-v1 and resource root /home/roomhacker/.local/state/agent-herder/resource-ownership-v1. Its bundled bridge is not an executor registration: remote_executors is absent until a separately reviewed executor is configured. The resource marker storage.json is exactly:

~~~json
{"schema":"v1","storage_id":"herder-resources-server-100-v1"}
~~~

The engine owns execution-root/store.json and its node identity. Project-scoped resources additionally require a pre-existing project marker. The candidate helper never invents project markers.

Build and check validate state roots without provisioning them. Under the held release admission, install saves the rollback evidence before creating missing private roots and the resource marker. Existing canonical paths, UID, private modes and markers must match. Nonempty unmarked roots are refused. Directories use 0700 and storage.json uses 0600. Existing profiles and authority databases are never rewritten.

The source_commit in a new manifest describes replaced components. Retained adapter provenance, remote wrapper descriptors and hashes remain intact. The base manifest and its digest are recorded separately. A production coordinator fetches origin/main and checks ancestry for each replaced component, including the actual prior core commit. It also rejects unreviewed adapter/profile/authority replacement. It does not compare a composite bundle's top-level adapter commit against the new core as if they were one binary.

## Reviewed OpenCode and ZCode adapter transition

The default build retains all adapter pins and profile paths. The paired release explicitly adds `--adapter-update opencode --adapter-update zcode`. Only these two kinds are accepted. The builder recompiles the workspace package and TypeScript runners into a new private directory, then reuses `deploy/fleet/build-v1-core.py`'s Rolldown bundler from the same clean commit. The copied Node executable remains the installed pin. Only the selected bundles enter the candidate; browser, Codex, compat, bootstrap and remote wrapper pins remain unchanged.

`adapter-migration.json` is pinned by the main manifest. Its versioned `herder-ahap-profile-rebind` record contains the exact old/new adapter paths, SHA256 digests and component source commits, fresh compiler/bundler evidence, all old profile hashes, and each new profile/payload hash. Both the candidate checker and the release coordinator validate this typed transition. There is no generic profile-change exception. Main ancestry is checked separately for each replaced adapter, so a valid new core cannot discard newer installed adapter work.

Build writes profile payloads only under the candidate. The planned installed profile is a new private sibling of its old profile, existing database and gate. The payload editor replaces only the JSON string token at `owner.ahap_script`. Every other byte, including database/gate/generation, principal/node/instance, model and environment strings, escaping, whitespace and line endings, remains identical. Duplicate JSON members, incomplete mappings, changed fields, non-sibling destinations and existing destination files are rejected.

`check --staged-profiles` verifies the payload bindings through the pinned launcher without creating those siblings or starting a native adapter. Its receipt explicitly says `staged_payloads_not_installed`. Do not launch `check-selector.json` as a native authority: its payload paths are staging inputs. A real canary uses independently bootstrapped isolated authority/profile copies and the candidate adapter pins.

During the continuously held release guard, install first records every planned profile creation in durable rollback evidence. It creates the siblings exclusively with mode 0400, verifies their exact bytes and actual manifest bindings, and only then performs launcher/selector CAS. Existing profiles and databases are never rewritten. A creation race, expired admission or partial failure preserves the unresolved rollout checkpoint; it does not overwrite a file, silently adopt a leftover sibling, replay a restart or manufacture success. Reviewed rollback selects the unchanged old profiles. It leaves any already created new siblings available for inspection.

The OpenCode runner advertises `nativeStartAdmission: steer-before-turn-v1` only with verified `nativeProtocol: v2`. The core selects fresh-session Start only with this exact capability. Existing-session Queue and Steer keep their original semantics. The updated runner advertises nativeAutomaticContinuation: unsupported-no-idle-admission-v1. The core disables automatic continuation for every OpenCode protocol, including v22. The observed failure was on v2: a real canary produced two assistant replies for one canonical wake, and its native prompt contract lacks an atomic idle/turn condition. This is the new candidate's policy; the unchanged public bundle is still the historical baseline. New automatic waits and canonical resume refuse before protected effects; old jobs continue observation and claim finalization. Do not enable this capability from a source test or a single input receipt. A legacy pinned runner without the capability retains the legacy initial delivery choice, so a core-only candidate does not silently change its contract. The paired native canary must observe the marker and prove that the original initial prompt was admitted in one native request.

Lost-ACK readback preserves exact native identities across AHAP. For OpenCode, a proven `info.id` record uses its own `info.metadata.agentHerderInputId`; verified v2 also accepts the actual native top-level `msg_...`, `type: user`, `metadata.agentHerderInputId` envelope returned by the addressed session endpoint. Synthetic display IDs, text matching and other protocol families do not gain that proof. ZCode preserves observed native message/command/input anchors without guessing or resubmitting input.

## Build and inspect

Commit the reviewed implementation first. The build rejects dirty source before or after Cargo runs. Candidate and state-root parents must already exist; paths must be absolute and canonical.

~~~sh
HERDER_WORKTREE=/home/roomhacker/agents-projects/.worktrees/herder-process-leases-20261113
HERDER_SOURCE_SHA="$(git -C "$HERDER_WORKTREE" rev-parse HEAD)"
HERDER_BUNDLE="/home/roomhacker/herder-artifacts/releases/herder-process-leases-$HERDER_SOURCE_SHA"
HERDER_SELECTOR=/home/roomhacker/.config/agent-herder/gptadmin-entry.json

python3 "$HERDER_WORKTREE/deploy/fleet/process-leases-test.py"
python3 "$HERDER_WORKTREE/deploy/fleet/process-leases-adapters-test.py"
python3 "$HERDER_WORKTREE/deploy/fleet/process-leases-rollout-test.py"
python3 "$HERDER_WORKTREE/deploy/fleet/process-leases-wait-test.py"

python3 "$HERDER_WORKTREE/deploy/fleet/process-leases-candidate.py" build \
  --repo "$HERDER_WORKTREE" \
  --cargo /home/roomhacker/.cargo/bin/cargo \
  --selector "$HERDER_SELECTOR" \
  --output "$HERDER_BUNDLE" \
  --build-dir /home/roomhacker/herder-artifacts/build/process-leases \
  --node-ref roomhacker-server-100 \
  --execution-root /home/roomhacker/.local/state/agent-herder/process-executions-v1 \
  --resource-root /home/roomhacker/.local/state/agent-herder/resource-ownership-v1 \
  --storage-id herder-resources-server-100-v1 \
  --adapter-update opencode --adapter-update zcode

python3 "$HERDER_WORKTREE/deploy/fleet/process-leases-candidate.py" check \
  --selector "$HERDER_BUNDLE/selector.json" \
  --launcher "$HERDER_BUNDLE/fixture/launch-v1-core.py" \
  --staged-profiles
~~~

Omit the two adapter-update flags for a core-only candidate that retains existing adapters/profiles. Staged checking also accepts that baseline path. Build runs Cargo release with --locked and an isolated target directory. It copies and hashes the binaries, records source/profile/selector stability, and calls the launcher's preparation function. It does not start an MCP child, native harness, worker or remote owner.

Inspect the resulting node, store identities, administrator list, component ancestry, exact profile transition and retained pins. Retain the base_selector_sha256 literal from the build receipt. A changed selector or profile requires new review and a new candidate.

A native runtime inspect is read-only:

~~~sh
python3 "$HERDER_WORKTREE/deploy/fleet/process-leases-rollout.py" inspect \
  --selector "$HERDER_SELECTOR" \
  --launcher /home/roomhacker/.local/bin/agent-herder-v1 \
  --compat-pid "<fresh verified compat PID>" \
  --core-pid "<fresh verified core PID>"
~~~

## Paired TypeScript scheduler admission

Production switching requires the actual agent-herder.service to run the same
source commit as the candidate in canonical mode. Its immutable compiled Herder
tree, pinned Node, exact systemd MainPID/boot/start identity, argv, persistent
environment, listener and canonical epoch are checked independently. The
original wait and direct-resume writers must be drained and their retained
records sealed through the reviewed migration barrier.

The installed TS process exposes authenticated GET /api/canonical-runtime-status
through the existing HTTP server and authentication boundary. A preflight
challenge returns the actual loaded backend's proof without calling the old
native core. This allows a new canonical TS scheduler to remain fail closed
while the old core has no wait_status action. A post-restart request also
provides an exact native probe; that request invokes the same installed wait
gate used by automatic continuations and must return fresh complete evidence.

Pin AGENT_HERDER_TS_RUNTIME_MANIFEST and its SHA256 in persistent systemd
Environment alongside the canonical client configuration. The versioned
herder-canonical-ts-runtime manifest enumerates every compiled Herder file,
its source commit, immutable root, index.js entry and exact Node binary/hash.
The inventory covers the project's compiled tree and Node. It does not claim
to seal unrelated external third-party node_modules. Unexpected Node preload,
loader or library-injection settings are rejected.

The read-only process-leases-scheduler-readiness.py verifier binds the operator's
authenticated HTTP receipt to actual OS and systemd observations. A ready
boolean, copied status file, different process, stale epoch or native-only
restart cannot satisfy it. See canonical-waits-and-resume.md for the exact
preflight and consumer receipt shapes. Missing proof blocks production
admission; isolated candidate builds and canaries remain independent.

## One held release transaction

The coordinator is a bounded native task. It holds ReleaseGate across installation, the explicit child restart and readiness evidence. It never initiates a restart itself. Start it through the existing durable task facility so its PID, output and completion survive the agent turn.

Before starting, obtain the normal project release proof for the exact deployment target. Store the proof privately through the existing release workflow. Do not put tokens in argv, logs or the checkpoint. Choose a new private job directory and backup directory, then run:

~~~sh
python3 "$HERDER_WORKTREE/deploy/fleet/process-leases-rollout.py" run \
  --candidate "$HERDER_BUNDLE/selector.json" \
  --selector "$HERDER_SELECTOR" \
  --launcher /home/roomhacker/.local/bin/agent-herder-v1 \
  --backup "/home/roomhacker/herder-artifacts/releases/process-leases-backup-$HERDER_SOURCE_SHA" \
  --job-dir "<new absolute coordinator directory>" \
  --proof "<existing private release proof>" \
  --scheduler-proof "<fresh private TS preflight receipt>" \
  --release-state "<actual existing release ledger>" \
  --target "<private JSON with the exact deploymentTarget>" \
  --expected-selector-sha256 "<literal build receipt base_selector_sha256>" \
  --compat-pid "<fresh verified compat PID>" \
  --core-pid "<fresh verified core PID>" \
  --deadline-seconds 600
~~~

The source must be merged into freshly fetched origin/main before this production path admits it. Isolated candidate canaries may run before merge. The coordinator does not honor an inherited emergency unmerged-rollout override.

The durable order is paired TS preflight, release admission, install intent, rollback snapshot, state preparation, launcher switch, selector switch, awaiting_restart, native and TS consumer verification, verified and completed. The coordinator rechecks the installed scheduler around each protected mutation. A private occupancy pointer is stored next to the exact selector:

~~~text
.gptadmin-entry.json.process-leases-rollout.json
~~~

It contains schema 1, job_id, job_dir, selector and phase active or resolved. The job directory contains state.json. A resolved pointer additionally pins final_state_sha256, and that state must be completed, recovered_baseline or recovered_candidate. An active, malformed or unreadable pointer blocks new installation even after an OS lock disappears or a legacy lease expires. Never remove the pointer to bypass an unresolved operation.

Lease renewal is external to ReleaseGate. While the bounded coordinator is demonstrably live, renew the same owner/token/fence through the existing release API, for example at one third of its TTL. A canonical guard holds the real resource execution lock and binding. Do not bind that resource to a second execution. Expiry, EOF or coordinator death cannot turn UNKNOWN into availability.

Read progress without creating another task:

~~~sh
python3 "$HERDER_WORKTREE/deploy/fleet/process-leases-rollout.py" status \
  --job-dir "<same coordinator directory>"
~~~

When it reaches awaiting_restart, the trusted operator performs one typed ShellMCP mcp_manage request with action restart and ref AgentHerder. Read the exact child configuration/status and actual process tree again. Record that operation's durable provider task/operation ID. Do not use the legacy HerderFleet or TS service.

### Separate restart and consumer receipts

Receipts are private JSON files submitted through the record command. They include the job's challenge from status, an observation timestamp and the exact provider operation ID. A success boolean is insufficient.

A restart receipt has this shape:

~~~json
{
  "schema":1,
  "kind":"restart",
  "job_id":"<coordinator job id>",
  "challenge":"<coordinator challenge>",
  "observed_at_unix_ms":0,
  "provider_operation_id":"<exact GPTAdmin operation/task id>",
  "target":"shell:roomhacker-server-100",
  "ref":"AgentHerder",
  "method":"mcp_manage",
  "action":"restart",
  "compat_pid":0,
  "core_pid":0
}
~~~

Use actual timestamps and PIDs. Submit it with record --job-dir ... --kind restart --receipt .... The coordinator checks the selected files, exact new process identities, pinned executable digests, configuration, profile arguments and parent relation. The prior native pair must no longer be live.

For consumer proof, call typed ShellMCP mcp_tools with ref AgentHerder after the restart, preferably as a durable provider task. Save the actual returned tools array in a separate receipt with kind consumer, method mcp_tools, the same target/ref/job/challenge, the new operation ID and observed_at_unix_ms. Add schema_sha256 as SHA256 of the tools array serialized with sorted keys and compact JSON separators. All strings in this array must be preserved.

Submit with record --kind consumer. The coordinator requires automation, resource, session and deliver schemas, including process_completion, timer, session_completion, wait_status, reconcile_process, cancel_execution, resource.bind, session.resolve and deliver.receipt. Old tools with the same names do not prove the new core is serving. The process pair is independently re-read around this evidence.

Also submit record --kind scheduler with a fresh authenticated TS consumer receipt. Use the same job ID, 64-hex challenge, TS process/source/configuration and exact native probe. The response must contain the installed gate's fresh complete wait_status decision from the newly selected authority. A preflight response with probe:null cannot serve as this consumer proof. Both native schemas and the actual TS gate must be verified before the held canonical channel reports finished.

The public HTTP endpoint was probed read-only and returned 401 without its existing OAuth context. Use the supported typed ShellMCP route for this installation. Do not create or search for a new bearer credential merely for rollout. The typed consumer receipt is evidence from the trusted operator; it is explicitly separate from independent OS/configuration verification.

After status reports completed and occupancy is resolved, release the outer project claim through its normal API. The coordinator never deletes the release proof or changes an existing ownership ledger.

## UNKNOWN, reconciliation and rollback evidence

Lost ACK, an expired lease, deadline, partial switch, changed PID/configuration or a rejected consumer schema leaves UNKNOWN. No restart is repeated and no automatic rollback runs.

Status preserves the original identity and phase. Recover requires proof that the original coordinator is dead and verifies the exact already-settled baseline or candidate configuration, running process pair and a fresh typed consumer receipt:

~~~sh
python3 "$HERDER_WORKTREE/deploy/fleet/process-leases-rollout.py" recover \
  --job-dir "<original coordinator directory>" \
  --proof "<current private proof for the same project and exact target>" \
  --outcome candidate \
  --compat-pid "<fresh verified PID>" \
  --core-pid "<fresh verified PID>" \
  --consumer-receipt "<fresh private typed tools/list receipt>" \
  --scheduler-proof "<fresh private paired TS receipt>"
~~~

For the legacy ledger, recover can settle durable occupancy after those observations under a new held release guard. It changes no selector and performs no restart. A mixed or unrelated configuration is refused.

For a canonical UNKNOWN execution binding, recover records the evidence and remains blocked. The bridge deliberately rejects a fresh guard for an unresolved old binding, even with the same proof. A separate reviewed canonical reconciliation must verify terminal evidence for the original guard and exact claim before clearing that binding. cleanup:true is valid only on the continuously held original guard channel; it is not a recovery entrypoint.

The backup retains exact previous selector/launcher bytes, hashes and modes, including evidence for a half-completed two-file switch. Library rollback validates those hashes and rejects a newer unrelated release; it requires a held mutation admission. Configuration restoration and restart after an uncertain result require a reviewed recovery procedure. Restoring a selector alone cannot migrate active process rules back to an older core. Preserve common stores, workers, claims, wake intents and authority databases; never restore an old DB snapshot to simulate rollback.

## Automatic continuation gates

A registered wait must suppress automatic model work while the process runs. src/process-wait-gate.ts is consulted before the Stop judge, cadence/unfinished judges and planners, continuation admission and native resume. Important send fences read again after asynchronous judging or admission. There is no negative-result cache and no new writable wait registry.

When explicitly using legacy local mode, the gate invokes the trusted launcher with --process-wait-status and an identity-only JSON query. The pinned process-leases-wait-status.py reader opens canonical owner databases read-only, verifies trusted principal/node/kind/native session bindings, HumanStop generation and DB/gate inode identity, then reads the canonical process, timer and session-completion rules and the exact intent or execution evidence. It does not start an adapter, worker, harness or reconciliation.

| Canonical observation | Automatic continuation |
| --- | --- |
| Registered rule before WaitState is persisted | Blocked immediately. |
| prepared, armed, dispatching, waiting_receipt, delivery_unknown, paused or rejected | Blocked. Rejected delivery needs explicit resolution. |
| A process wait whose cancellation or completed wake is settled, with matching terminal receipt, complete process tree and finished lease finalization | May continue, subject to ordinary HumanStop and admission policy. |
| A timer/dependency wait confirmed with its exact confirmed intent, or cancelled without unresolved handoff | May continue, subject to ordinary HumanStop and admission policy. |
| Missing evidence, UNKNOWN, ambiguous native binding, corrupt state, unavailable configured authority or incomplete read | Blocked. |
| Complete verified read with no exact native binding or no outstanding rule | Unblocked. |
| Active HumanStop | Blocked independently of process completion. Releasing a hold does not reauthorize an old cancelled wake. |

Pausing a wait is temporary; deleting it cancels the wake. Neither implies permission to release a lease while the process may still be alive. The process supervisor continues lease finalization independently.

With no explicit activation, an absent local selector on an older TS node is treated as feature unconfigured. A private verified legacy manifest without process_config is also unconfigured. Once configuration was observed, or an explicit selector/launcher/node mapping was set, a missing or failed local read blocks instead of silently disabling the gate.

### Remote TS schedulers use the canonical central authority

A local empty or missing store on server-44, server-88 or a Mac does not establish absence of a wait stored in the six-profile authority on server-100. Canonical mode always uses the same sealed native authority as timer and direct-resume compatibility. A missing local selector or empty store cannot disable that gate. Follow [canonical-waits-and-resume.md](canonical-waits-and-resume.md) for the common client, writer-drain and retained-record barrier.

For an explicitly configured legacy scheduler using only the remote wait gate, select the route in trusted configuration:

~~~text
AGENT_HERDER_PROCESS_WAIT_AUTHORITY=mcp:shell:roomhacker-server-100:AgentHerder
AGENT_HERDER_FLEET_MESH_CONFIG=<existing approved GPTAdmin client config>
AGENT_HERDER_FLEET_CREDENTIAL_PIN=<existing approved binding generation>
AGENT_HERDER_PROCESS_WAIT_NODE_REF=<optional exact trusted owner node>
~~~

This uses FleetGptAdminTransport and readFleetMeshBinding, including the existing origin and credential-generation pin. It calls only:

~~~json
{
  "action":"wait_status",
  "harness":"codex",
  "native_session_id":"<native session identity>",
  "node_ref":"server-44"
}
~~~

The tool is automation on the exact AgentHerder target. FleetDirectTransport is intentionally not used because it remaps to HerderFleet and may fall back to an unrelated local TS listener. Remote mode has no local or SSH fallback, no discovery, no token creation and no alternate store.

node_ref is an explicit owner identity. For example, the remote Codex owner profile uses server-44. The latest executor preflight also resolved the actual route as shell:server-44; historical aliases are not rollout evidence. Do not normalize an owner identity into a host alias by guessing. Omitting node_ref asks the authority to inspect all applicable trusted profiles; multiple native binding matches block.

WaitStatus returns version 1, configured, complete, blocked, reason, mapped, sessionRefs, ruleRefs and observedAt. Remote TS permits a continuation only after a fresh, complete typed response. Unknown/unconfigured harness authority, missing pin, credential rotation without the approved generation, stale response, error or timeout blocks. An old endpoint with no wait_status action therefore fails closed after explicit activation.

Deploy the TS gate code and this explicit route on every scheduler that can advance a centrally managed session. Native central deployment by itself does not upgrade a separate TS service. Fleet reachability and exact owner mapping must be verified through the existing read-only transport before enabling automatic work on each node. This runbook does not claim that server-44, server-88 or Macs were updated.

## Unified process API

The public tool is automation and action values use snake case. Select a registered session_ref that the caller owns. Local start/attach runs on the configured local execution node even when its destination session belongs to a different harness. RemoteStart instead selects one trusted executor_ref and preserves separate controller/executor identities. See [remote-process-execution.md](remote-process-execution.md); no local SSH-client exit can stand in for an executor receipt.

~~~json
{
  "action":"create",
  "session_ref":"<registered owner session>",
  "request_key":"<stable key for this build>",
  "rule":{
    "kind":"process_completion",
    "execution":{
      "mode":"start",
      "argv":["/usr/bin/true"],
      "cwd":"/home/roomhacker/agents-projects/agent-herder",
      "deadline_unix_ms":null,
      "stop_grace_ms":5000
    },
    "bindings":[{
      "resource_ref":"<registered resource>",
      "claim_id":"<current claim nonce>",
      "revision":1,
      "ttl_seconds":60,
      "on_exit":"release",
      "handback_seconds":null
    }],
    "wake_message":"The build completed. Read its receipt and verify its artifacts."
  }
}
~~~

The claim must already be owned at its current descriptor revision. Use on_exit handback with bounded handback_seconds when the resumed agent needs a short ownership interval after completion. Commands are argument vectors.

Attach uses execution mode attach with pid, observed boot_id, start_ticks and optional deadline_unix_ms. A PID alone is not durable identity and does not establish an exit code. Supervised start provides stronger completion evidence. An unrelated local SSH client's exit does not prove a remote build has completed.

Read a rule with action get and rule_ref. Reconcile with reconcile_process. Cancel the execution with cancel_execution, rule_ref and a stable request_key. resource.bind accepts execution_ref plus the same binding fields for a separately admitted execution. These operations use the common Herder authority and claim fence.

After installation, a designated isolated native acceptance session must demonstrate renewal past the original TTL, a matching terminal receipt, release or bounded handback, exactly one durable wake intent, idempotent registration, busy-parent retry and no old-wake reauthorization after HumanStop. Running configuration and tools/list are necessary evidence, but they do not substitute for this behavior check.

## Legacy compatibility and unresolved evidence

At checkpoint 0d398e19, packages/agent-resume/src/mcp/server.ts no longer creates JobRegistry work for run_and_resume, attach_pid_and_resume, attach_query_and_resume or wait_and_resume. Legacy effects require an explicitly injected HerderLegacyFacade; without it they return the retirement/migration result. They never start a fallback scheduler, Python watcher, lease keeper or alternate wake queue. Compatibility reads and immutable target utilities may remain while callers still use them.

In canonical mode, src/resume-transport.ts and src/resume/core-transport.ts use the shared CanonicalAutomationClient and do not construct ReceiptLedger. Direct sends reserve principal-wide compatibility keys in the existing resource authority, inspect deliver.receipt and reconcile the exact original task after uncertain ACK. The former ReceiptLedger remains sealed read-only evidence and reserves all old keys. resume_after, scheduled delivery, judges and admission gates use the same configured native authority and migration barrier. A broken canonical configuration never falls back to legacy effects.

The standalone process fallback is retired. Old aliases are compatibility surfaces, not an independent Agent Resume deployment. Legacy mode exists only until the explicit writer drain and reviewed cutover; choosing canonical mode does not import or bulk-replay old work.

Preserve the 47 legacy records whose metadata said running while both recorded process and watcher PIDs were absent. They need individual reconciliation. Do not mass-wake, relaunch or infer success. Existing profile databases also contain UNKNOWN operations; installation does not reset them. Bounded config inventory found no active standalone AgentResume entry in the inspected server-100 Codex, OpenCode and Hermes configs; it did not establish fleet-wide absence.
