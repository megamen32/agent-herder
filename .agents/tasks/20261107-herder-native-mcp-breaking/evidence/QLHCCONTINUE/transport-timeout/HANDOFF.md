# QLHCCONTINUE — delivery timeout

Scope: `src/common/tools/lhc_execution_transport.py` and new `tests/test_execution_transport_timeout.py`. No current assignment/UNKNOWN edits, receipt recovery, native sends, retry, push, version bump or release.

## Confirmed source route and budget

Read-only Herder checkout: `/home/roomhacker/agents-projects/agent-herder`, HEAD `b36559041ef5f89b0629ce4b03902849e324fcfb`. No diff in the cited native source files.

- `src/mcp/session-tools.ts:773`: immediate MCP deliver awaits handleDeliver.
- `src/mcp-tools/handlers.ts:751-784`: handleDeliver -> deliverOnce -> adapter.sendMessage; mode=queue is forwarded. Existing receipt and HumanStop checks precede native admission.
- `src/adapters/codex-app-server.ts:476`: requestTimeoutMs defaults to 30_000.
- `src/adapters/codex-app-server.ts:1504,1559`: turn/steer and turn/start use request(). With queue mode, delivery does not wait for model completion.
- `src/adapters/codex-app-server.ts:2905-2927`: request uses requestTimeoutMs; quota checks occur before starting that RPC timer.
- `src/user-message-delivery.ts:340-342` separately has a 30-second non-MiniMax send-observation bound. This is corroborating context, not the direct handleDeliver route above.

LHC's common 10-second HTTP timeout could therefore expire before valid native admission (the integrator reported an accepted receipt after 14 seconds). The client now has injectable `deliver_timeout=60`, selected only for `tools/call` with name `deliver`. `timeout=10` remains for initialize, initialized notification, reads and resume_after. This preserves urllib's existing socket I/O timeout semantics; it is not a promise that every queued delivery finishes within 60 seconds, nor a new end-to-end scheduler deadline. A genuine transport timeout remains uncertain/submitted and must not be replayed.

## RED/GREEN

Command: `python3 -m pytest -q tests/test_execution_transport_timeout.py`

- `red.txt`: 2 failed, 4 passed. Delayed HTTP deliver expires using the short read timeout despite the independently injected delivery budget; default delivery budget is absent.
- `green.txt`: 6 passed. Test budgets: reads/init 0.10s, delivery 0.80s, delayed receipt 0.30s. One deliver request produces accepted. True delivery timeout (0.10s vs 0.30s) produces delivery_unknown and an attempted second dispatch does not send again.
- Read/init tests retain their short timeout for initialize, session_info and resume_after. No retries are added.
- `regression.txt`: `python3 -m pytest -q tests/test_execution_transport_timeout.py tests/test_lhc_execution.py` — 47 passed in 10.71s.

All HTTP tests use an isolated loopback fixture. No real Herder call or modification to the already accepted input was made. Integrator owns package generation and installed consumer verification; the current UNKNOWN must be reconciled by its exact existing receipt, outside this patch.
