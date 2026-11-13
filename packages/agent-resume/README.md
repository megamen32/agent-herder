# Agent Herder resume compatibility library

This workspace package supplies internal harness protocol clients, session
lookup, immutable target bindings and durable delivery receipts to Agent Herder.
The package name is retained for dependency and receipt compatibility.

Agent Herder owns supervised processes, resource leases, waiting and agent
continuation. There is no standalone scheduler in the package CLI or MCP server.

Existing configurations can still read the core contract, discover sessions,
build a command for inspection and read saved receipts. Legacy effect commands
return an actionable retirement error by default. Trusted Herder integration
code may inject an explicit facade into the compatibility MCP factory; that
facade owns admission, identity checks and idempotency.

Use Agent Herder's Resource and Automation APIs for new work. Keep the same
request key when reconciling an interrupted execution. Existing receipt files
are preserved. A PID disappearing is not evidence of a successful build or a
safe reason to rerun it.

The old JobRegistry implementation remains a deprecated compatibility helper
for historical records and focused fixtures. Product entrypoints do not create
it. It is not an advertised execution capability.

The core contract hash and Herder's pin change together, so the dependent build
detects a mismatched compatibility surface. The CLI contract command remains
available for release verification.
