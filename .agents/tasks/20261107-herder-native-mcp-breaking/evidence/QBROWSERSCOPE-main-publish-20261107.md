# QBROWSERSCOPE fresh-main integration and publication

- Fresh base: `origin/main` = `b440b37cd0a237691057f7ee5f8014e5a58e7a8d` at integration time.
- Integrated commit: `303cba8d2c522ac3b3fadd971326ee2e295a280b`, parent exactly the fresh base.
- Remote readback: `git ls-remote origin refs/heads/main` and post-push `git rev-parse origin/main` both returned `303cba8d2c522ac3b3fadd971326ee2e295a280b`. Push advanced remote main from b440b37c to 303cba8d.
- Commit paths are exactly `src/ahap-browser-runner.ts`, `src/adapters/chatgpt-mac-cdp-driver.ts`, `tests/ahap-browser-runner.test.ts`, and `tests/chatgpt-mac-cdp-driver.test.ts`. No foreign source or test path was committed.
- Fresh-main scoped suite: `./node_modules/.bin/vitest run --root . --config vitest.config.ts tests/chatgpt-mac-cdp-driver.test.ts tests/ahap-browser-runner.test.ts` — exit 0, 2 files, 40 tests passed.
- `git diff --cached --check` passed before commit; post-push fresh worktree is clean.
- `tsc --noEmit` was also attempted on fresh main; it fails in unrelated existing `src/adapters/opencode.ts` due OpenCode v22 API/type mismatches (`protocol v22`, missing `isV22`, delivery `start`). None of those files are in this commit, and the focused QBROWSERSCOPE suite passes. No unrelated source was changed to clear that baseline issue.
- CI WIP rechecked read-only after publication: its only dirty owned-path file remains `src/adapters/chatgpt-mac-cdp-driver.ts`, containing the independent full-transcript import and `getRawTranscript` method immediately before `getMessages`. Commit ff419ea0 was cherry-picked onto fresh main; the existing main transcript method remains intact, and the account-scope checks are in separate helper/list/get/read hunks. CI worktree and its hunk were untouched.
- No browser session, target selection, or send was performed; those remain gated on the separate exact scope/lease.
