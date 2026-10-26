# Notice Place incident route: direct MiniMax subscription

Owner: Codex session `01a1754f-0228-7553-bea6-cc89e40b5187`.

## User result

Notice Place incident analysis and repair use only OpenCode provider
`minimax-coding-plan`, model `MiniMax-M3.1-Flash`. No OmniRoute or automatic
provider/model fallback. Ordinary nonincident routes are outside this change.

## Confirmed state

- Source commit `e74c6e6` is on `origin/main`. The incident policy validator,
  analysis admission, repair allowlist and both native-delivery boundaries
  reject alternative routes or pass an empty fallback list.
- Five focused test files: 53/53 passed; `npx tsc --noEmit` passed; scoped
  diff check passed. No incident producer event or native session was launched.
- Live Herder process still runs immutable candidate release `5541688` through
  the user `agent-herder.service` drop-in. Current live policy
  `incidentExecution` still says `opencode/omniroute/minimax-combo-m3.1`; no
  policy write has been attempted against that old validator.
- The existing release builder creates a new Git worktree for a requested
  commit. Project AGENTS.md requires explicit authorization for the specific
  new worktree; approval requested for
  `.worktrees/herder-fleet-candidate-e74c6e6` and remains pending.

## Next owned action

After the worktree decision, build and verify an immutable Herder release from
`e74c6e6`, switch the one live user unit in a controlled restart, then use the
existing `GET` + `If-Match` `PUT /api/automation/launch-policy` to change only
`incidentExecution` and the Notice Place project route. Read back source SHA,
runtime PID, exact policy ETag/route and safe rejection of OmniRoute. Do not
send a synthetic incident from a production service. Full incident E2E needs
an isolated source/service/verifier fixture owned by Notice Place.
