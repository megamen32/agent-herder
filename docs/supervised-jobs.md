# Supervised jobs and resource leases

Agent Herder owns process supervision, resource claims and session continuation. A long operation uses the existing public **resource** and **automation** tools. The process worker is a companion executable in the same release. It renews claims without running an agent or calling a model.

## Standard procedure for every harness

1. Resolve the exact registered session with session.resolve and check its automatic-continuation capability. Resolve the registered resource to protect. Reuse a shared resource identity for a shared device, deployment target or build slot.
2. Acquire the resource claim and keep its returned claim ID and descriptor revision.
3. Create one process-completion rule with a stable request key. Start through Herder when possible. Include the claim bindings in the same request.
4. Check that the response contains the durable rule and execution references. If its status is pending reconciliation, inspect that same registration. Never start another command because an acknowledgement is missing.
5. Once the wait is armed, end the current agent turn. After completion Herder continues the same native session when its native admission and stop policy allow it. A busy session is deferred; an uncertain delivery remains visible for reconciliation. Do not poll with model turns and do not use HumanStop to simulate sleeping.
6. On wake, inspect the completion receipt, source evidence and logs. Verify the produced artifact before using or deploying it. A successful process exit is evidence about that process, not proof that an application was deployed.

The worker is responsible for lease renewal. The agent does not have to remain connected. The shared automatic-continuation gate reads durable process, timer and session-completion waits before starting an LLM judge, inventory continuation or cadence turn.

The installed harness must support the required native admission contract. An isolated OpenCode v2 canary produced two native assistant turns for one wake. This release's core disables automatic continuation for every OpenCode protocol, including v22, until its native admission contract is verified. The updated runner advertises unsupported-no-idle-admission-v1; this candidate capability is not evidence that the unchanged shared installation already contains it. Automatic wait creation refuses before a process or lease binding starts on those profiles. Explicit manual delivery and fresh-session creation have separate contracts. Do not infer support from the existence of an automation tool alone.

## Resource identity

A resource is a registered descriptor plus a canonical current claim. Its kind can be device, deployment, workspace, plan or a custom name such as build. Scope can be global, a registered project or a node.

Examples of distinct resources include a physical Android device, a particular deployment target, a workspace, and one concurrency slot on a builder. Use one identity for the actual shared thing. Creating a new resource for every attempt does not serialize access to the same device or target.

Registration is an administrative operation, normally performed once:

~~~json
{
  "action": "register",
  "resource_ref": "build-slot:server-100:herder",
  "scope": {"type": "node", "node_ref": "roomhacker-server-100"},
  "kind": {"type": "other", "name": "build"},
  "external_ref": "builder:server-100:herder-slot",
  "authority_ref": "<installed storage ID>"
}
~~~

The installed configuration selects the storage authority and allowed administrators. An MCP argument cannot authorize its own principal or replace the configured authority. A descriptor update uses revision CAS. A matching external reference cannot silently create another resource identity.

Acquire using a new request key for a genuinely new acquisition:

~~~json
{
  "action": "claim",
  "resource_ref": "build-slot:server-100:herder",
  "purpose": "Build the reviewed Herder revision",
  "request_key": "<stable acquisition key>",
  "expires_at": "<future RFC3339 UTC timestamp>"
}
~~~

Read **resource.get** to obtain the current **resource.revision**, **claim.claim_id**, **claim.expires_at**, **claim_live** and **execution_binding**. Advisory worktree declarations identify ongoing work but do not acquire a claim.

A request replay preserves the original acquisition identity. An expired or retired nonce cannot be renewed into a new acquisition. Each operation checks the exact claim ID, owner, resource revision and execution binding before changing ownership.

## Durable registration of execution and continuation

Pass an argument vector and an absolute working directory. The following is an example to adapt to an existing owned session and claim:

~~~json
{
  "action": "create",
  "session_ref": "<registered session>",
  "request_key": "<stable build operation key>",
  "rule": {
    "kind": "process_completion",
    "execution": {
      "mode": "start",
      "argv": ["/usr/bin/make", "build"],
      "cwd": "/absolute/path/to/worktree",
      "deadline_unix_ms": null,
      "stop_grace_ms": 5000
    },
    "bindings": [{
      "resource_ref": "build-slot:server-100:herder",
      "claim_id": "<current claim ID>",
      "revision": 1,
      "ttl_seconds": 60,
      "on_exit": "release"
    }],
    "wake_message": "The build finished. Inspect the attached receipt and verify its artifact."
  }
}
~~~

The request is written durably before the command starts. Registration, supervisor admission and continuation use fenced recovery phases; they are not one external transaction. Repeating the same request key and payload reads the same operation; changing that payload under the same key conflicts. A configured local deadline is absolute and survives a core restart. RemoteStart requires an absolute deadline.

Choose **on_exit: release** for a build slot that is free when the process tree ends. Choose **on_exit: handback** with **handback_seconds** when the same session needs a bounded follow-up interval, for example to inspect a device after testing. The handback deadline is anchored to the original completion timestamp. Reconciliation cannot extend it indefinitely or resurrect an expired claim.

A process can bind multiple existing claims. Registration checks every binding before the first effect. Later **resource.bind** can add a current claim to an already owned, confirmed-live execution. It cannot bind another principal's execution or attach a stale claim.

The session's harness location and the execution node are different concepts. A remote Codex conversation can wait for a build on server-100. That does not turn the build into a server-44 process. The installed execution configuration and receipt name the actual executor.

## Timers, dependencies and compatibility

A timer uses automation.create with rule.kind timer and a delay or absolute trigger. The native authority persists the due instant once. A session-completion rule captures exact registered dependencies and their current native turn identities; an idle projection is insufficient. These rules share the process wait's lifecycle, HumanStop fence, busy-session deferral and durable delivery path. See [canonical-waits-and-resume.md](canonical-waits-and-resume.md) for exact request examples and migration configuration.

In canonical mode, resume_after and scheduled delivery are stateless compatibility facades. They create no timer loop or second writable registry. Direct resume compatibility resolves the same native authority and reads deliver.receipt before a new send. A principal-wide compatibility key reserves one exact session and payload in the existing resource authority. Reusing that key for another target conflicts, including after a lost ACK.

## Remote owned execution

RemoteStart uses an executor_ref from the installed trusted capability list, not an arbitrary SSH host supplied by an agent. The remote endpoint returns an immutable handle and authoritative executor evidence. The controller renews the same central resource claims; the executor owns no second claim ledger. Its independent Linux deadline supervisor continues even if the controller or transport disappears. A delayed live reply cannot extend freshness indefinitely.

Only a configured, pinned provider can start remote work. A missing start ACK retains the same operation for observation and never submits the command again. Remote lease execution on macOS and lease-bound RemoteAttach are explicitly unsupported until they have the required independent supervisor. See [remote-process-execution.md](remote-process-execution.md) for configuration, receipt guarantees and native acceptance.

## Attach an existing local process

Use this only when the process was already started:

~~~json
{
  "action": "create",
  "session_ref": "<registered session>",
  "request_key": "<stable attachment key>",
  "rule": {
    "kind": "process_completion",
    "execution": {
      "mode": "attach",
      "pid": 12345,
      "boot_id": "<observed boot identity>",
      "start_ticks": 987654,
      "deadline_unix_ms": null
    },
    "bindings": [],
    "wake_message": "The observed process changed state. Inspect the receipt before continuing."
  }
}
~~~

Herder records process birth and boot identity. PID reuse cannot turn an old observation into authority over a new process. Attachment does not provide a parent's wait status and cannot invent an exit code or prove that an untracked process tree is empty. If completion cannot be established, the receipt says UNKNOWN and any unresolved occupancy remains blocked.

A local SSH client exiting does not prove that its remote build has finished. Remote execution requires its own authoritative job identity and completion evidence on the executor. Use only the backend advertised by the installed runtime; an unsupported backend must fail before starting work.

## Read and control the existing operation

| Intent | Public operation | Effect |
| --- | --- | --- |
| Inspect a wait | automation.get with rule_ref | Returns its registration, current wait state and execution evidence. |
| Check a remote scheduler before a model turn | automation.wait_status with harness, native_session_id and optional exact node_ref | Reads canonical waits across the configured owner profiles without contacting a harness. Incomplete, unavailable or ambiguous evidence blocks automatic continuation. |
| Inspect all session waits | automation.list with session_ref | Reads registered rules. |
| Reconcile an existing process wait | automation.reconcile_process with rule_ref | Can admit the original Prepared execution, recover its observer, finalize claims and dispatch its original wake, subject to the existing gates. It does not create a replacement build. |
| Inspect a direct continuation | deliver.receipt with session_ref and request_key | Reads the canonical scoped intent and receipt without native I/O or another send. |
| Reconcile an already admitted native delivery | compat_task.get with its original task_ref | Reconciles only that existing task; never creates a replacement operation. |
| Cancel a supervised build | automation.cancel_execution with rule_ref and request_key | Requests termination of the owned execution; release still requires confirmed tree completion. |
| Pause automatic wake | automation.pause with rule_ref and revision | Prevents wake while the worker and lease lifecycle continue. |
| Change wake text or re-arm an explicitly paused wait | automation.update with the current revision and the same execution/bindings | Uses CAS; the operation cannot be replaced under an existing rule. |
| Remove automatic wake | automation.delete with rule_ref and revision | Retains the cancellation tombstone and process evidence. It does not kill the build. |
| Add a process-owned lease | resource.bind with execution_ref and binding | Checks current execution and claim ownership before binding. |

Get and List also return non-authoritative diagnostics: the exact native wait target when known, current delivery state, resource owner and claim generation, remaining TTL, recorded renewal results, finalization state and a typed next_action. The resource join includes claims added after launch through resource.bind. These reads neither renew a claim nor contact a native harness. Missing or inconsistent metadata is reported as unavailable or incomplete.

List gauges describe only its returned process rows and are bounded to 256 samples. Recorded renewal counters cover observations since the first retained result; lifetime counters stay null without evidence. Diagnostic metadata never authorizes a continuation or changes an UNKNOWN result.

HumanStop is a separate explicit stop authority. It cancels pending automatic wake within the stop transaction. Releasing HumanStop later does not revive that cancelled wait. A new explicitly authorized operation needs a new registration.

A parent that is busy is not interrupted merely because a process finishes. Herder keeps the terminal receipt and waits in ordinary code for an admissible continuation. A rejected or ambiguous native delivery remains visible for reconciliation.

## Completion and failure evidence

A completion receipt distinguishes the command result from certainty about resource occupancy:

- **exit_code** or **signal** is present only when observed.
- **tree_complete** and **process_may_be_running** govern whether resources can be released.
- The reason distinguishes ordinary exit, launch failure, cancellation, deadline expiry, lease loss and lost observation.
- The receipt identifies the execution, executor, timestamps and log paths.
- Source evidence records the working directory, Git commit and observed dirty status. A Git status digest is explicitly labelled as metadata, not an immutable content snapshot.
- Artifact evidence remains **not_declared** unless independently supplied and verified. Do not treat an absent artifact digest as a verified artifact.

The worker writes the terminal receipt before finalizing claim bindings. A separate finalization acknowledgement makes crash recovery repeatable. Core restarts, retrying finalization and a lost wake ACK cannot start the command again.

One stable native delivery key belongs to one rule. Delivery is reconciled against the existing canonical intent and native message receipt. UNKNOWN is retained instead of retrying an uncertain native send. This provides one logical continuation where the native adapter exposes the required admission evidence; it does not promise impossible network-wide exactly-once execution.

## Evidence retention

This release keeps process stdout, stderr, supervisor logs and produced artifacts until an explicitly reviewed archival or cleanup operation. No automatic log expiry or execution-directory garbage collection is enabled. This policy also applies while native delivery or migration remains unresolved.

Completion receipts, request-key bindings, retired claim nonces, cancellation tombstones and native delivery deduplication evidence have a separate indefinite retention policy. Removing an old log must never remove these records or reopen its request key. Do not delete an execution directory to reclaim its logs: it also contains durable identity, occupancy and recovery evidence.

Historical counters are reported only when their observations exist. A missing telemetry record means unavailable history, not zero failures or proof that an uncertain operation did not run.

## Migration and operation

Standalone Agent Resume entrypoints no longer start another scheduler or detached Python resume process. An explicitly injected compatibility facade may forward an old operation into Herder. Without such a configured facade, old effectful aliases return an actionable retired error. Receipt and native-client utilities can remain internal libraries.

Existing legacy records remain evidence. A stale running flag with no surviving PID is not success. Do not replay old commands or bulk-wake their sessions. Project release leases move to the canonical resource authority only through the reviewed, sealed cutover described in **canonical-release-cutover.md**. Canonical timer and direct-resume activation likewise requires pinned inventories of the original waits/receipts and a verified drain of every former writer. Sealing files does not prove that a process already inside native handoff stopped. Unknown records remain reserved and block new admission until positively reconciled.

See **process-leases-runtime.md** for immutable candidate preparation, guarded rollout, consumer verification and recovery. See **implementation/process-leases-20261113.md** for the implementation and acceptance record.
