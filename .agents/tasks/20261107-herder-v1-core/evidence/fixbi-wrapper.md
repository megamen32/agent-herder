# FIXBI wrapper: init diagnostics and verifier ordering

Commit `88f81409`, scoped to `src/ahap-browser-runner.ts` and
`tests/ahap-browser-runner.test.ts`; not pushed.

Init now runs explicit verifier first when available, then passive adapter.init,
then the original exact getAccountScope assertion. accountVerified is still reset
before init and is set only after the final matching assertion. No acceptance or
account-boundary relaxation. Verifier mismatch prevents passive reads and sends.

JSON-RPC error code remains -32000. Init errors contain the existing sanitized
failure context plus `stage`: `verify_pinned_account`, `adapter_init` or
`account_match`; and `reason` from an exact-literal allowlist, else `unknown`.
Safe reasons: account_scope_mismatch, pinned_page_unavailable,
authentication_required, transport_timeout, transport_disconnected,
transport_no_json, evaluation_invalid, target_context_mismatch,
response_too_large, unknown. The raw exception message is never returned.
A known message with an arbitrary appended suffix is unknown, not prefix-matched.

## TDD evidence

- `fixbi-wrapper-red.log`: initial six diagnostic regressions RED.
- `fixbi-wrapper-order-red.log`: eight FIXBI regressions RED, including realistic
  passive init depending on previously verified scope and zero reads on mismatch.
- `fixbi-wrapper-green.log`: full browser runner file GREEN, 30/30 tests, 1.13s.
- Command: `npx vitest run tests/ahap-browser-runner.test.ts --reporter=verbose`.
- Scoped git diff --check: exit 0.
- Stream tests only with fake transports: no native browser or model calls.

## Downstream dependency and claim limit

Fresh no-hook ChatGPT scope requires CI's separate owned driver fix: the explicit
verifier must save accountScope only AFTER requirePinnedAccountScope succeeds.
This wrapper does not implement or bypass that driver responsibility. Driver files
were not edited. CI must rebuild the candidate with both changes and repeat its
read-only init diagnosis. The owner's core browser bound120s/CLI20s change is
separate and not verified here. Source tests do not claim installed init PASS.
