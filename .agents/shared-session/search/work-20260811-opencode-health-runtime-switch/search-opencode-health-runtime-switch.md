2026-08-11T22:36:22+03:00

Read-only research notes for `work-20260811-opencode-health-runtime-switch`.

Findings:

- `POST /api/health/remediation` is handled in `src/web/server.ts:355-403`.
  It validates `incident_id`, `plan_id`, `harness`, `name`, `cwd`, `message`,
  then calls `normalizeHealthExecution(body.execution)` and forwards the result
  to `supervisor.newOrResumeNamedSession(...)`.
- The current execution profile is hard-coded to Hermes in
  `src/health-remediation.ts:1-48`:
  `runtime: "hermes"`, `provider: "openai-codex"`,
  `model: "gpt-5.6-luna"`, `reasoning: "high"`, `topic: "health"`.
  `healthModelForHarness()` already maps OpenCode jobs to
  `provider/model`, i.e. `openai-codex/gpt-5.6-luna`.
- The web route still has a Hermes-only compatibility branch at
  `src/web/server.ts:383-387` that checks the Hermes adapter profile before
  allowing a Hermes health run.
- OpenCode itself is already wired as a first-class adapter in
  `src/index.ts:70-105`, and `src/adapters/opencode.ts:98-140` confirms the
  harness expects an `opencode serve` HTTP server. No new transport is needed.
- Current tests still encode the Hermes profile as canonical:
  `tests/health-remediation.test.ts:5-27` and
  `tests/http-api.test.ts:129-188`.

Compatibility blocker:

- Any OpenCode-flavored health request that changes `runtime` away from
  `"hermes"` will currently fail normalization before it reaches the OpenCode
  harness.

Likely least-cost switch:

- Change the canonical health execution runtime from Hermes to OpenCode in
  `src/health-remediation.ts`, then update the route/tests to expect the new
  profile while keeping the existing OpenCode harness path.
