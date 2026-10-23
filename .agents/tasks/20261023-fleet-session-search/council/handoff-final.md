# Final council handoff

Status: dispatched once through root Herder; native admission confirmed; recipient acknowledgment pending after bounded readback. No replay.

- Recipient: `MacBook-Pro-User.local`, harness `minimax-code`, existing LHC root `mvs_92b7a29fcb6147ae848063c2e62bf864`.
- Stable input ID: `lhc-council-safety-result-20261023-1`.
- Authorized mode: `steer`, `humanRequested: true`, through root Agent Herder.
- No replay after admitted or UNKNOWN; read back the existing receipt and recipient history.
- Acceptance concerns delivery and recipient acknowledgment, not completion of LHC implementation.

## Approved message

Итог запрошенного владельцем кворума Sol+MiniMaxM3.1Flash→Astra→независимая проверка: правило чужого WIP/worktree действует; обычные чтение/разработка/сборки/тесты идут параллельно без нового API, heartbeat, глобальных claims и regex-хуков. Одно worktree не защищает общий runtime. Минимальная техническая защита относится к существующему Herder/release controller: короткий commit переключения revision+config+pins, согласованный с GC check+unlink (либо tombstone запрещает новые refs); restart/readback снаружи, конфликт возвращается быстро с актуальным состоянием. Operation ID+request digest проверяются до revision; UNKNOWN требует readback без слепого повторения. CAS сам по себе не защищает от delayed GC и отдельно проверенного config. Same-UID прямой обход не гарантируется без границы прав. Для LHC учти эту развязку и запрет шумных ритуалов; production controller guards пока не реализованы, не объявляй их готовыми. Финальный документ на server100: /home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261023-fleet-session-search/council/final-decision.md

## Receipt

Root connected MCP `send_message`, exact recipient above, `mode: steer`, `humanRequested: true`, returned in 5.8 seconds:

```json
{"admitted":true,"turnId":"762406b4-1fba-4ea0-a85b-90d7d635b5e1","inputId":"lhc-council-safety-result-20261023-1"}
```

The turn ID refers to the existing recipient turn. Bounded independent persisted-history and native latest-message reads did not yet locate the final council wording or a response to it. Native queue read returned `items: []`, `pending_count: 0`, `paused: false`; this does not prove model observation. The exact native session read still carried its previously observed provider first-event timeout (`error_code: 50113`, 300000 ms) and the unchanged native timestamp `1792773497184`; this is not evidence that this new handoff caused an error. Admission is confirmed; durable text/model acknowledgment remains unconfirmed. No second send, steer or cancellation was issued.

## Independent FTS acceptance

Functional live acceptance: PASS with explicit data gaps. These are single canary timings, not benchmark percentiles.

| Query and scope | Connected root MCP wall time | Actual fleet API wall time | Observed result |
| --- | ---: | ---: | --- |
| `LastHumanCommit`, all five configured hosts, limit 3 per host | 4994 ms | 1871 ms, HTTP 200 | Same 11 host+harness+native-session identities; five owners available |
| `MAVIS_M1_ACCESS_OK_20261023`, host `MacBook-Pro-User.local`, harness `minimax-code`, limit 3 | 4896 ms | 706 ms, HTTP 200 | One exact native session `mvs_d2f746c225be489d91eabfaefef324a1` |

Host scope on both routes: `roomhacker-server-100`, `server-44`, `roomhacker-server-88`, `mac-mini-2012.lan`, `MacBook-Pro-User.local`. Reported local index query time for the global canary was 1.4–9.03 ms per host; wall time includes transport and tool overhead.

The Mac M1 match references persisted message `msg-kfwiUHMOoNYX5cGn0ROilwWimw00XHcHmn0KScA403k`. Independent SSH read of that exact native record confirmed role `assistant`, model `MiniMax-M3.1-Flash` and exact text `MAVIS_M1_ACCESS_OK_20261023`.

All hosts truthfully returned `partial: true`. The observed index cardinalities were: server-100 20108 sessions/471663 chunks; server-44 87/170; server-88 894/5607; Mac Mini 44/403; Mac M1 2215/143154. Missing native transcripts, unsupported readers and concurrent source changes remain explicit; this is not full-content completeness acceptance.

A transient maintenance gap was observed on server-100: `index.run.status: error`, `updatedAt: 2026-10-23T17:46:29.124Z`, processed 6791, error `database is locked`. Queries remained available from the existing mirror. After handing evidence to the core owner, one independent connected `session_search_local` read confirmed automatic refresh recovery: status `running`, `updatedAt: 2026-10-23T17:49:36.631Z`, processed 13177, `error: null`, query engine 4.78 ms. Full refresh completion is not inferred from that running state. Native database integrity and the separate 90-second host stability check belong to the other independent tester's receipt.
