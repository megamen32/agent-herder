# Coordinator MCP baseline

Examined hx/coord at ea7ccfe1 and the hx/done working design in docs/completion-events-research.md. Line numbers refer to this baseline.

| Capability | Existing entry and evidence | Missing on this revision |
|---|---|---|
| Start with instructions | create_session creates a named session, deliver creates and sends the first task (src/mcp/session-tools.ts:819,858). | Reference the original human inputs separately from the assignment. |
| Cite in a follow-up | Named delivery labels the entire body as an AI relay (src/agent-relay-envelope.ts:4). Accepted goal inputs retain verbatim text and receipt time (src/autopilot/goal-store.ts:9,100). | Resolve citations on the server, using references rather than caller-supplied quotes. |
| Send and await | send_message joins a delivery job to assistant output, returns the response resource for subsequent reads (src/mcp/session-tools.ts:770,802). | Expose the pre-send event cursor for terminal catch-up. |
| Worker roster | list_sessions selects historical, active or mesh inventory (src/mcp/tool-consolidation.ts:37). | Project-scoped task state and PR links independently of harness liveness. |
| Conversation | session_info reads 200 recent native messages and limits the displayed tail (src/mcp/session-tools.ts:490,512,542). | Stable message anchor and short excerpts per message. |
| Wake on progress | Supervisor emits the exact session messages resource for native updates (src/session-supervisor.ts:1367). event_list replays by sequence (src/mcp/control-plane-tools.ts:84). | Bounded wait on message updates. hx/done owns Codex completion wait, replay and HTTP status. |
| Decision | Human request validates 2–4 options and binds the answer to one session (src/mcp/human-request-tools.ts:102,149). Notice owns tap delivery (src/human-request/notice-question.ts:81). | Recommended choice and explicit delivery from the public tool. |
| Reactions | Native messages carry an ID (src/types/common.ts:51). | No shared acknowledgement keyed to a message. |
| Self-wakeup | resume_after accepts delay or absolute time, caller metadata or explicit owner (src/mcp/resume-after-tools.ts:8,44). cadence supports repeating schedules (src/mcp/tool-consolidation.ts:80). | Document the plain-client sequence. |
| URL change | hx/done specifies a stable per-session HTTP body for external watchers. | Herder-side bounded URL observation for tool-only clients. |
| Project memory | Coordination notes have author and TTL (src/coordination-notes.ts:13,58). Settings use ifMatch for settings documents (src/settings-management.ts:155). | Persistent shared document and atomic revision check. |
| Worker lifecycle | rename_session reports native and label outcomes (src/mcp/session-tools.ts:623). | Resolve and reopen assignments independently of stopping a native thread. |
| Hold and batch | Workspace presence records agent activity (src/coordination-notes.ts:94). | Human activity, quiet period and a retrievable combined digest. |
