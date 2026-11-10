# QBROWSERSCOPE CI WIP overlap — read-only

Compared against CI worktree `/home/roomhacker/.codex/worktrees/herder-native-ci/agent-herder` at HEAD `de8584c9f1583421ef2fe5aa9cd6a11ac8e78951`; no CI files were changed.

- `src/ahap-browser-runner.ts`: no dirty CI hunk. QBROWSERSCOPE's current-account check before and after AHAP cached reads is independent.
- `src/adapters/chatgpt-mac-cdp-driver.ts`: CI adds `getRawTranscript` import/method at the import block and immediately before `getMessages`. QBROWSERSCOPE edits constructor/helper, list API/passive list, `listChats`, `getChat`, and the body of `getMessages`. The `getRawTranscript` hunk can be preserved as inserted; keep its method immediately before the revised `getMessages`. There is no shared edited line in the independent source deltas, but they are nearby in method placement and must be composed with both methods retained.
- CI transcript API script additions are in `src/adapters/browser-chat-api-scripts.ts`; this task did not edit that path.
- Focused test paths have no CI dirty hunks in the compared worktree.

Published source commit `ff419ea0` is based on the existing direct-CDP reuse chain in this adapter worktree. It does not include, reset, or rewrite any CI WIP.
