# QMACREUSE source and publication evidence

## RED

Before implementation, the focused runner tests failed: `makeConfiguredAdapter is not a function` for all four new transport-selection cases; 7 existing tests passed. This captured that the AHAP launcher had no configurable Mac Mini transport selection. The command was `./node_modules/.bin/vitest run --root . --config vitest.config.ts tests/ahap-browser-runner.test.ts`. The fake tools did not contact Chrome.

## GREEN on fresh main

- Base: `origin/main` `dc9d882103002b09e4109019a7a880f3fda3cf54`.
- Focused typecheck: `./node_modules/.bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck --types node,vitest/globals src/ahap-browser-runner.ts tests/ahap-browser-runner.test.ts` — passed.
- Focused suite: `./node_modules/.bin/vitest run --root . --config vitest.config.ts tests/ahap-browser-runner.test.ts` — 1 file, 12 tests passed.
- `git diff --check` passed.

The tests prove explicit `mac-mini` and `direct-cdp` selection, reject missing/unknown transport and missing page/account scope, verify the configured page ID and expected account through fake tools, and fail closed if that exact page is absent without probing another page. No native browser operation, message, or tab selection occurred.

Launch contract: `acceptance/native/browser/launch-contract.md`. The runtime requires `AHAP_CHATGPT_TRANSPORT` explicitly. Mac Mini mode uses existing `MacMiniChromeTransport`; no raw CDP endpoint is required. Both modes require exact `AHAP_CHATGPT_PAGE_ID` and 64-character `AHAP_CHATGPT_ACCOUNT_SCOPE`. In AHAP the runner filters `list_pages` to the configured page and errors if it is absent, preventing the underlying driver from falling back to another page.

A full-project `tsc --noEmit` was attempted during this work and only reports existing OpenCode v22 type errors in `src/adapters/opencode.ts`; the focused typecheck for the owned runner and test passes. No OpenCode files were changed.

## Fresh-main publication and final readback

The first push attempt based on dc9d8821 was rejected because main had advanced to 0fdd84c7. Read-only comparison found no changes on the three owned paths between those bases; the intervening commits touched other files. The exact owned delta was reapplied to 0fdd84c71332321fc8c652efcc7fc961aaa451c2, and the focused typecheck, 12-test suite, and diff check passed again. Published commit `f9ec4647b9b71289d339d37e603114a46e1b3ab9` has parent `0fdd84c71332321fc8c652efcc7fc961aaa451c2`; its paths are exactly the runner, its test, and the launch contract. Push advanced remote main to f9ec4647. `git ls-remote origin refs/heads/main` and a post-push fetch both read back the exact published SHA. The CI worktree remains unchanged on its separate `src/adapters/chatgpt-mac-cdp-driver.ts` transcript hunk; no owned-path CI hunk overlap exists. No browser session or message was performed.
