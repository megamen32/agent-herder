# Goal autopilot UI leaf L07

Added `src/web-ui/autopilot-goal-panel.tsx` and mounted it beside the existing session
autopilot control in the inspector (`src/web-ui/main.tsx`).

The panel loads the goal for the exact local session identity, displays full primary
instructions/amendments, requirements and lifecycle status, and labels saving separately
from verified completion. A full objective requires an explicit “Сохранить цель и включить”
action. The panel supports amendments, stop and resume, disables controls during requests,
and uses a stable `inputId` when the same arm/amend request is retried after an ambiguous
network failure. Existing goals start with a blank amendment draft; successful saves clear the
draft and file list. Identity changes clear pending form state, and identity checks prevent a
late response from updating another session. While visible and armed, the panel polls status
every seven seconds, stopping when the goal is stopped/completed or the panel unmounts. It
shows the persisted last evaluation reason and per-requirement status; completed goals do not
offer amendment controls.

User-selected result files can be entered one per line. Exact `file:///...` references already
present in the objective are parsed structurally and shown before save; existing goal refs are
retained. `refs` are sent with arm/amend for server-side within-project validation. Invalid
references are shown and block saving. Remote sessions show an explicit unsupported message
and make no local request.

The session inspector treats an empty conversation as empty only after a live, exact-session
full details read confirms zero messages and complete available history. It keeps transcript
errors visible for nonempty or incomplete/unavailable history. The uncommitted worktree file
list is scoped to the exact session cwd; transcript-proven paths remain visible as recorded.
Relative goal file refs such as `gamma.md` resolve under the selected session cwd; traversal,
out-of-project paths, and invalid URIs show a validation error and block saving.

This UI does not claim a universal verifier. Without accessible, loaded primary result material,
the backend evaluator remains fail-closed and cannot return a completion candidate.

Focused API/evaluator tests passed (11/11), covering read-only GET versus explicit arm,
non-local-session rejection, missing read-only baseline rejection, stop/resume, safe validation
errors, and evaluator invariants. `npx tsc --noEmit --pretty false` passed after the source
updates. A scratch nested Git repository confirmed cwd descendants were listed and sibling
worktree changes excluded. No browser/runtime test or deploy was run; no model/provider calls
were made.
