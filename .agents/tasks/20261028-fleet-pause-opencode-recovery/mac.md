# Mac indexing pause and recovery evidence

## Scope

Checked only the authorized Mac M1 and Mac Mini nodes. No native model turn or user-facing message was issued. Both effective settings files were atomically staged with `enabled:false`.

## M1 — MacBook Pro

Identity verified over the canonical server-100 reverse SSH route: `MacBook-Pro-User.local`, `MacBookPro18,2`, `arm64`.

The durable setting is `/Users/user/.local/state/agent-herder/indexing-settings.json`, mode `0600`, with `enabled:false`, timestamp `2026-10-28T15:17:05.308701Z`, SHA-256 `091529a521bdf0412d487273fec847acaf9a521c7ea61aa6350a2df9e15d4c4e`. `AGENT_HERDER_INDEXING_SETTINGS` has no override in the LaunchAgent/launchd environment. Fleet `node-config.json` was not changed (SHA-256 `ae6daeb87a1c8fe3a1d250a7b1619a89b711e1f1427ac2badfe5f59b99f82acd`).

Current Herder node is stopped: `com.bezrabotnyi.agent-herder-fleet-node` last exited 78 (`EX_CONFIG`), no listener on 18789. The 18787 listeners are SSH processes, not the Herder node.

Native manager is also stopped: `com.bezrabotnyi.agent-herder-native-codex` is `not running`, last exit 78 (`EX_CONFIG`). Its managed socket path is a dangling symlink; the target and its parent directory are absent. ChatGPT CodexCLI GUI processes exist, but no managed app-server listener was found. The watchdog log records `launcher_identity_unverified`, `source_identity_mismatch`, and `native_socket_already_owned_or_unknown`. Its native manager config source/launcher identity is `2e941c15…`; the controller refuses the stale/unknown socket path and never unlinks or takes it over. I did not kickstart it or alter the symlink/config. **M1 remains paused and has no Herder UI button while its node is stopped.** The next safe step is for the existing native Codex owner/control path to recreate a valid user-owned socket, then refresh the managed controller files through their published CAS and pass exact owner/socket preflight. No manual symlink deletion or duplicate app-server is allowed.

## Mac Mini

Identity verified over the canonical LAN route: `mac-mini-2012.lan`, `Macmini6,2`, `x86_64`.

The durable setting is `/Users/roomhacker/.local/state/agent-herder/indexing-settings.json`, mode `0600`, `enabled:false`, timestamp `2026-10-28T15:16:33.249214Z`, SHA-256 `cdad77a45c0fb0cb7a96e93287fb3e56f6d0f862a1993d7934b7a8ae90a77bcf`. No environment override exists. The pre-rollout node config SHA was `6ac524021df3192f29e358bc373d6dd835655047d657ced0535c0eabc0fa4a80`; the existing Herder listener and native Codex socket were live. No new session or native turn was created.

The old runtime returned HTTP 405 for the pause settings route. The candidate was verified against its bundle manifest: source `3d02bf47978240a7d2b817b46d86e87b0c6cca2f`, 2,154 bundle files, 1,787 app payload files, index SHA-256 `6ceee57fe5b2406777d44a443208b25a524b06762bfdf33a77374882a3eaed3b`.

## Mini rollout and acceptance

Published deployment corrections, no application rebuild required: `df117e7` validates the exact active LaunchAgent; `a18bc5f` preserves the caller’s Python 3.14 for the node-side helper (Mini’s shell `python3` is 3.9.6); `6b139fd` raises only the bounded manifest entry cap to 2,048. The 1 MiB JSON cap, 512 MiB payload cap, 5-second hash deadline, path checks and per-file SHA validation remain.

The first app rollout refused the 1,787-file payload and automatically restored 9cff. A later pre-switch attempt refused a transient LaunchAgent state mismatch; current/config stayed on 9cff. A fresh exact launchd/ProgramArguments, old release, and Codex socket preflight passed. The supported helper CAS changed only `mac-node-watchdog.py` and its `launcherHashes` pin, with rollback files under `/Users/roomhacker/.local/state/agent-herder/rollback/mac-mini-watchdog-6b139fd`; helper SHA changed `91a1ab64…` → `7eb9e2a6658a3f5531d7152decbe9954caf1f3b267172b3959634c291af5e9d1`, while Herder source/current remained 9cff. Native `mac-node-watchdog.py --check` exited 0; host and Codex socket were verified.

The final installer run accepted `3d02bf47978240a7d2b817b46d86e87b0c6cca2f`: manifest payload 1,787/1,787 verified, package resolution pointed into the release, active releases stayed at two/47,899,648 bytes, sessions=200, launch-policy=200, MCP=200, automation state unchanged. Final current/config both name 3d02. LaunchAgent domain `user/501` is running watchdog PID `65791`; its Herder Node child PID `65837` started `Wed Oct 28 09:16:20 2026` and runs the exact 3d02 `dist/index.js` entrypoint. Rollback `9cffc9efa0dfe05eed6eb67c2b9a21db877dba7e` remains in active releases.

Pause acceptance: root independently read the settings API as HTTP 200 with `enabled:false`. On the real Mini UI, the «Фоновая индексация» switch was off before and after clicking «Обновить состояние индексации»; the positive before/after UI receipt is `.agents/tasks/20261028-fleet-pause-opencode-recovery/mini-ui.json` (accessibility snapshots e54/e55). No toggle-on action occurred. `.tmp/mini-settings-fp28.png` is only a diagnostic screenshot of the initial incorrect `#/settings` navigation, not evidence of the successful pause UI. Old search acceptance used the read-only native MCP tool `session_search_local` against the persisted FTS5 mirror: query `Herder` returned two results with `partial:true`; the short-lived readiness token was revoked. Token issue input ID: `mini-read-search-20261028-01`. This proves the prior index remains searchable; partial coverage is reported honestly.

M1 remains a concrete external native-owner blocker as described above; `enabled:false` is staged, but its stopped service cannot expose a working UI button until the existing native owner/control path restores the socket and the guarded managed controller passes preflight.
