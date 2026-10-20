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
process-local app default deny plus per-thread MCP/apps/plugin flag gates. The
current inventory contains active or unknown global integrations, so session
creation fails closed before a model turn. This candidate is not production
wiring or an eligibility proof. No shared Codex auth/config or app-server is
changed.

H32 must prove the actual supported runtime on each eligible host against
sibling project files, symlink escapes, parent-directory files, host sockets,
foreign credentials, unrestricted tool brokers, and network/host execution.
The exact-Luna canary must not run until the new owned process proves its
effective MCP, app, and plugin tool surfaces are empty. Any unsupported
harness remains ineligible. These checks must prove behavior of the real
runtime; the TypeScript contract alone cannot make that claim.
