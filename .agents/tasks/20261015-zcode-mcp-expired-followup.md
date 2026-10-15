# ZCode stand-down and expired MCP connection: diagnosed

User supplied the original session's transcript and asked whether this is another
bug. Scope here is diagnosis of the reported episode; no TelegramAuto source,
business actions, coordination sends or original-session inputs were performed.

Confirmed history, 15 October 2026 (MSK):

- C4's exact native Codex transcript records stop_agent for
  sess_155597f8-bb54-42f3-b16a-8807e8ac2ff7 at11:12:16, with success at11:12:18.
- Native turn_usage records Herder turn_d1b2a871-7f22-4560-bc81-43278cb91339
  cancelled at11:12:18.059. Separate Desktop
  turn_9b9e9912-1f74-48c9-bebc-9f883c16860b started11:05:13.549 and remained
  alive until11:28:08.140. Thus the stop acknowledgement preceded further work
  from the second executor. This is the split-owner defect addressed by the
  later shared-session repair, not evidence of a post-repair regression.
- Desktop coordination_note_update failed11:25:56; send_message failed11:26:32
  and11:27:22. All three errors exactly say:
  `connection session expired or unavailable; initialize again`.
- Exact rejection source is GPTAdmin
  /home/roomhacker/gptadmin/go-hub/internal/hub/connection_sessions.go:171,
  before dispatch to the child MCP. lookupConnection rejects expired/missing,
  mismatched principal/target/mode/instance or closing sessions. Current idle TTL
  is five minutes, refreshed on valid calls. The error alone does not distinguish
  TTL expiry from registry/instance invalidation; do not claim that distinction.

The client repeatedly used an invalid connection instead of recovering it.
This is a separate unresolved GPTAdmin/ZCode managed-MCP integration failure;
shared native executor routing does not fix MCP connection recovery.

Next action in the owning integration: reproduce one real ZCode managed-MCP
connection becoming invalid, verify initialize/connection replacement before the
next tool call, preserve the failed call's admission boundary and never replay an
uncertain side effect. Establish whether recovery belongs in the managed endpoint
or the native client's supported MCP lifecycle seam before editing either.
Do not switch to an unscoped endpoint, extend TTL speculatively, restart foreign
sessions, or send the old coordination messages again. No transport fix or
post-expiry live recovery has been claimed by this diagnostic task.

Read-only proof: .tmp/zcode-independent-lifetime-20261015/reported-standdown-episode.json.
Earlier shared-executor acceptance:
.planning/quick/261015-fg7-independent-zcode-session-lifetime-after/261015-fg7-SUMMARY.md.
