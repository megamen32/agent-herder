# Routing and consumer join — source 683456d

Published main/origin commits: `7aa34b3f360928201d92df24960aa04910d0d7e1` and `683456df67b67c939b37ff9fab4fdf76c3f430df`. Only the owned 20 + 2 paths were committed. Existing plan/WIP remains preserved separately.

Changes: remote/local mesh affordance and stable refusal, native host preservation in the sidebar, exact-target QA producer selection and canonical answer credentials, authoritative ZCode history completeness and trailing-root comparison, exact MiniMax native terminal-turn proof, bounded Mac read deadline and stable deadline diagnostics.

Root regression run: 185/185 tests in seven delivery/routing/producer files; separate session-pins 11/11. Mac transport worker RED → 41/41 GREEN. Root TypeScript check passed. Independent worker source review of both commits returned zero material findings; it explicitly made no installed-runtime claim.

Build candidate checks: 14/14 PASS; 1,710 payload files, source_dirty=false; bundle fingerprint `3d48577947e5f32368cfa38501c3513c045ef05c1cd79a2bfcac774b837fffa5`. Receipt: `.tmp/release-8187c75/routing-20261026/build-receipt.json`.

## Direct Mac consumer check from the built candidate

The built transport performed a real read over canonical reverse SSH to the existing Mac singleton. A first read returned native `fleet_session_read_deadline`; the second completed in 17,479 ms with exact host `MacBook-Pro-User.local`, exact native session `01a134e4-c26e-7ae0-900c-f9be106dbc98`, harness codex and historyUnavailable=false. No message was sent or replayed, and no Mac process/configuration was changed. This proves the 20-second transport budget can carry a successful real read; intermittent native nine-second view deadlines remain explicit availability limits, not successful reads.

Earlier diagnoses based on an old artifact log, Linux /proc on macOS and malformed/unresolved lsof paths were rejected. Native ps/lsof and resolved socket proof confirm the existing Codex daemon works. A full Mac watchdog check passed. No native controller restart is necessary.

## Current installed Mac read — 2026-10-26 07:18 UTC

After an earlier `direct_native_listener_unavailable` result, canonical SSH to
`127.0.0.1:2222` again verified `MacBook-Pro-User.local`, `MacBook-Pro-User`,
`MacBookPro18,2` and `arm64`. The existing Mac `18789/mcp` endpoint returned
HTTP405 to GET in51ms (method not allowed, listener responsive); the loaded
`com.bezrabotnyi.agent-herder-fleet-node` LaunchAgent reported state `running`,
PID14519. One fresh installed `fleet_session_view` then succeeded and returned
the exact host/session/harness plus `historyUnavailable=false`. No transcript
text is retained in this receipt.

The Mac's current `last-run.json` timestamp was `2026-10-26T07:16:40.860Z`,
source `b8f8470a69aa46bc0f848b813a17a2b91ee35c18`, reason
`observation_failed` / `native_observation_failed`, elapsed1096.98s. Its sample
showed artifact census age0.1s, 312.61MiB artifact bytes, 11 threads, two
processes and 17.0GiB host-available memory; this does not identify a current
listener outage. No Mac controller, Codex GUI, launchd job or installed source
was changed. The documented healer was not run because the live listener
answered; its contract permits kickstart only when `18789` is unreachable.

## Installation boundary

The immutable archive is built. The separate exact-fixture QA binding pointer is prepared in `97-notice-qa-binding.conf`; the production AskHuman producer is unchanged. A bounded automatic monitor waits for all active durable deliveries to settle before invoking the canonical installer once. It preserves existing accepted/UNKNOWN inputs, and uses an install-started receipt to prevent replay. Source/build success is not backend installation or permission-card acceptance.

## Public UI installed independently

The compatible frontend was published without restarting the busy backend. Admin main commit `18c122ca` changed only the managed Herder vhost and manifest; nginxctl refresh/check passed and the scoped apply completed with rollback `/var/lib/nginx-dev/rollback/20261026T034249Z`. Public files are root-owned with directory0755/file0644 and readable by www-data.

Isolated QA SSO browser `hfr26h/r26h` read public `X-Herder-UI-Source=683456df67b67c939b37ff9fab4fdf76c3f430df`, rootChildren=1. Actual sidebar has 13 Server100 labels and zero “Машина не подтверждена” labels. Screenshot `/tmp/hfr26h-host-fixed.png` was captured and inspected. The transcript itself contains the old phrase, so checking the whole body text would give a false failure; the final query scoped to sidebar button labels.

Pins remain disabled for this QA login because `/api/fleet/hosts` explicitly returns HTTP401 “Войдите в кабинет владельца флота”. That is a separate owner-account authority boundary. No role, authorization rule or fleet credentials were changed, and pin acceptance is not claimed from this login. The preserved native host identity is independently confirmed by the real `/api/sessions?quick=1` response and the sidebar.
