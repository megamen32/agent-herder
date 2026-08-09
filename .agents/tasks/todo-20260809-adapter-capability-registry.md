# Adapter capability registry and UI enrollment

## Original request

Check support for OpenCode, Codex, Gemini, OpenAI, and ZCode. Missing adapters
should be added where possible. Add optional capabilities and a website flow
to add or skip an adapter automatically.

## Objective

Return the current support matrix, then design a capability-aware adapter
registry and safe UI enrollment flow for optional harness adapters.

## Business canary

The site shows each discovered harness/provider with supported capabilities and
an explicit Add/Skip decision; enabling one produces a versioned configuration
and a successful adapter init without exposing credentials.

## Confirmed scope

- Audit current adapter and runtime registration.
- Distinguish harnesses from model providers.
- Plan optional capability discovery and explicit enrollment.

## Explicit exclusions

- No automatic process spawning or credential capture without a selected design.
- No Gemini/OpenAI implementation before the transport and auth boundary is
  selected.

## Estimate

- Initial estimate: optimistic 30 min, likely 60 min, pessimistic 120 min.

## Status

Complete for the selected YAGNI scope.

## Evidence

- `npm run build` passed.
- Focused adapter registry, HTTP API, ZCode, and adapter-gate tests passed.
- Live `GET /api/adapters` returned active adapters and effective capabilities.
- Live UI contains the Harness adapters panel and Add/Disable controls.
- Gemini was intentionally not added.
