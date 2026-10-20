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
shared execution stays disabled until H32 supplies real confinement and H34
wires admission and receipt ownership.

H32 must verify the actual supported runtime on each eligible host against
sibling project files, symlink escapes, parent-directory files, host sockets,
foreign credentials, unrestricted tool brokers, and network/host execution.
Any unsupported harness remains ineligible. These checks must prove behavior
of the real runtime; this TypeScript contract alone cannot make that claim.
