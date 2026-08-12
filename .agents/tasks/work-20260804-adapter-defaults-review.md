# Review Agent Herder adapter default-on change

Role: Reviewer

## Goal

Independently review the coherent diff that changes all existing Agent Herder
adapter enable gates to default-on with explicit false opt-out.

## Confirmed scope

Only `src/index.ts` and `tests/adapter-gates.test.ts`; no service state,
restart, deploy, filter, session conversion, or unrelated files.

## Acceptance

Verify that every existing `ENABLE_*` adapter gate has intended default-on
semantics, explicit false still disables it, and the focused test meaningfully
covers the changed contract. Append severity-ordered findings and `APPROVE` or
`CHANGES_REQUIRED` to this file; return only TL;DR to L.

## Exclusions

Read-only. Do not edit, test, restart, deploy, or inspect unrelated systems.

## Status

Active.

## Review evidence

- Reviewed selected diff only: `src/index.ts` and `tests/adapter-gates.test.ts`.
- `src/index.ts:32-38` contains six `ENABLE_*` declarations; all six use
  `parseEnvBool(..., true)`, including the changed Qoder and Hermes gates.
- `src/index.ts:41-44` treats an absent value as the supplied fallback and
  treats `"false"` (as well as any non-true token) as false, so explicit
  `ENABLE_*="false"` disables each gate.
- `tests/adapter-gates.test.ts:10-22` extracts and asserts the six current
  fallback values; `tests/adapter-gates.test.ts:23` checks the true-token
  parser expression. No tests were run per the confirmed read-only
  exclusions.

## Findings

1. Medium — `tests/adapter-gates.test.ts:10-22` does not meaningfully verify
   explicit-false behavior. It only inspects source fallback literals and
   asserts that a parser expression contains true tokens; it never evaluates
   `parseEnvBool` or checks that `ENABLE_*="false"` yields a disabled gate.
   Smallest fix: add an executable table-driven parser/contract assertion (or
   isolate/export the parser) covering undefined => true and `"false"` =>
   false for each gate.
2. Low — `tests/adapter-gates.test.ts:15-22` uses `toMatchObject`, so a future
   `ENABLE_*` declaration could be added without requiring a corresponding
   default-on assertion. Smallest fix: assert the discovered gate-name set
   equals the expected set before checking fallbacks.

## Verdict

CHANGES_REQUIRED

Unverified: focused tests/build were not run because the task explicitly
excludes test execution; runtime adapter initialization and service state were
not inspected.
