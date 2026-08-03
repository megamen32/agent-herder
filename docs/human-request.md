# Human Request Boundary

Agent Herder is a session orchestration layer, not a secret store or a phone-policy owner. It already knows how to work with harness sessions, but Ask Secret itself is not implemented here.

## Current code-backed behavior

- It coordinates multiple harness adapters and keeps the adapter that created a session responsible for that session’s native control path.
- It supports named sessions by the exact tuple `(harness, canonical cwd, name)` and reuses or creates them under a per-name lock.
- It attaches session metadata such as provider, control capabilities, and lineage so the UI and MCP surface can show what a harness can actually do.
- It already exposes harness-specific session operations such as send, resume, stop, cancel, recover, fork, and model switching when an adapter supports them.
- It does not define a `HumanRequest` model, a `request_id` binding, or any secret-handling policy.

## Proposed orchestration responsibility

If Agent Herder becomes the boundary for Ask Secret / Ask User, its job should be limited to orchestration:

- create and correlate a `HumanRequest`
- bind `request_id` to an authorized session
- choose the correct harness resume transport
- receive only opaque handles or references from upstream providers
- route the request to the right existing session or session creator

## Explicit non-responsibilities

Agent Herder should not own:

- secret plaintext
- secret storage or provisioning
- phone policy
- attention delivery
- approval semantics beyond routing to the component that already owns them

Those responsibilities stay with the systems that already own them: SSS for secrets, Notify for attention delivery, and agent-resume for wake transport.

## Boundary rule

Treat this file as the operational contract for future work:

- current behavior is what the code already proves
- proposed behavior is what future Ask Secret / Ask User integration may delegate here
- any new implementation must keep secrets and policy outside Agent Herder unless this document is updated first
