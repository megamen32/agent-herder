# QLHCCONTINUE: stale idle / active native turn

Verified base: `3e37f1a7b1995f74fdcacc3a966e8003223a78f8`, matching fresh origin/main at intake. Only `src/common/tools/lhc_execution.py` and `tests/test_lhc_execution.py` are owned changes. No push, package generation, version bump, release or native send.

## Confirmed gap and fix

After correlated accepted delivery, Herder can return session.status=idle with nativeLastTurn.status=inProgress/in_progress/running for the exact dispatched turn. Previously observe_native(purpose=turn) returned unknown. reconcile_assignment returned at its unknown-state branch before _join; no resume_after wait was registered. The leaf stayed submitted.

The fallback now accepts running or idle session summaries for an in-progress native turn. The existing exact dispatched-turn check still precedes _join. Explicit stopped summaries are excluded; purpose=availability is unchanged and still treats contradictory idle/in-progress as unknown, not available for a fresh dispatch. UNKNOWN delivery is not retried.

## Evidence

- RED command: `python3 -m pytest -q tests/test_lhc_execution.py -k 'stale_idle or fast_child'`; `red.txt`: 3 failed, 8 passed, 30 deselected. Failures: assignment remained submitted for all three in-progress spellings.
- Same command GREEN: `green.txt`: 11 passed, 30 deselected.
- Regression command: `python3 -m pytest -q tests/test_lhc_execution.py tests/test_execution_assignment.py tests/test_execution_acceptance_regressions.py tests/test_execution_interface.py`; `regression.txt`: 74 passed in 17.55s.
- New fast tests use an in-memory transport; no real Herder or native sessions. Existing regression includes isolated loopback HTTP/stdio consumers.
- Exact turn: one deliver and one wait; later reconcile reads wait status only. Completion becomes result_ready, never accepted. Foreign/missing turns, idle without a turn, stopped+in-progress and UNKNOWN have no wait. Existing tests cover HumanStop rejection, quota, mismatched wait cancellation, CAS and acceptance gates.

## Hook review of the immutable base

- `lhc_entry.py:931-1015` PostToolUse heartbeat and `1016-1028` Stop do not invoke execution reconciliation. UserPromptSubmit only reads plan bindings; SessionStart/PostCompact recovery reads saved assignments and advises explicit reconciliation (`175-263`). The global source caller search finds reconcile only in the explicit CLI/MCP and execution bridge, not a background hook.
- This is a separate freshness/adoption boundary, not the cause of the confirmed missing wait. Herder's already existing completion wait owns waking an idle parent. A Stop/PostToolUse-only hook cannot itself wake a parent that is already idle. No second scheduler is needed.
- Codex's generated com.openai hooks and ZCode hooks invoke PostToolUse heartbeat and Stop gate. Generic `hooks/hooks.json` only declares SessionStart/PostCompact/PreToolUse; do not generalize Codex's lifecycle to every harness.
- OpenCode TS adapter forwards tool.execute.after to heartbeat and session.idle to the Stop gate (`opencode/lhc-v2.ts:462-493`), with a parentID exclusion. However opencode-config.py emits skills-only configuration; its presence in source alone does not establish installed adoption. Hermes register() installs only tool_request middleware, no lifecycle hooks. Execution dispatch supports lead harness codex/zcode/opencode/fast-agent, not Hermes/Claude.
- Hook timeouts are 5 seconds for heartbeat/Stop versus HerderMcpClient's default 10 seconds per request. Adding unbounded per-leaf synchronous network reconciliation to these hooks would exceed their existing contract.
- Fast child already completed at first observation enters result_ready and calls the exact-turn wait path (new regression passes before and after). Whether real Herder retains/captures a terminal turn when registering that wait is a separate runtime check owned by the integrator; the synthetic test does not prove parent wake delivery.
- HumanStop: explicit rejection retains human_stop and does not create a wait (existing test). The new stopped+inProgress/in_progress negative tests stay submitted without wake. Hook Stop is ordinary end-of-turn control, not an authoritative HumanStop receipt; lhc_entry's Stop gate has no native HumanStop check. Do not add continuation sends there as part of this fix.

## Integration boundary

This commit proves the LHC source gap is fixed. It does not prove package delivery or a live parent continuation. Integrator owns package/version/release, Herder restart and the installed consumer: exact accepted child turn -> exactly one wait -> child terminal -> parent resumes -> reconcile -> Lead acceptance -> next authorized ready work, including HumanStop/no replay. Canonical leaf QLHCCONTINUE remains under the integrator's plan ownership; API outage is not a source-work blocker.
