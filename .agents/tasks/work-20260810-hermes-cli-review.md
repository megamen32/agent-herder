# Review task: Hermes CLI health remediation seam

Original request: implement the health incident business flow and verify the
new Hermes remediation path without claiming full DoD before user selection,
independent verification, and resolved NoticePlace receipt.

Scope: read-only review of the Agent-Herder Hermes CLI job adapter,
`/api/health/remediation` harness routing, bounded MCP timeout, service
environment, focused tests, and the live synthetic canary evidence.

Do not edit product files, deploy, send Telegram, or select a real plan.
Return actionable findings with severity and exact file/line evidence, or PASS.

## Independent Reviewer evidence (2026-08-10)

Reviewed only the bounded seam named above: `src/adapters/hermes/adapter.ts`,
`src/web/server.ts`, `src/health-remediation.ts`, `src/named-session.ts`, the
Hermes-focused tests, and the active Agent-Herder service configuration.

Validation completed:

- `./node_modules/.bin/vitest run --root . --config vitest.config.ts tests/hermes-adapter.test.ts tests/health-remediation.test.ts tests/http-api.test.ts`: 3 files passed, 10 tests passed.
- `hermes chat --help` from the configured binary confirms the adapter's `-Q`, `-q`, `--model`, `--provider`, `--reasoning`, and `--toolsets` flags.
- `git diff --check` is clean for the selected modified product paths.
- `systemctl --user status agent-herder.service` is active (PID 3832628), and the effective process environment contains four `HERMES_*` variables. The configured profile is `HERMES_BIN=/home/roomhacker/.hermes/hermes-agent/venv/bin/hermes`, provider `openai-codex`, reasoning `high`, toolsets `terminal`.
- Read-only `GET http://127.0.0.1:18787/api/health/remediation` returned `405` with the expected `method_not_allowed` body, proving the live route responds. No remediation `POST`, plan selection, Telegram delivery, deploy, or restart was performed.

## Findings

1. **[P1] Live synthetic business-canary evidence is missing; approval is not possible.** Before this append, this task file contained only the request and scope (lines 1-12), with no synthetic Hermes job receipt, final response/session id, progress trace, or resolved NoticePlace receipt. The focused tests and the route `GET` probe do not prove the real `/api/health/remediation` POST-to-Hermes path or the required resolved business outcome. Smallest next action: under the separate human authorization boundary, run the synthetic canary through the current service and append the durable job/session receipt plus resolved NoticePlace receipt; do not claim full DoD from the focused tests alone.

2. **[P2] The live process is not proven to have loaded the latest compiled adapter.** The service started at 00:05:24, while `dist/adapters/hermes/adapter.js`, `dist/web/server.js`, and `dist/index.js` were modified at 00:10:15. `deploy/systemd/agent-herder.service:24` executes `dist/index.js`, so the successful live `GET` only proves that the running process has a compatible route, not that it loaded the current CLI-job adapter. Smallest next action: after an explicit restart/deploy gate, capture the new PID/start time and rerun the authorized synthetic canary against that process.

3. **[P2] The tracked service unit does not carry the Hermes health execution profile.** `deploy/systemd/agent-herder.service:9-12,24` references environment files and launches the compiled service, but the effective `HERMES_BIN`, provider, reasoning, and toolsets are supplied only by the untracked local drop-in `/home/roomhacker/.config/systemd/user/agent-herder.service.d/hermes-health.conf:4-7`. A clean install/reload of the tracked unit would therefore not reproduce the reviewed Hermes CLI environment. Smallest in-scope fix: make the deployment artifact's environment contract explicit, or document/install the drop-in as a required release artifact, then verify the effective child environment.

## Verdict

**CHANGES_REQUIRED** — code-focused tests and CLI argument validation pass, but the live synthetic canary/resolved receipt gate is absent and the currently running PID predates the latest compiled artifacts. The service environment itself is present in both systemd and the process; no claim is made about successful Hermes inference or NoticePlace delivery.
