# Work on another machine

A session's message address is always its launch host + harness + native session
ID. Its actual workspace is separately declared as host + absolute POSIX path.
Moving work from100 to88 never redirects replies to a nonexistent session on88.

Use the existing MCP tools (refresh the client's tool catalog after upgrading):

```text
workspace_declare({sessionId:"<native ID on100>",harness:"codex",
  hostId:"roomhacker-server-88",cwd:"/home/roomhacker/project",ttlSeconds:1800})
workspace_activity({sessionId:"<same ID>",harness:"codex",
  paths:["src/file.ts"],ttlSeconds:1800})
workspace_status({sessionId:"<same ID>",harness:"codex"})
workspace_release({sessionId:"<same ID>",harness:"codex"})
```

Declaration verifies the remote directory with that host's existing MCP node,
resolves its canonical path, and persists a lease. Renew before it expires.
Ordinary local tool activity cannot overwrite a declared remote workspace.
This is coordination state, not permission, execution, an SSH interpreter or
an assertion that arbitrary shell commands ran remotely. Call workspace_activity
before editing declared paths. It reserves them on their actual host and returns
conflicts with that host's agents. Release clears the declaration; file leases
retain their own bounded TTL. Check conflicts and coordinate before editing.

Equal path strings on different hosts are different workspaces. A remote owner's
identity includes its native host, harness and session ID. Old coordination
records without host identity remain local to their original store.

mesh_discover reads configured fleet peers using existing authenticated SSH and
MCP routes. An unavailable peer remains explicit. mesh_route delivers a bounded
delta to a discovered address with stable inputId. Delivery remains active-only;
it does not silently start an idle session. UNKNOWN must never be replayed.
This MCP composition excludes the personal Mac M1, which requires explicit user
selection. No credentials or new hub are introduced.

Mesh snapshots and inventory preserve launchCwd and expose currentCwd plus the
workspace host and observation source. A stale/expired declaration falls back to
local observations or unverified state. A synchronous cached inventory must not
claim that an unread declaration was hydrated after a restart.
