# QBROWSERJOIN source handoff — 2026-11-07

## Exact reusable source chain

Adapter worktree: `/home/roomhacker/.codex/worktrees/herder-native-adapters/agent-herder`, inspected HEAD `76bd832521fae32f9f220dc5451338013c82d07a`. Preserve this exact ordered chain; do not rewrite commits:

`ed1acd95` → `429d39b0` → `385efc83` → `d0a71185` → `76bd8325`

The recorded source proof is `tsc --noEmit` and focused suites 42/42 at that source state. This is source evidence only; no browser interaction, CI acceptance, or native send was run.

## Current CI site-driver delta (read-only comparison)

CI worktree: `/home/roomhacker/.codex/worktrees/herder-native-ci/agent-herder`, inspected HEAD `de8584c9f1583421ef2fe5aa9cd6a11ac8e78951`. It contains substantial unrelated/untracked WIP; leave it untouched. Current tracked dirty files relevant here:

- `src/adapters/browser-chat.ts`: `BrowserChatDriver.getRawTranscript` optional contract and adapter forwarding are one hunk; `findNamedSessions` retains the first inventory snapshot in a separate hunk. The reusable adapter chain did not modify this file. No textual hunk conflict with that chain.
- `src/adapters/chatgpt-mac-cdp-driver.ts`: CI adds the full-transcript script import and `getRawTranscript` method by `getMessages`. The reusable chain's hunks in this same file are account pinning in the constructor and account-scope checks around `createChat`/`sendMessage`. These are distinct hunks; when composing, retain both sets and inspect the resulting file for context/import compatibility.
- `src/adapters/zai-cdp-driver.ts`: CI adds the Z.ai full-transcript script import and `getRawTranscript` method beside `getMessages`. This is CI-only relative to the ChatGPT direct-CDP chain. Do not pull it into the browser delta without its delegated scope.

No dirty CI changes were observed in `src/ahap-browser-runner.ts` or `src/adapters/direct-cdp-page-tools.ts`. A deletion shown by comparing the old CI base to adapter HEAD is historical revision drift, not a current local CI deletion.

## Handoff boundary / next action

`CISHARE` has not yet supplied an accepted core artifact plus exact delegated browser test scope. Keep `QCHATCASE` and `QZAICASE` queued until both inputs exist. Do not repeat native send while there is no new authorized input/receipt; do not touch `L101`. Next: accept the exact core artifact and scope from `CISHARE`, then compose only the independent hunks listed above and run only the delegated case.

## Canonical leaf repair API gap — 2026-11-07 18:36 MSK

Attempted the supported `LhcPlan.update_leaf` operation with only schema-allowed leaf fields (`status=waiting`, corrected timestamp, result referencing this evidence, and a progress note). The API refused before mutation because the existing leaf contains unknown top-level `evidence` (error: `неизвестные поля листа — evidence`). The update API validates the existing leaf before applying fields and offers no supported remove-unknown-field/repair operation. No raw JSON edit or validation bypass was used. The leaf therefore remains incorrectly `done` until LHC owner repairs/removes the unknown field through a supported canonical repair path; after that, restore `waiting`, preserve correction history, set the actual timestamp, and keep the evidence reference in result/note. Terra integration and source-chain publication/review remain pending; do not launch native cases from the erroneous done state.
