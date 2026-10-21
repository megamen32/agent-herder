# H31 project execution scope contract

`resolveProjectExecutionScope` is a fail closed contract seam for project
execution eligibility. It binds the decision to a project, root identity,
policy revision, exact attempt, host, and runtime instance. It admits only a
fresh `trusted` proof resolved by the runtime owner for that exact binding.
Missing, unavailable, unknown, malformed, stale, or mismatched proof is denied.
The proof is limited to 30 seconds of age and must not be future dated or
expired.

The resolver is a trust boundary. A future composition root must supply the
resolver obtained from the runtime owner; values supplied by an MCP caller,
model, browser, or request field are not a resolver or proof. Tests inject a
fake resolver to exercise the contract. This module deliberately exports no
proof issuer or minting helper.

This result is not an OS sandbox, durable capability, cross-host replay guard,
or evidence that a process is confined. H31 does not wire shared production
execution, session launch, share, steer, restart, or deployment. Production
shared execution stays disabled until the native runtime's confinement and
tool surface are proven and H34 wires admission and receipt ownership.

The H32 Codex candidate in `src/project-runtime-policy.ts` creates a
constructor-only trusted policy and `CodexAppServerAdapter` launches a dedicated
stdio app-server with an explicit permission profile, one runtime root, and
process-local app default deny plus per-thread MCP/apps/plugin flag gates. Its
optional materialized mode reserves a stable operation in the H34 journal
before native creation, records the returned native ID only after the exact
profile and closed tool inventory are observed, and restores only an accepted
scoped record after fresh root/home/version and H31 owner proof. The default
project policy remains ephemeral. H32 root identities use the v2 JSON tuple
encoding accepted by H34's durable text validator; v1 NUL-delimited records are
not promoted. UNKNOWN and intent records block any new create. This candidate
is not production wiring or an eligibility proof until the bounded real
materialized restart canary and independent review pass. Its trusted progress
observer atomically stores only nonsecret operation/input/thread/turn/item IDs,
phase, command/output hashes and result status outside the project-root cleanup.
The test retains its project and H34 journal on failure or UNKNOWN and removes
them only after terminal native archive verification. No shared Codex auth/config
or app-server is changed.

The owned project factory accepts the caller's actual AbortSignal and registers
each child adapter before initialization begins. Abort rejects pending RPCs,
awaits initialization unwind and owned child termination, and is rechecked after
deferred root, inventory, H34 reserve, session lookup and native completion
boundaries before any subsequent create/send/resume RPC. A reserved H34 intent
that completes after abort is retained as UNKNOWN; a late native ID/turn receipt
is recorded before stopping follow-up work. The integration deadline precedes
the outer test timeout, so runner rejection is not used as cancellation.

H32 must prove the actual supported runtime on each eligible host against
sibling project files, symlink escapes, parent-directory files, host sockets,
foreign credentials, unrestricted tool brokers, and network/host execution.
The exact-Luna canary must not run until the new owned process proves its
effective MCP, app, and plugin tool surfaces are empty. Any unsupported
harness remains ineligible. These checks must prove behavior of the real
runtime; the TypeScript contract alone cannot make that claim.
