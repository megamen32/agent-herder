# QZAIFACTORY source publication evidence

- Source base: fresh `origin/main` `73e7aac61431d97f3d172175a69385d7e96538bd` (includes accepted QMACREUSE `f9ec4647`).
- CI WIP review: `/home/roomhacker/.codex/worktrees/herder-native-ci/agent-herder/src/adapters/zai-cdp-driver.ts` contains only `getRawTranscript()` and its transcript API import. No overlap with the three owned paths; CI worktree was read-only and untouched.
- Published commit: `4489c69bcf6a24ab7457161ed158eda4a1a6fdc8` (`feat(browser): add Z.ai AHAP factory`). Exact paths: `src/ahap-browser-runner.ts`, `tests/ahap-browser-runner.test.ts`, `acceptance/native/browser/launch-contract.md`.
- Remote proof: `git ls-remote origin refs/heads/main` returned `4489c69bcf6a24ab7457161ed158eda4a1a6fdc8`.
- Focused proof: `vitest run --root . --config vitest.config.ts tests/ahap-browser-runner.test.ts` — 15/15 passed; `git diff --check` passed.
- Typecheck: `tsc --noEmit` reports errors only in non-owned, untouched `src/adapters/opencode.ts` at lines 373, 409, 663, 747, 786 and 798 (`v22` protocol/`isV22`/`start` type mismatch). No diagnostic references any owned path.
- Z.ai proof boundary: the existing `verifyNewChatAccountScope` uses the Z.ai list API's first chat `user_id`; empty lists or entries without that identity yield no scope, so the factory fails closed. This is documented in the launch contract. Empty-account identity proof and native Z.ai acceptance are not claimed by this source result.
- No browser page was selected or mutated; no send was attempted.
