# MiniMax Code diagnostic sidecar and Herder inventory — 2026-11-04

## Result

The current active-session inventory remains partial for `minimax-code` on both `roomhacker-server-100` and `MacBook-Pro-User.local`, with the live reason `minimax_control_transport_unavailable`. The read-only Herder mesh snapshot showed both hosts available; their MiniMax active observers were still at `candidate_seed` and had no native observation timestamp. No provider quotas, sessions, messages, or runtime configuration were changed.

On server-100, the expected owner-published manifest `~/.minimax/run/mcode-diagnostic.json` is absent. The canonical consumer contract is in `src/adapters/minimax-code-control.ts`: MiniMax Code Desktop publishes a loopback HTTP sidecar and manifest for its own live runtime. Herder validates the published native transport; it does not create a substitute controller. The OpenCode wrapper `integrations/opencode/agent-herder-diagnostic.js` is a different, opt-in hook diagnostic and cannot restore MiniMax inventory.

Herder's historical read returned 500 MiniMax session metadata rows for server-100, marked `limited`; this is a metadata inventory, not live activity proof. The Mac historical read could not reach its native source (`direct_ssh_connect_timeout`). An attempted read-only Mac shell inspection did not complete because the existing ShellMCP was below the required stdin build; its job remained queued. No retries or native session operations were made.

## Safe boundary and blocker

There are live sessions on both machines. Replacing a globally cached hook/config or restarting the MiniMax app/runtime could interrupt them. No supported headless method to publish the Desktop-owned diagnostic sidecar was established. The remaining blocker is publishing/confirming that existing native sidecar on each host without restarting or otherwise disturbing active sessions. Once available, Herder's existing inventory reader can perform a fresh read-only active-turn validation. Provider quota state is separate and was left untouched.

## Evidence

- Live `list_sessions(scope=mesh)` and `list_sessions(scope=active)` readbacks on 2026-11-04: hosts available, inventory partial; MiniMax observer reason on server-100 and Mac is `minimax_control_transport_unavailable`.
- Live `list_sessions(scope=history, harness=minimax-code, hostId=roomhacker-server-100)` returned 500 metadata rows and `limited=true`.
- Server-100 filesystem readback: `~/.minimax/run/mcode-diagnostic.json` does not exist.
- Canonical source: `src/adapters/minimax-code-control.ts:9-15,28-41`; OpenCode diagnostic distinction: `integrations/opencode/agent-herder-diagnostic.js` and `docs/coordination-delivery.md:149-167`.
