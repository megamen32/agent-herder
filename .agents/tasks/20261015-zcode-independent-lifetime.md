# Independent ZCode lifetime after caller stops

Original assignment: user reports sess_155597f8-bb54-42f3-b16a-8807e8ac2ff7 stops when creating session stops; sessions must be owned by singleton, independent from caller. Diagnose and fix actual cause; preserve original work and accepted actions.
Authority: direct human request; canonical main, no new checkout/worktree, no foreign runtime restart.
Outcome: verify independent native execution after caller transport/process exits; correct confirmed defect on actual path.
Acceptance: real registered MCP caller terminates after admission; same native session completes once without another prompt. Source tests alone do not suffice.
Owned boundaries: lifecycle diagnostic/canary and narrow proven fix, tests; no Telegram business action or original-session replay. Unrelated untracked OpenCode release plugins preserved.
Current plan: .planning/quick/261015-fg7-independent-zcode-session-lifetime-after/261015-fg7-PLAN.md; .planning/STATE.md. Existing Mac/fleet milestone is unrelated and remains intact.

Verified15Oct11:10MSK: original root parent_id=NULL; managed Herder436876/server437103 alive since00:28MSK. Original turn_d1b2… started10:51MSK and continued tool/model work after Desktop human continuation11:05MSK. Same SID concurrently executes turn_9b9e… through Desktop. Herder agent_info returns running/original turn. No caller-linked death established.

User corrections: user insists stopped everywhere, explicitly identifies ZCode Desktop, asks “Подожди, параллельный ход с той же сессии — это как?”. Explain the two-runtime finding without dismissing the observed stop or claiming its cause proven.
Historical discussion checkpoint: controlled caller-SIGKILL canary passed; single-owner repair was still open at that point. The accepted repair below supersedes that checkpoint.

15Oct direct human extension: “Исправляй. У сессии должен быть один исполнитель, а Desktop и Herder должны видеть одно состояние. И проверь, что остановка вызывающей сессии её не убивает.” This explicitly selects unified execution/state repair in Herder plus Desktop integration; continue to reviewed concrete delivery without repeating approval for that same scope. Preserve existing tasks, inputs, native IDs, unrelated WIP and finite budgets.

Completed15Oct12:09MSK: paired native owner routing installed live and persisted
without host restart. Actual native Codex caller was interrupted while its child
continued the same native turn; completed91.872s later. Exactly one input/tool/final
marker. Actual Desktop received live running/completed events and both views
matched; Desktop raw probe confirmed no second local executor. Original selection
restored and fixture automation disabled. See current quick SUMMARY for receipts,
source ownership, rollback and resource limits.

Latest user question: “я надеюсь ты все через tdd правил?” Answered honestly:
implementation preceded tests, so not strict TDD. Added a read-only real-native
regression: same assertion fails on preserved original services and passes on
shared routed services. This is post-implementation RED/GREEN, not retrospective
test-first TDD. Original observed-stop cause remains unproven; requested shared
executor/state and caller-stop survival are now verified.
