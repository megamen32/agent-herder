# Remote process completion

`automation.process_completion` accepts `execution.mode = "remote_start"` when the installed process configuration names a supported executor. The controller uses the existing pinned Fleet GPTAdmin transport. The execution node runs the same `herder_process_worker` artifact with an internal endpoint protocol. It does not open a resource authority, create claims, or resume agents.

This is source support for remote execution. A unit test or a successful build of the companion is not a native acceptance result. Record the exact installed artifacts and the isolated native execution receipt before enabling a production executor.

## Boundaries

* The resource authority remains the controller's existing `StorageAuthority`. The existing claim ID, principal, descriptor revision, expiry, and durable execution occupancy fence the operation.
* `ExecutionRecord.node_ref` identifies the controller. A remote command's receipt and native process identities identify the executor. Remote PIDs never populate the controller's local `process` or `observed_members` fields.
* A caller selects an installed `executor_ref`, argv, canonical remote cwd, and an absolute deadline. The caller cannot select a transport endpoint, credential generation, remote worker, configuration path, or execution root.
* The immutable handle binds the controller node, executor node, execution reference, original controller payload hash, remote command hash, worker/configuration hashes, execution root device/inode, random nonce, boot identity, and deadline.
* A remote live observation can renew canonical claims only when its round trip took at most two seconds. The local five second freshness window starts before the RPC. A delayed live ACK cannot refresh that window. Immutable terminal evidence can arrive later.
* A start permit uses the executor's observed boot clock and expires in at most four seconds. It cannot outlive the current canonical claims or the remote deadline. The endpoint checks it before unit admission, and the worker checks it again immediately before command exec.
* A lost start ACK never causes another start request. The controller persists `start_dispatched` and the original permit before the only start RPC.

Remote attachment to an arbitrary PID with delegated leases is unsupported. The first provider supports owned commands on Linux with a verified independent deadline. macOS remains unsupported for remote lease execution until a coalition-aware independent watchdog is implemented and verified. Local macOS supervision remains separate and unchanged.

## Independent deadline on Linux

The command runs in the existing private transient unit named `herder-process-<execution_ref>.service`. Before argv is admitted, the worker starts a companion transient unit named `herder-deadline-<execution_ref>.service`, using the same pinned worker binary. This is an observer for one execution, not a new persistent daemon or scheduler.

The endpoint converts the requested UNIX deadline to `CLOCK_BOOTTIME` once and persists that cutoff with the boot identity. Retry and restart read the saved cutoff. A wall clock change cannot extend it. Linux suspend time counts toward the boot clock.

The companion runs outside the command's cgroup. It opens the exact cgroup directory, verifies its device/inode and boot identity, then opens `cgroup.kill` relative to that pinned directory descriptor. It keeps that descriptor open. There is no path-only signal fallback. A replaced cgroup cannot receive the old execution's kill.

Admission requires a ready record for the exact handle/cgroup state, a held companion lock, and a live exact companion process identity. If the unit, private cgroup, writable kill descriptor, ready proof, or permit is unavailable, the command is not spawned. `Restart=on-failure` restarts only this observer with the same saved deadline. It never relaunches the command. The command unit also receives a relative `RuntimeMaxSec` backstop; that relative timer is not the proof of the absolute cutoff.

At or after the cutoff, when scheduled by the kernel, the companion signals the pinned cgroup. A successful signal is not a completion receipt. The observer retains the record until the kernel proves the scope empty. Ordinary successful completion disarms it only through the exact immutable receipt with `tree_complete = true` and `process_may_be_running = false`.

Loss of the central lease does not mean an instantaneous remote kill. A reachable controller requests cancellation by the exact handle. During a network partition, renewal stops, occupancy remains unresolved, and the independent cutoff limits the execution. Host failure, an unavailable kernel scope, or missing terminal evidence remains `UNKNOWN`; the controller never fabricates a successful exit.

## Installed configuration

Existing configurations remain valid with `remote_executors` omitted or empty. Add an executor only after its exact node and artifacts have been reviewed. All hashes below are SHA-256 values of the complete installed files, not source paths or mutable symlinks.

The controller's `ProcessRuntimeConfig` adds:

```json
{
  "remote_executors": [{
    "executor_ref": "linux-builder",
    "node_ref": "executor-node-identity",
    "transport": {
      "node_binary": "/immutable/node",
      "node_sha256": "<64 lowercase hex characters>",
      "bridge": "/immutable/herder-process-remote-bridge.mjs",
      "bridge_sha256": "<64 lowercase hex characters>",
      "fleet_mesh_config": "/private/existing-fleet-client-config.json",
      "credential_pin": "<existing approved Fleet generation>",
      "target": "shell:exact-host-name"
    },
    "worker": "/immutable/herder_process_worker",
    "worker_sha256": "<64 lowercase hex characters>",
    "endpoint_config": "/private/herder-remote-executor.json",
    "endpoint_config_sha256": "<64 lowercase hex characters>",
    "execution_root": "/private/herder-remote-executions",
    "root_device": 123,
    "root_inode": 456,
    "max_runtime_ms": 3600000,
    "deadline_capability": "linux_boot_watchdog_v1"
  }]
}
```

The endpoint configuration is private, owned by the executor UID, and pinned by its complete file hash:

```json
{
  "version": 1,
  "controller_node_ref": "controller-node-identity",
  "executor_ref": "linux-builder",
  "node_ref": "executor-node-identity",
  "worker": "/immutable/herder_process_worker",
  "worker_sha256": "<64 lowercase hex characters>",
  "execution_root": "/private/herder-remote-executions",
  "root_device": 123,
  "root_inode": 456,
  "max_runtime_ms": 3600000,
  "deadline_capability": "linux_boot_watchdog_v1"
}
```

Initialize the dedicated executor store through `ExecutionStore::open` during reviewed installation. Its `store.json` is `{"schema_version":1,"node_ref":"executor-node-identity"}`. Pin the existing canonical root's actual device and inode. The endpoint never initializes a different root on demand. Directory and configuration permissions are private; executable artifacts must be owned by the current UID or root and not group/world writable. Canonical file paths cannot drift through symlinks.

The bridge reuses `readFleetMeshBinding` and `FleetGptAdminTransport`. It loads the already approved credential generation from the existing private configuration. It performs one exact structured `shell_exec` call. It performs no discovery, SSH fallback, credential creation, shell string interpolation, or mutation retry. Install it as a standalone bundled artifact so the pinned file hash covers its dependency closure. A rotated credential or replaced artifact fails closed and requires explicit operator reconciliation of the installed route.

Use lease TTLs comfortably above the transport deadline and polling interval. A short TTL that expires during an RPC cannot be revived by a later live response. The controller cancels by the original handle when reachable and retains occupancy until terminal evidence is reconciled.

## Internal commands and artifacts

The Fleet bridge invokes exactly:

```text
<pinned worker> --remote-config <absolute config> --config-sha256 <exact hash> --request <one JSON object>
```

The JSON operation is one of `prepare`, `start`, `status`, `reconcile`, or `cancel`. Every request and response carries a new request ID and the fixed controller/executor route. `prepare` is idempotent and does not run argv. `start` requires the exact handle and one short-lived permit. `status` and `reconcile` cannot launch work. `cancel` targets the saved handle, not a guessed PID or command substring.

The independent companion invokes exactly:

```text
<same pinned worker> --deadline-watchdog --store <executor root> --execution <exact execution_ref>
```

The controller uses its ordinary local worker invocation and canonical bindings:

```text
<controller worker> --store <controller root> --execution <exact execution_ref>
```

Controller evidence includes `remote-control.json`, the original executor receipt, source evidence captured on the executor, and the first central time that terminal evidence was received. Handback uses this fixed central observation time, preventing a remote clock skew or a repeated reconciliation from extending its grace period. Expired claims are never revived.

Executor evidence includes `remote-origin.json`, `remote-start-permit.json`, `remote-deadline.json`, `remote-deadline-ready.json`, and, when fired, `remote-deadline-fired.json`. The normal immutable receipt, stdout/stderr paths, and whole-tree proof remain in the executor store. A path to a remote log is not read as a local path.

## Reconnect and cancellation

The detached central controller survives a core restart. If that controller itself dies, canonical reconciliation may start a new observer for the same record. It consults the durable start boundary:

| Durable state | Reconnect behavior |
| --- | --- |
| Start was dispatched | Read/reconcile the exact handle; never repeat start |
| Prepare ACK was lost, no start dispatch | Recover the original preparation by the same command/key, then cancel it without admitting argv |
| Worker or scope disappeared without whole-tree proof | Keep `UNKNOWN` and resource occupancy |
| Exact terminal receipt available | Finalize canonical lease bindings idempotently, then apply the existing wake policy |
| Route/config/artifact identity changed | Keep `UNKNOWN`; no fallback executor or replacement command |

HumanStop cancels a future wake and prevents a new Prepared launch through the existing canonical gate. It does not silently kill a command already admitted. Cancellation of an owned remote execution uses the separate exact-handle cancellation path. Native harness continuation also retains its installed capability gate; remote process support does not override a harness that cannot safely resume.

The metadata-only wait reader validates remote receipts against the original request, installed executor, handle, command/payload hashes, correlation ID, and durable receipt. An executor receipt cannot be substituted with a controller receipt. Missing receipt, changed proof, or pending finalization keeps the wait blocked.

## Verification

Focused tests cover lost prepare/start ACK, observer restart without replay, network loss without renewal, expired authorization, target/spec/root/nonce substitution, changed artifact pins, stale live responses, bounded transport timeout, and a descendant retaining the bridge's stdout. Python tests cover the exact remote wait proof and conservative failure. TS tests cover the pinned Fleet route, one-call semantics, malformed responses, and credential generation changes.

Native acceptance additionally requires a pinned isolated Linux execution. Verify the command really runs on the executor, the central lease renews while fresh executor observations arrive, stopping the core leaves the worker alive, losing the central observer does not repeat argv, the watchdog retains the original cutoff across its own restart, and the final receipt identifies the executor and proves the entire tree stopped. Do not attach a model wake to this first infrastructure canary.

### Opt-in native driver

`crates/herder/tests/process_remote_native.rs` is ignored by default. It creates one dedicated canary resource through the existing resource APIs, prepares one RemoteStart record, delegates its canonical lease, and invokes the configured worker. It does not call a harness. The configuration must be an absolute canonical private file, and its explicit principal must already be in the supplied installed runtime's administrator policy.

The driver configuration has this exact shape:

```json
{
  "version": 1,
  "runtime": "<complete ProcessRuntimeConfig object, not a path>",
  "controller_worker_sha256": "<hash of the immutable controller worker>",
  "principal": "qa-remote-canary-v1",
  "session_ref": "qa-remote-infrastructure-v1",
  "request_key": "remote-canary-server44-v1",
  "resource_ref": "remote-canary-server44-slot-v1",
  "claim_id": "<new UUID>",
  "executor_ref": "server44-builder",
  "argv": ["<reviewed exact command and arguments>"],
  "cwd": "/root/herder-artifacts/process-leases-20261113/remote-canary-executor-v1/work",
  "deadline_unix_ms": 0,
  "ttl_seconds": 15,
  "timeout_seconds": 120
}
```

Replace `runtime` with the actual object and set the absolute deadline shortly before the run, typically current executor UNIX milliseconds plus 90 seconds. The placeholders are not a runnable configuration. Use a fresh dedicated resource/request key for a reviewed first run. An existing execution directory is refused rather than replayed. Use a command lasting at least 40 seconds so renewal beyond the original 15 second TTL is observable.

For the reviewed server-44 staging layout, the exact remote target is `shell:server-44`, the executor UID is root, and the executor paths are under `/root/herder-artifacts/process-leases-20261113/remote-canary-executor-v1`. The controller is `roomhacker-server-100`, UID 1000, with its private fixture under `/home/roomhacker/herder-artifacts/process-leases-20261113/remote-canary-controller-v1`. These are staging identities, not default product configuration. Validate the current boot, actual roots, canonical paths and file hashes again before the run. Airlock is excluded.

Build the driver without effects:

```sh
cargo test --manifest-path crates/herder/Cargo.toml --test process_remote_native --no-run
```

After the exact artifact hashes, private configurations, source command and target identity are reviewed, run only the ignored canary:

```sh
HERDER_REMOTE_CANARY_CONFIG=/home/roomhacker/herder-artifacts/process-leases-20261113/remote-canary-controller-v1/config.json \
cargo test --manifest-path crates/herder/Cargo.toml --test process_remote_native remote_owned_job_native_canary -- --ignored --exact --nocapture
```

The test writes a private `canary-summary.json` beside the controller execution. It verifies the executor receipt, claim renewal past the original TTL, terminal release, controller/executor separation, and the durable start boundary. Read the marker on the exact executor separately through the existing authorized read path and require exactly one occurrence of the execution reference. Verify the compiled artifact there as well. The driver deliberately cannot turn a remote log path into a local read or a general remote file API. A failed capability check, timeout, missing receipt or failed artifact check is not native acceptance. Retain the exact execution and its evidence; never turn `UNKNOWN` into a replacement build.
