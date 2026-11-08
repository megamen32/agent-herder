# Old Herder remote stop and direct-consumer checkpoint

Owner authorized stop with loss of cross-host/wake/Notice Place repair accepted; scope 44/88/Mac Mini/Mac M1 only. No server-100 or GPTAdmin changes. No native Codex/OpenCode process or profile intentionally touched.

| Host | Pre-state / action | Readback | Protected backup |
|---|---|---|---|
| 44 `server-44` | `agent-herder-fleet.service` enabled/active, cgroup node/bootstrap and Herder SSH multiplexers; `systemctl --user disable --now` | disabled, inactive, MainPID=0 | `/home/roomhacker/.local/state/agent-herder/owner-disable-20261108-1703/` |
| 88 `roomhacker-server-88` | same unit enabled/active, cgroup node/bootstrap and Herder SSH multiplexers; disable --now | disabled, inactive, MainPID=0 | same path on 88 |
| Mac Mini `mac-mini-2012.lan` | `com.bezrabotnyi.agent-herder-fleet-node` loaded in `user/501`, watchdog process; launchctl disable + bootout | disabled; second read loaded=false, no `mac-node-watchdog.py` or fleet release index process in selected ps scan | `/Users/roomhacker/.local/state/agent-herder/owner-disable-20261108-1703/` |
| Mac M1 `MacBook-Pro-User.local` | gui labels `com.bezrabotnyi.agent-herder-fleet-node`, `com.bezrabotnyi.herder-tunnel`, `com.bezrabotnyi.agent-herder-native-codex`, `com.user.agent-herder`; disable + bootout | all disabled; follow-up print loaded=false; selected ps scan has no matching old Herder/watchdog processes | `/Users/user/.local/state/agent-herder/owner-disable-20261108-1703/` |

M1 native-codex watchdog was disabled under earlier direct owner instruction because plist points to Herder `mac-codex-watchdog.py`; it was not running at precheck. Independent native Codex sessions were not terminated. Latest owner instruction preserves native standalone processes; no such process was signalled. Launchctl disabled-state and original plist/loaded state are stored with mode-private backup directory. Linux backups include unit/drop-ins and state; may contain sensitive references and are not printed.

## Remote direct registration migration

Read-only checked standard user Codex, Claude, Hermes, OpenCode and ZCode config locations on all four hosts. No exact direct `agent-herder` MCP key found in those checked configs; no duplicate added and no config mutation attempted. Historical plugin artifact exists on 44 at `~/.local/share/agent-herder/codex-native-releases/0.2.5/.mcp.json`, but no enabled plugin reference was found in checked global config; artifact alone is not proof of an active consumer. Other fleet release/rollback/trash copies are historical, retained. Project-scoped configs and other harness locations are not exhaustively proven absent.

Parent reports new shared GPTAdmin endpoint available; this checkpoint does not call it or assert each host consumer connectivity. Existing GPTAdmin auth reference found in OpenCode config on 88 and M1; no GPTAdmin section found in checked 44 or Mini global configs, and M1 Codex URL section did not expose an auth reference in inspected section. This is limited to inspected paths, not proof credentials are missing fleet-wide. No credentials copied or displayed. No MCP backup/CAS was needed because no existing direct key was changed.

## Final read-only recheck 2026-11-08T17:09:30.953809+00:00

- **44** (`server-44`): `agent-herder-fleet.service` inactive/disabled, MainPID=0; `/proc` scan found no matching old fleet bootstrap, fleet release `dist/index.js`, or `published-native-peer4f.mjs` command.
- **88** (`roomhacker-server-88`): same unit inactive/disabled, MainPID=0; `/proc` scan found no matching old fleet bootstrap, fleet release entrypoint, or `published-native-peer4f.mjs`. The latter establishes process absence at this snapshot; GPTAdmin config disable itself was owner-reported, not inspected.
- **Mac Mini** (`mac-mini-2012.lan`): fleet-node label not loaded and explicitly disabled in user/501 and gui/501; other inventoried Herder labels not loaded and were not explicitly disabled there. Selected `ps` scan found no old fleet entrypoint, watchdog, start-herder or 18787 legacy tunnel.
- **Mac M1** (`MacBook-Pro-User.local`): all four inventoried labels (fleet-node, tunnel, native-codex watchdog, user old server) not loaded and explicitly disabled in user/501 and gui/501. Selected `ps` scan found no matching old entrypoint/watchdog/tunnel.

This is a point-in-time, user-visible process-name and specified unit/label check, not an exhaustive search for every renamed executable, other users, project-specific integrations, GPTAdmin registration or server-100. No runtime/config changes or sends in this recheck.

## Shared new V1 HTTP consumer check 2026-11-08T17:15:15.107370+00:00

Endpoint: `https://mcp.bezrabotnyi.com/server/shell-roomhacker-server-100-agentherder/mcp`; bounded POST MCP only, no model sends or configuration changes. Existing local GPTAdmin OpenCode Authorization was used on-host when found; credentials never copied into this report.

| Host | Auth availability in inspected local client | HTTP / result |
|---|---|---|
| 44 | no GPTAdmin auth found in inspected OpenCode config paths | HTTP 401; transport reachable, consumer authentication not proven |
| 88 | existing OpenCode GPTAdmin authorization | HTTP 200 initialize PASS; tools/list PASS (15 tools including discover); discover instances PASS, `isError=false`, one instance |
| Mac Mini | no GPTAdmin auth found in inspected OpenCode config paths | HTTP 401; transport reachable, consumer authentication not proven |
| Mac M1 | existing OpenCode GPTAdmin authorization present | HTTP 401; transport reachable but this existing credential was not accepted for the requested endpoint; consumer FAIL/blocked, do not infer no credentials elsewhere |

88 first discover call produced `instructions_required` with `executed=false`; subsequent read-only discover returned one instance. No mutation or model send. No claim about other credential stores, other harnesses, or installed-client configuration; parent-reported singleton/cold check not independently repeated here.

## Remote direct client registration 2026-11-08T17:17:52.436972+00:00

Owner authorized only `agent-herder` entries on 44/88/Mac Mini/Mac M1, using existing owner GPTAdmin authorization; no credential rotation or other GPTAdmin entry edits. Protected backups are mode 0600 under each host's `~/.local/state/agent-herder/owner-v1-client-20261108/`; source bytes checked by SHA-256 before atomic replace. Existing OpenCode config JSON compared structurally after removing the single new entry. No plugin artifacts changed.

| Host | Configured client(s) | Authenticated initialize / tools/list / discover instances |
|---|---|---|
| 44 | Codex `~/.codex/config.toml`; OpenCode `~/.config/opencode/opencode.json` | PASS / PASS (15) / PASS (1) for each |
| 88 | Codex `~/.codex/config.toml`; OpenCode `~/.config/opencode/opencode.jsonc` | PASS / PASS (15) / PASS (1) for each; existing working 88 GPTAdmin auth retained |
| Mac Mini | Codex `~/.codex/config.toml` | PASS / PASS (15) / PASS (1); OpenCode executable not found in inspected installed paths |
| Mac M1 | Codex `~/.codex/config.toml`; OpenCode `~/.config/opencode/opencode.json` | PASS / PASS (15) / PASS (1) for each |

Checks used each just-written client entry's URL and authorization in a local MCP HTTP client on the respective host. They prove configured credentials and endpoint, not that a fresh native Codex/OpenCode session has reloaded the new configuration or called the tool. No model sends or daemons started; parent owns server-100 and GPTAdmin.
