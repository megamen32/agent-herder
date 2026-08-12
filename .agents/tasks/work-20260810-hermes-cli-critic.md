# Critic task: Hermes CLI health remediation seam

Original request: implement the health incident business flow and verify the
new Hermes remediation path without claiming full DoD before user selection,
independent verification, and resolved NoticePlace receipt.

Scope: independently challenge the Agent-Herder Hermes CLI job adapter,
`/api/health/remediation` harness routing, bounded MCP timeout, service
environment, focused tests, and the live synthetic canary evidence.

Do not edit product files, deploy, send Telegram, or select a real plan.
Return actionable findings with severity and exact file/line evidence, or PASS.

## Independent Critic evidence (2026-08-10, read-only)

### Business delta and proof boundary

- The focused source checks passed: `npx vitest run --root . --config vitest.config.ts tests/hermes-adapter.test.ts tests/health-remediation.test.ts tests/http-api.test.ts` reported 3 files / 10 tests passed. `npx tsc --noEmit` also exited cleanly.
- These tests are local doubles and do not prove a real Hermes CLI process, a bounded completion, provider selection at the CLI, or durable incident/NoticePlace resolution. The HTTP Hermes routing test uses `fakeNamedAdapter()` (`tests/http-api.test.ts:124-152`), not `HermesAdapter` or a spawned CLI.
- The only permitted live probe was read-only `GET http://127.0.0.1:18787/api/health/remediation`, which returned the expected `405 method_not_allowed`. No POST, plan selection, deployment, Telegram send, or NoticePlace receipt was attempted.

### Decisive findings

1. **P1 — the Hermes CLI job is not bounded by the advertised timeout.** `MCP_OBSERVATION_TIMEOUT_MS = 2_500` (`src/adapters/hermes/adapter.ts:86-87`) is used only around `listSessions()` discovery (`:167-176`). `sendJob()` starts `hermes chat` and immediately returns `{ ok: true }` (`:314-367`); there is no deadline, watchdog, kill-on-timeout, or bounded completion path. `withTimeout()` (`:463-471`) is not applied to the CLI job or to the route. Consequently `/api/health/remediation` can return `200` with `delivery: accepted` (`src/web/server.ts:183-191`, `src/named-session.ts:123-145`) while a hung child remains `running` indefinitely. This falsifies the lifecycle/timeout done condition.

2. **P1 — provider/reasoning are not request-bound, so the returned canonical profile can differ from the process that runs.** The route validates and echoes the canonical `{ runtime, provider, model, reasoning, topic }` (`src/web/server.ts:171-191`), but forwards only `model` to `newOrResumeNamedSession`. The Hermes adapter receives provider/reasoning from service environment/config (`src/index.ts:216-229`) and builds CLI args from those values (`src/adapters/hermes/adapter.ts:332-339`); the session metadata repeats the same config values (`:423-426`). A drifted `HERMES_HEALTH_PROVIDER` or `HERMES_HEALTH_REASONING` therefore runs a different provider/reasoning while the HTTP response still claims `openai-codex/high`. Current service inspection showed canonical env values, but that is deployment-state evidence, not an invariant enforced by this request seam.

3. **P1 — transcript/trace preservation is explicitly incomplete and the progress source is mislabeled for Hermes.** A completed job keeps only bounded stdout/stderr and synthesizes one assistant text message (`src/adapters/hermes/adapter.ts:374-392`); no Hermes tool calls, tool results, reasoning, or event trace are retained. `getRawTranscript()` serializes the synthesized messages and documents that tool records are unavailable (`:215-234`), while `getSessionMessages()` exposes only rendered user/assistant text (`:194-207`). `SessionSupervisor.readHistory()` labels any non-empty adapter result as `source: "acp-load"` (`src/session-supervisor.ts:325-330`), even for Hermes. Thus `/progress` can only report rendered-message evidence, not a preserved Hermes execution trace, and the focused progress test does not exercise Hermes.

4. **P1 — live service routing is stale/unproven for this source delta.** `agent-herder.service` runs `/home/roomhacker/agents-projects/agent-herder/dist/index.js` (systemd `ExecStart`), with MainPID `3832628` started at `00:05:24 MSK`; the current `dist/index.js` and `dist/web/server.js` were modified at `00:10:15 MSK`. The live GET probe proves only the old process answers the route; no live Hermes CLI remediation or current-build business canary was established. The service environment currently reports `HERMES_BIN=/home/roomhacker/.hermes/hermes-agent/venv/bin/hermes`, `HERMES_HEALTH_PROVIDER=openai-codex`, `HERMES_HEALTH_REASONING=high`, and `HERMES_HEALTH_TOOLSETS=terminal`, which is useful evidence but cannot close the stale-artifact gap.

### Safeguards and excluded hypotheses

- Input bounds and exact canonical profile validation are present (`src/web/server.ts:157-180`, `src/health-remediation.ts:17-42`); CLI output is capped at 256 KiB (`src/adapters/hermes/adapter.ts:86`, `:458-460`); observer discovery has a 2.5 s fallback to local jobs (`:167-176`). These are real safeguards but do not bound the child job or preserve its trace.
- I did not treat green unit/type checks, the fake Hermes HTTP adapter, the read-only 405 response, or current env values as proof of live E2E remediation. No external failure, Telegram, or NoticePlace side effect was performed.

### QUESTIONS_FOR_L

- Is `execution.runtime: "hermes"` required to force the Hermes CLI for every health request, or are `opencode`/`codex` valid targets? The route currently permits all three (`src/web/server.ts:162-164`) while retaining a Hermes runtime profile.
- What exact child deadline and durable completion/receipt are required before `delivery: accepted` can be treated as a health business canary?
- Is rendered final text sufficient, or must Hermes tool/reasoning/trace events be preserved for the remediation receipt?

### Alternatives before proceeding

- **Alternative A:** keep the async Hermes job contract, but make it fail-closed with an explicit deadline/watchdog and process termination, durable status/receipt, request-bound provider/reasoning/model, and a clearly labeled incomplete/raw trace export.
- **Alternative B:** do not claim the Hermes health seam complete; use the existing supported harness path only as a preview/plan step until the current artifact is rebuilt/restarted and a fresh synthetic canary proves the real CLI, progress, transcript/trace evidence, and resolved NoticePlace receipt.

## Verdict: RETHINK

The bounded health remediation seam is not ready for PASS or full DoD: the child lifecycle has no timeout, provider/reasoning are configuration-driftable, trace preservation is incomplete/mislabeled, and the live service is running an older artifact than the current source delta. Focused tests are green but insufficient; resolve the questions and obtain the missing proof before completion claims.
