READY_TO_IMPLEMENT

Decisive findings:

- `src/web/server.ts:355-403` already routes health remediation into the
  OpenCode-capable named-session path via `supervisor.newOrResumeNamedSession`.
- The only hard block is `src/health-remediation.ts:1-48`, where the canonical
  execution profile still requires `runtime: "hermes"`.
- `healthModelForHarness()` already returns the OpenCode provider/model string,
  so the OpenCode seam exists; the profile identity is the mismatch.
- Tests that currently lock in the Hermes profile are
  `tests/health-remediation.test.ts:5-27` and
  `tests/http-api.test.ts:129-188`.

Existing mechanism:

- OpenCode is already a normal adapter in `src/index.ts:70-105`, and the
  adapter itself is an HTTP `opencode serve` client in
  `src/adapters/opencode.ts:98-140`.

Checked and excluded hypotheses:

- No new transport layer is needed.
- The blocker is not session creation or model formatting; it is the canonical
  health execution runtime value.
- The Hermes-only route guard is legacy compatibility, not the primary
  decision point for the OpenCode switch.

Proposed <=20-minute implementation slice:

- Update the canonical health profile to OpenCode in
  `src/health-remediation.ts`.
- Adjust the health-route tests to assert the OpenCode runtime and keep the
  OpenCode model mapping.

Recommended next probe:

- Confirm whether the route should still accept `harness: "hermes"` for
  backward compatibility or should be narrowed to OpenCode/Codex only.
