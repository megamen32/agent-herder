---
name: chat-triage
description: Organize current Codex and ZCode chats, remove superseded or completed pins, and keep an explicit task registry when duplicate or failed sessions clutter the sidebar.
---

Keep one current chat visible per logical task, with the original parent, children, and replacement aliases retained in the task registry. A completed turn, idle/stopped state, archive, title, or cwd does not prove task completion.

Use this skill for a request to tidy chats or pins. Apply changes already authorized by that request; ask only about an unresolved ownership choice that affects a real mutation. Cleanup changes sidebar metadata. Resuming, stopping, deleting chats, changing autopilot settings, and sending work prompts require their own task scope.

1. Read the user's existing task registry and current native inventory on each owning host. Preserve absent and archived IDs. Join by harness + host + session ID, never by title. Record consumer completion separately from native status and queued submissions.
2. Export only compact metadata in the [snapshot schema](references/snapshot.md). Unknown native access, missing owners, incomplete inventory, and unfinished tasks remain visible. Do not save transcripts, prompts, credentials, or private project details in this plugin.
3. Run `python3 scripts/plan.py plan snapshot.json > plan.json` from this skill directory. The planner emits pin/unpin proposals and explicit holds; it never controls sessions or opens their databases.
4. Use the [native pin routes](references/native-pins.md) to apply the authorized plan. Pin and verify a canonical replacement before unpinning its aliases. Before each change, refresh the affected native state and task ownership, then run `python3 scripts/plan.py verify plan.json fresh.json`. Apply only a returned action. An active or queued alias is held.
5. Read back each changed pin. Record only IDs, desired/actual pins, evidence references, blockers, and observation times in the owning project's private temporary directory. Merge the full task scope instead of replacing it with a partial inventory. Keep two compact receipts within the project's storage budget.

An old failed chat can remain the current owner. Recovering it is a separate task; cleanup must not create a replacement or mark its work done. A finished component awaiting parent integration remains pending at the owning parent.

The bundled `scripts/install.py` adds this skill to Codex and a `/chat-triage` command to ZCode using their user extension directories. It does not install autopilot hooks, start daemons, or edit chat databases. Plugin installations already discover this directory through Agent Herder's Codex skill manifest.
