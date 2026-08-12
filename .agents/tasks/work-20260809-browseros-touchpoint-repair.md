# BrowserOS / Touchpoint transport repair

## Original request

The independent mobile QA tester cannot inspect Agent Herder because
BrowserOS/Touchpoint returns `Transport closed`. Ask a system administrator to
find and repair the broken computer-use surface.

## Objective

Restore a supported BrowserOS/Touchpoint surface that a Tester can use for a
read-only 390x844 Agent Herder QA run.

## Business canary

Touchpoint `windows` and `diagnostics` return successfully; a tester can open
the live Agent Herder page and interact with it without changing source or
production application state.

## Scope

- BrowserOS/Touchpoint MCP transport and its documented relay/services.
- BrowserOS CDP/MCP connectivity needed by the Tester.
- Read-only diagnosis first; only narrowly scoped service restart/recovery if
  the cause is identified.

## Explicit exclusions

- Do not modify Agent Herder source or UI.
- Do not kill unrelated Chrome/browser sessions.
- Do not reset profiles or delete state.

## Status

Assigned to system administrator.

## Worker evidence/result (2026-08-09, system administrator)

### Read-only diagnosis

- `systemctl --user list-units --all --no-pager | grep -Ei 'browser|touchpoint|chrome|cdp|relay'` could not reach the user bus (`DBUS_SESSION_BUS_ADDRESS`/`XDG_RUNTIME_DIR` unavailable); the system-wide list showed no BrowserOS or Touchpoint unit. This Touchpoint instance is app-server-managed, not a systemd service.
- `ps` showed BrowserOS running from `/tmp/appimage_extracted_.../opt/browseros/browseros` with `--user-data-dir=/home/roomhacker/.config/browser-os` and `--remote-debugging-port=9223`; the Touchpoint server was `/home/roomhacker/.local/share/touchpoint-mcp/bin/python /home/roomhacker/.local/share/touchpoint-mcp/bin/touchpoint-mcp`, PID 634363, PPID 163039 (`codex... app-server`).
- Direct Touchpoint business probes `mcp__touchpoint__windows({})` and `mcp__touchpoint__diagnostics({})` both failed with `tool call failed ... Transport closed`.
- BrowserOS/CDP was independently healthy: `curl --noproxy '*' -m 3 -sS http://127.0.0.1:9223/json/version` returned Chrome/148.0.7966.97, protocol 1.3, and a `webSocketDebuggerUrl`; `/json/list` returned BrowserOS page/service-worker targets. Port 9222 returned the same CDP browser identity.
- PID 634363 was sleeping for about 1 hour 7 minutes; its stdin/stdout/stderr pipes were still paired with app-server FDs, and its two local UNIX sockets were established. This isolates the observed failure to the stale Touchpoint MCP transport/session rather than BrowserOS CDP or a missing relay.

### Narrow recovery attempted

- Sent `kill -TERM 634363` only to the identified stale Touchpoint MCP child. No BrowserOS/Chrome process, profile, source file, or application state was touched. This is the exact reversible action: app-server/session management can spawn a fresh child; rollback is to let the app-server recreate the MCP child or restart only the owning Codex task/session if its connector remains cached.
- After two seconds, the old PID was gone. The subsequent `mcp__touchpoint__windows({})` and `mcp__touchpoint__diagnostics({})` calls still returned `Transport closed`; the existing connector did not rebind automatically. Therefore the business canary is **not restored** in this worker context.

### Result and remaining blocker

The cause was confirmed as a stale app-server-managed Touchpoint MCP transport while BrowserOS CDP remained live. The narrow child recovery was completed, but the app-server's cached connector remains closed. Restoring the canary now requires the owning Codex app-server/task to reinitialize that MCP connection (or an operator-approved app-server/task restart); I did not restart the shared app-server because that would affect unrelated active MCP sessions. No source changes or profile/state deletions were made.

### Commands/evidence summary

`systemctl --user list-units --all --no-pager`; `systemctl list-units --all --no-pager`; `ps -o pid,ppid,lstart,etime,stat,cmd -p 634363`; `/proc/634363/{status,fd}` inspection; `ss -xp`; `curl --noproxy '*' http://127.0.0.1:9223/json/{version,list}`; Touchpoint `windows`/`diagnostics`; `kill -TERM 634363`; post-kill Touchpoint `windows`/`diagnostics`.

No commit was created (not authorized). No rollback command was run after TERM because the target exited normally; no application rollback is required. Tester mobile 390x844 Agent Herder QA remains blocked pending MCP connector reinitialization.

## Worker continuation evidence/result (2026-08-09)

### Documented control-plane attempt

- Rechecked `/home/roomhacker/.codex/app-server-control/app-server-control.sock` and ran the documented commands:
  - `/home/roomhacker/.local/bin/codex.opencodex-real app-server daemon version` -> `status=running`, Codex `0.145.0`, socket path `/home/roomhacker/.codex/app-server-control/app-server-control.sock`.
  - `/home/roomhacker/.local/bin/codex.opencodex-real app-server daemon restart` -> `Error: app server is running but is not managed by codex app-server daemon`.
- No manual kill was issued in this continuation. The earlier in-flight SIGINT from the interrupted worker pass had completed by the time of this resume: old owning app-server PID 163039 was gone, and the external Codex owner had brought up PID 1894973 with the same `... app-server --listen unix://` command. The control socket was listening again and `/home/roomhacker/.codex/app-server-control/app-server.log` had fresh entries. BrowserOS was not restarted or touched.

### Post-restart canaries

- `mcp__touchpoint__windows({})` -> `tool call failed for touchpoint/windows: Transport closed`.
- `mcp__touchpoint__diagnostics({})` -> `tool call failed for touchpoint/diagnostics: Transport closed`.
- BrowserOS CDP remained healthy: `curl --noproxy '*' -m 3 -sS http://127.0.0.1:9223/json/version` returned Chrome/148.0.7966.97 and a `webSocketDebuggerUrl`; `/json/list` returned live page targets including `https://autoseller.auto-gram.ru/prompts?session=demo1` and `https://autoseller.auto-gram.ru/parsed`.

### Final result / blocker / rollback

The owning app-server did restart externally (PID 163039 -> PID 1894973, control socket restored), but the current task's Touchpoint MCP connector remains cached/closed, so the business canary is still **not restored**. The exact blocker is architectural: the only documented daemon restart refuses to operate on this desktop/SSH-launched unmanaged app-server. Reopening the MCP connector requires the owning Codex desktop/task to create a fresh MCP session or a newly initialized task/thread; no further safe in-scope restart command is available. System is safe: current app-server and control socket are live, BrowserOS CDP is live, and no Chrome/profile/source/application state was changed in this continuation. Rollback is not required; the restart is already complete and can be reversed only by the same external Codex owner lifecycle, not by the daemon control-plane.

No commit was created (not authorized). Tester mobile 390x844 Agent Herder QA remains blocked specifically on the stale Touchpoint connector, not on BrowserOS/CDP.
