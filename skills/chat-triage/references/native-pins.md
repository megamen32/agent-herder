# Native pin routes

Resolve the owning host first. A host access failure is unknown access, not task death. Do not run a local database change against a remote session ID.

## Codex

Prefer the desktop's supported sidebar tool when available:
`move_thread_to_sidebar_section({threadId, hostId, source: "codex", sectionId: "pinned"})` pins; `sectionId: null` unpins. Preserve unrelated sections and ordering. Confirm the returned thread ID and read back the pinned inventory.

Agent Herder's Codex adapters also implement `setSessionPinned(id, boolean)`. Availability of an internal adapter method does not imply that an installed MCP or HTTP server exposes it. Inspect the actual tool schema before calling a route; do not invent a `/pin` endpoint.

## ZCode

Prefer a supported native UI/adapter pin operation. Agent Herder's ZCode adapter implements `setSessionPinned(id, boolean)` against the owning task index, using a bounded busy timeout and checking the `pinned` column and non-deleted task ID. Check whether the installed control plane exposes that operation.

If it does not, produce the exact compact proposal and blocker, or use the owner's already-authorized database maintenance path. Read-only schema inspection is permitted; a live SQLite write needs an explicit maintenance scope, a consistent backup, a checked schema, and a bounded transaction affecting only the exact pin column/ID. Preserve WAL, all conversations, timestamps, titles, queued input, deletion flags, and unfinished task ownership. Do not launch a second Herder/SDK instance to reach an internal method.

## Apply and read back

Treat pinning the replacement and unpinning the original as ordered operations. Re-read the replacement's actual pin before removing any alias. Re-export native state and ownership before each action and use the planner's `verify` command. If access, scope, queued state, or activity changes, hold the mutation and record the smallest next action.

Do not archive or delete chats as a substitute for unpinning. Do not change recovery/autopilot policy or create a timer as part of sidebar cleanup.
