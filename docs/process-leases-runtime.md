# Process leases: native runtime rollout

This runbook updates the existing Agent Herder public MCP on server-100. It packages the native core and its process worker together, keeps the currently pinned AHAP adapters, and installs one trusted process configuration. The worker is a companion executable of Herder, not a service or a second resume scheduler.

The release helper is **deploy/fleet/process-leases-candidate.py**. Run it as the account that owns the installed selector and profile files, currently roomhacker. It never restarts a child, sends an agent prompt, cancels a process, migrates an authority database, or replays an old wait. Install and rollback update configuration only; verify the running consumer after the explicit child restart.

## Runtime baseline observed on 2026-11-13

Re-read the actual configuration before rollout. Paths and hashes below identify the reviewed baseline; they are not a substitute for the helper's compare-and-swap checks.

| Surface | Actual entry or state | Rollout consequence |
| --- | --- | --- |
| Public native MCP | GPTAdmin child AgentHerder, endpoint https://mcp.bezrabotnyi.com/server/agentherder/mcp | This is the consumer to restart and probe. |
| Installed launcher | /home/roomhacker/.local/bin/agent-herder-v1 | Python source without a .py extension. |
| Child selector | /home/roomhacker/.config/agent-herder/gptadmin-entry.json | HERDER_V1_ENTRY in the child configuration selects this file. |
| Default CLI selector | /home/roomhacker/.config/agent-herder/v1-entry.json | Independent file. Updating the child selector does not update default CLI calls. Use the explicit child selector for checks, and review any default-selector switch separately. |
| Selected manifest | /home/roomhacker/herder-artifacts/releases/ahap-opencode-resume-bce62de3-v1/manifest.json | Baseline manifest SHA256 4a711887a69126c02ac870b42c896f806db312382f83120f998a45c00a1fe770. |
| Pinned components | Core and browser adapter from a7fbc548; compat, Node, bootstrap, Codex and ZCode from cebecc13; OpenCode from bce62de3 | Preserve their component provenance. Only core, worker and process configuration change in this rollout. |
| Existing profiles | Six: local Codex, remote44 Codex, noticeplace OpenCode, ChatGPT browser, ZCode, ZAI | Preserve exact profile paths, their content hashes, remote wrapper pins, and every existing DB path. |
| Separate TS service | agent-herder.service, deployed source c9bc35a6, port 127.0.0.1:18787 | Restarting it does not replace the public Rust core. |
| NoticePlace bridge | agent-herder-v1-noticeplace.service, deployed source b33f5b37, port 127.0.0.1:18797 | Existing bridge targets the public native MCP. No bridge replacement is required for the worker. |

Do not use rollout-mcp-child.py for this native release. It addresses an older TypeScript child and a different deployment ledger.

The source worktree is based on fetched b371e9a0e57f12f44bf069ef5277e71afb81991f. The older local main change 98593d9c is retained separately until its behavior is assessed. A release must not replace newer installed components with a build from that older local main.

## Candidate contract

A candidate contains fixture/herder_native_stdio, fixture/herder_process_worker, fixture/launch-v1-core.py, fixture/process-runtime.json, manifest.json, selector.json, a build log and process-leases-build.json.

The manifest pins both executable hashes and the configuration hash:

- process_worker, sha256.process_worker, environment HERDER_PROCESS_WORKER.
- process_config, sha256.process_config, environment HERDER_PROCESS_CONFIG.
- process-runtime.json contains version 1, the real execution node, the immutable worker path, common durable execution and resource roots, a local StorageAuthority, and administrators derived from the selected trusted owner profiles.
- The current six profiles all use the principal local-owner. The helper records every profile hash and refuses installation if a profile changes after the candidate is built.
- source_commit describes the new core and worker. Existing adapter provenance and remote AHAP wrapper descriptors are retained, with the base manifest and its digest recorded separately.

Use stable store identities across releases. The example below uses a common local resource authority, not a per-build lease directory. Resource marker storage.json is exactly {"schema":"v1","storage_id":"herder-server-100-v1"}. The execution engine owns its store.json, including the node identity. Project-scoped resources additionally require an existing project marker; the helper never invents one.

Candidate build and check validate roots without creating them. Install creates missing private roots and the resource marker only after saving a rollback receipt. Existing markers, canonical paths, ownership and private permissions must match. A nonempty unmarked store is rejected. Roots and resources/ use mode 0700, and storage.json uses 0600. Existing databases and profile files are not rewritten.

## Build and inspect

Complete the implementation review and meaningful native tests in the isolated worktree, then commit it. The release build requires a clean committed worktree before and after Cargo runs. Keep normal release ownership over the deployment target while installing; the helper's local selector lock does not replace that ownership.

The parent directory of each chosen state root and of the candidate output must already exist. All paths must be absolute and canonical. Example on server-100:

~~~sh
HERDER_WORKTREE=/home/roomhacker/agents-projects/.worktrees/herder-process-leases-20261113
HERDER_SOURCE_SHA="$(git -C "$HERDER_WORKTREE" rev-parse HEAD)"
HERDER_BUNDLE="/home/roomhacker/herder-artifacts/releases/herder-process-leases-$HERDER_SOURCE_SHA"
HERDER_SELECTOR=/home/roomhacker/.config/agent-herder/gptadmin-entry.json

python3 "$HERDER_WORKTREE/deploy/fleet/process-leases-test.py"
python3 "$HERDER_WORKTREE/deploy/fleet/process-leases-candidate.py" build \
  --repo "$HERDER_WORKTREE" \
  --cargo /home/roomhacker/.cargo/bin/cargo \
  --selector "$HERDER_SELECTOR" \
  --output "$HERDER_BUNDLE" \
  --build-dir /home/roomhacker/herder-artifacts/build/process-leases \
  --node-ref roomhacker-server-100 \
  --execution-root /home/roomhacker/.local/state/agent-herder/process-executions \
  --resource-root /home/roomhacker/.local/state/agent-herder/resource-authority \
  --storage-id herder-server-100-v1

python3 "$HERDER_WORKTREE/deploy/fleet/process-leases-candidate.py" check \
  --selector "$HERDER_BUNDLE/selector.json" \
  --launcher "$HERDER_BUNDLE/fixture/launch-v1-core.py"
~~~

The helper runs cargo build --locked --release for herder_native_stdio and herder_process_worker in the same source tree, with a separate Cargo target directory. It hashes the copied binaries, checks source and selector stability, and calls only the launcher's preparation function. Candidate checks do not initialize a native harness or contact a remote owner.

Inspect the manifest, config and build receipt. Verify the actual node, stable roots, administrator list, source commit, preserved profile paths and component pins. Record the returned candidate selector hash and the receipt's base_selector_sha256.

## Install, restart and observe

Install requires the reviewed baseline selector hash as a literal value. A changed selector or profile requires a new candidate review; do not bypass the check by substituting a new hash.

~~~sh
python3 "$HERDER_WORKTREE/deploy/fleet/process-leases-candidate.py" install \
  --candidate "$HERDER_BUNDLE/selector.json" \
  --selector "$HERDER_SELECTOR" \
  --launcher /home/roomhacker/.local/bin/agent-herder-v1 \
  --backup "/home/roomhacker/herder-artifacts/releases/process-leases-backup-$HERDER_SOURCE_SHA" \
  --expected-selector-sha256 "<base_selector_sha256 from process-leases-build.json>"
~~~

The helper saves exact selector and launcher bytes, hashes and modes in a new private backup directory. It first installs the backward-compatible launcher, then atomically replaces the selector. The return status is **configured_pending_restart**, not deployment success. If the second replacement fails, the saved receipt can restore the half-switched configuration.

After the integrated candidate has passed review:

1. Re-read mcp_manage configuration on shell:roomhacker-server-100 and confirm child AgentHerder still uses this launcher and explicit selector.
2. Restart that child once through mcp_manage with {"action":"restart","ref":"AgentHerder"}. Do not restart unrelated user services.
3. Read the installed launcher receipt with HERDER_V1_ENTRY="$HERDER_SELECTOR" /home/roomhacker/.local/bin/agent-herder-v1 --check. Match manifest, core, worker and config digests to the candidate.
4. Hash the actual native child executable through its verified /proc/<pid>/exe and compare it to the candidate core. Obtain the current PID from the child/process inventory, not a saved PID.
5. Read public MCP discovery and its automation/resource schemas. Confirm process_completion, reconcile_process, cancel_execution and resource.bind are exposed. Discovery must not initialize a harness.
6. Run a short process completion acceptance case using an isolated owned session and resource. Confirm the worker runs on the configured execution node, the claim stays owned beyond its original TTL, process exit produces a durable receipt, and the selected release or handback action occurs.
7. Confirm exactly one durable wake intent and a stable idempotency result for the same request key. Repeating reconciliation must not send another prompt. Check completion during a core restart, a failed build, cancellation, deadline expiry and an unavailable target in the targeted native test suite. A real prompt acceptance case must use a session designated for that test, never an unrelated native conversation.

Step 3 checks configuration only. Steps 4 through 7 establish running-consumer behavior. Do not describe the release as deployed on all harnesses until the shared endpoint is verified and each supported adapter's existing resume contract remains valid.

## Unified API examples

The public tool name is automation; action values are snake case. Use a canonical, registered session_ref owned by the caller. A process is started on the configured local execution node even if the destination session is routed to a different harness.

~~~json
{
  "action": "create",
  "session_ref": "<registered owner session>",
  "request_key": "<stable key for this build>",
  "rule": {
    "kind": "process_completion",
    "execution": {
      "mode": "start",
      "argv": ["/usr/bin/true"],
      "cwd": "/home/roomhacker/agents-projects/agent-herder",
      "deadline_unix_ms": null,
      "stop_grace_ms": 5000
    },
    "bindings": [
      {
        "resource_ref": "<registered resource>",
        "claim_id": "<current claim nonce>",
        "revision": 1,
        "ttl_seconds": 60,
        "on_exit": "release",
        "handback_seconds": null
      }
    ],
    "wake_message": "The build completed. Read its receipt and verify its artifacts."
  }
}
~~~

The claim must already be owned, with the actual current descriptor revision. Use on_exit: "handback" and a bounded handback_seconds when the resumed agent needs a short ownership interval after the process exits. The command is an argument vector; use an explicit shell argument vector only when shell semantics are intended.

An existing process uses execution: {"mode":"attach","pid":1234,"boot_id":"<observed boot id>","start_ticks":123456,"deadline_unix_ms":null}. PID alone is not durable identity and cannot prove an exit code. For a real build that needs a reliable receipt, prefer supervised start. A remote build needs a verified remote job receipt; attaching an unrelated local SSH client does not prove remote build completion.

Read with {"action":"get","rule_ref":"<returned rule>"}. Explicitly reconcile with {"action":"reconcile_process","rule_ref":"<returned rule>"}. Cancel through {"action":"cancel_execution","rule_ref":"<returned rule>","request_key":"<stable cancel key>"}. Cancellation is distinct from deleting or pausing a wait: a process must be observed terminal before its lease is treated as releasable.

A separately started execution can bind a current owned claim through the resource tool using {"action":"bind","execution_ref":"<execution>","binding":{...}}. Reuse the same binding fields. The execution identity and claim fence are checked by the shared Herder authority.

## Legacy compatibility and outstanding state

The standalone scheduler entrypoints live in packages/agent-resume/src/mcp/server.ts: run_and_resume, attach_pid_and_resume, attach_query_and_resume, wait_and_resume and wait_job_status. The first four currently create JobRegistry work and await jobs.complete. Their migration must be a facade that registers or reads a Herder rule; it must not create another watcher, timer, lease keeper, durable wake queue or fallback Python process.

Map run_and_resume to process_completion/start and a native session binding; map PID attachment to process_completion/attach with verified identity. Query attachment must reject ambiguous matches rather than silently select the first process. Duration-only waits belong to the existing native schedule facility and require a documented semantic mapping. Legacy job_id aliases need durable mapping to the new rule and execution references. A status call must read the registered result instead of starting or replaying it.

Do not remove the whole workspace package while its client, target-binding and receipt utilities are used by src/adapters/opencode.ts, src/resume-transport.ts and src/resume/{core-transport,core-binding}.ts. The old Python default also appears in scripts/autopilot-command-launcher.sh. Retirement of these paths requires a caller migration, not just renaming the package.

The bounded server-100 inventory found no active standalone AgentResume entry in the inspected Codex, OpenCode and Hermes MCP configs. That is evidence for those files, not proof about all fleet nodes. Existing TypeScript resume_after state is a separate compatibility queue.

At inventory time, 47 legacy job records said running while their recorded process and watcher PIDs were absent. Preserve them as unresolved legacy evidence until reconciled individually. Do not mass-wake them, relaunch commands, or infer success. Existing profile DBs also contain unknown operations; the install helper does not reset them.

## Rollback

Before rolling back a running process-aware core, identify active executions and pending wake intents. Drain them or keep an explicitly compatible supervisor able to finish them. An older core does not understand new process rules, so merely restoring a selector is not an execution-state migration. Do not stop workers or restore old DB snapshots as a shortcut.

~~~sh
python3 "$HERDER_WORKTREE/deploy/fleet/process-leases-candidate.py" rollback \
  --receipt "/home/roomhacker/herder-artifacts/releases/process-leases-backup-$HERDER_SOURCE_SHA/receipt.json"
~~~

Rollback accepts only the recorded before/after hashes, including a half-completed switch. It refuses to overwrite a newer unrelated release. It restores exact selector and launcher bytes and reports **configuration_rolled_back_pending_restart**. Common state, workers, claims and authority databases remain intact.

Restart the same child explicitly after the rollback configuration is reviewed. Recheck the launcher, actual core executable and public endpoint. Retain the candidate, backup receipt and durable process evidence until the outcome is settled.
