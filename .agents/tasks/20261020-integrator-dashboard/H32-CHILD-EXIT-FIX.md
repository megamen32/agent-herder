# H32 owned-child disposal fix

Status: source/test implementation complete; awaiting the existing reviewer and Root's next action. No stage, commit, push, provider call, native execution, deployment, or replay was performed.

## Result

Before: `terminateOwnedChild` sent SIGTERM, waited, sent SIGKILL, then ignored a false final wait, allowing `dispose()` to resolve while child exit remained unobserved.

After: a false final wait rejects with `OwnedChildTerminationUnconfirmedError` and a sanitized message. Abort-triggered cleanup catches that rejection and emits a sanitized `process.disconnected` event carrying the failure name, so async cleanup does not create an unhandled rejection or hide the outcome.

The deterministic deferred/fake-child regression was run RED before the fix and failed because disposal resolved `undefined`. After the fix, the regression passed and verifies both the typed rejection and abort event. Existing normal owned-child termination/idempotent disposal coverage also passes in the focused file.

## Verification

- `npx vitest run --root . --config vitest.config.ts tests/codex-app-server.test.ts` — PASS, 61/61.
- `npx tsc --noEmit` — PASS, exit 0.
- `git diff --check -- src/adapters/codex-app-server.ts tests/codex-app-server.test.ts` — PASS.

## Frozen source evidence

Checkout: `/home/roomhacker/agents-projects/agent-herder`, branch `main`, HEAD `7dbb5f2ab74d2435a4298e035613e5b74b51bb17`.

- `src/adapters/codex-app-server.ts` SHA-256: `9c8a46dd8af2f0d04cc4e2a1ddaadd0cb34f860dc356b8f5b63af936e520bfe4`
- `tests/codex-app-server.test.ts` SHA-256: `5e6442737cd006d7b844c0ed3379b2f00cc08e8013ff7495056b4174bbf47759`

Both files already contained broader unstaged H32 WIP before this bounded fix. Their hashes cover the complete current files; this report does not claim the unrelated existing diff as this task's authored delta. `tests/codex-app-server-persistence.integration.test.ts` is pre-existing untracked WIP and was not edited. Other working-tree WIP was left untouched.

Next: provide this report and the two exact current file hashes to Root and the already assigned reviewer for source review. No publication or integration is included in this handoff.
