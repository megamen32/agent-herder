# Tester 2 — independent installed consumer acceptance, 2026-10-23

Verdict: **BLOCKED_REAL_SURFACE**, no fleet PASS. No source inspection of search implementation, edits to product, restarts, sends, sessions, delegation, or credential extraction. One owned evidence file only. AgentMemory focused recall and canonical TEST_ACCESS/topology read before checks. Secondary deployment diagnostics below are separate from zero-knowledge search acceptance.

## Real consumer observations

1. Before readiness, local API `/api/fleet/search` returned404; live `/mcp` initialize200 SSE, stateless (no Mcp-Session-Id), tools/list78tools without new search tools. Baseline only, not a published-feature defect.
2. After owner first installed100 readiness: API `query=MAVIS_M1_ACCESS_OK_20261023&hostId=roomhacker-server-100&limit=2`200355ms, zero matches, index13204sessions126861chunks, indexing=true, partial=true. API `query=agent&hostId=roomhacker-server-100&limit=2`200550ms, two real Codex sessions returned with native IDs, titles, chunk IDs. Live MCP tools/list independently advertised session_search/session_search_local with readOnlyHint and exact schemas.
3. Next100 API `query=agent&hostId=roomhacker-server-100&harness=codex&limit=2` timed out40s before headers/body. Parallel discriminators `/api/health` and nonexistent-word100 query each timed out12s. No MCP search result or concurrency acceptance inferred. Owner/Lead confirmed event-loop issue; fix was in progress.
4. Five owner probes executed concurrently over direct local/SSH routes, one bounded request each:100timeout8s;44API2001.021s index87sessions170chunks scan complete;88API2001.237s894sessions5607chunks scan complete;M1via durableSSH2222API2001.895s886sessions4552chunks indexing=true;MiniSSH reachable but18789connection refused833ms.44/88 explicitly partial: Codex missing content78/833; unsupported/missing harness sources explicit. Empty query results were not treated as empty source coverage.
5. M1 early partial API canary and native-session-ID search returned zero while indexing=true (689–1386ms); no final defect claimed from unfinished scan. Same query with minimax-code filter and without harness filter tried. No native canary mutation.
6. Linux readiness then WITHDRAWN by deploy owner:100/44/88 replaced with foreign68bf release, FTS absent. This was a runtime release collision, not acceptance of search code. No further stale-Linux queries.
7. Owner next announced M1 f83 read-only/worker readiness and independent canary hit. Tester fresh API on actual M1 via SSH2222: GET18789 `/api/fleet/search?query=MAVIS_M1_ACCESS_OK_20261023&hostId=MacBook-Pro-User.local&harness=minimax-code&limit=2` **timed out10s**, no status/body. Then direct real HTTP MCP `/mcp` tools/call session_search with same query, hostId, harnesses=[minimax-code],limit2 **timed out5020ms**. API script aborted before subsequent calls; concurrent warm/filter calls did NOT execute. Owner notified. Parent requested current leaf closure for council before further acceptance.

## Acceptance still unproven

Successful M1 exact content/title/native readback through both interfaces; warm/concurrent-backfill latency; all-five same-scope fanout; native/settings integrity; query does not refresh; complete coverage. Owner reports are not substituted for independent observed results. Source tests and advertised tools alone are not consumer PASS. No real telephone/notification tests or sends occurred.

## Separate bounded deployment diagnostics requested by Lead

Mini storage refusal reproduced read-only: pinned `fleet/mac-artifact-probe` cwd `/Users/roomhacker/.local/share/agent-herder/fleet/releases`, args53687091230001 returns68. releases16333files logical647322823bytes; unique(dev,inode)324063428bytes; physical347484160bytes. Two releases380/492 each~323.66MB share hardlinked317MB dependencies, so logical census exceeds512MiB while physical unique is smaller. No .db/.sqlite/.sqlite3 under releases. Proposed owner action: preserve/archive rollback outside active releases, no quota bypass/deletion; no mutation performed. Legacy fleet/packages pointed archived5e8. Core received exact evidence.

Shared Linux collision provenance bounded:68bf candidate receipt has source pin only, no requester/session. Worktree exact Codex cwd/branch lookup empty; Mavis exact metadata lookup empty; no owner invented.20:11:30.949MSK service drop-in replaced,20:11:31daemon reload reports command vanished,20:11:32starts68bf. No autonomous Linux Herder desired-pin reconciler proven: fleet-health is healthguard with home read-only, Mac heal applies Macs, coincident codex-daemon-watchdog only restarts codex-managed-runtime. M1 suspected session was unrelated and excluded. Lead accepted TTL ownership note plus CAS before activation as next route.

## Smallest next action

Deployment owner establishes stable installed release/ownership and responsive M1 endpoint; then fresh tester runs bounded API+MCP exact canary, title, host/harness and five-host coverage. Current result is blocked installed surface, not overall completion.


## Resumed independent final100 acceptance

Explicit next readiness eee96f3 was received before new queries. Installed100 API query=agent+hostId=roomhacker-server-100+harness=codex+limit2 returned200429ms, two native IDs matching real MCP session_search (same query/host/harnesses,454ms). Warm API359ms. Parallel nonexistent word387ms0hits, blankquery40034ms. Indexing remained true, processed10466→11028 and140645chunks. Canonical responsiveness endpoint /api/automation/launch-policy returned20027ms concurrently with filtered FTS200338ms whileindexing=true. /api/health is absent404, not a health failure. Earlier100 filteredquerytimeout is no longer reproduced. This does not accept other hosts or full corpus coverage.

## Separately authorized one-time policy handoff through Herder

Parent explicitly expanded this leaf to deliver exact owner policy once, to M1 LHC target mvs_92b7a29fcb6147ae848063c2e62bf864. Live root100 MCP send_message schema checked, target agent_info read first; exact hostMacBook-Pro-User.local+harnessminimax-code+humanRequestedtrue+modesteer+inputIdlhc-foreign-worktree-safety-20261023-1 sent once through root remote owner forwarding. Receipt admittedtrue, turnId762406b4-1fba-4ea0-a85b-90d7d635b5e1, elapsed7.326s. No fallback/replay/cancel/restart.

Native M1 API readback verified actual user-message msg-user-v1-n1-JXiHV3UPAt7x9W1I7u8gpRrg6Idp4UIiyf4wBYy0 contains complete exact owner policy. Receiver assistant message a22496a7-ca40-4b96-82ba-b7230dadce0e (2026-10-23T17:32:02.338Z) explicitly acknowledges: «Принято: чужой WIP не трогаю — свою работу веду в отдельном worktree. Сначала доделываю правило нескольких результатов…». This is actual own ACK of instruction, not completion of that other project's implementation. Parent received receipt+ACK IDs. FTS fleet acceptance remains separate and pending next hosts readiness.


## Final installed acceptance after explicit all-five readiness

**PASS for the bounded installed consumer path: fast query over available indexed sources on all five configured hosts through both API and MCP. Full historical text coverage is PARTIAL, not PASS; missing native files/unsupported readers remain explicit.** Prior BLOCKED_REAL_SURFACE findings above are preserved history and were retested after owner readiness.

Installed identities reported by deploy owner:100/44/88/M1 eee96f3f9a78ea7d8ec9d353c328c079d07bf84b, Mini2209b4c62512f5ca07106d16a68b4f58aa7d8263. No search implementation read for this acceptance.

- Root100 real API exact M1 query MAVIS_M1_ACCESS_OK_20261023+hostIdMacBook-Pro-User.local+harnessminimax-code returned729ms; real fresh HTTP MCP session_search same query/host/harnesses returned726ms. Both one exact native ID mvs_d2f746c225be489d91eabfaefef324a1 and relevant snippet. Concurrent warm API1231ms; wrong harnesscodex1288ms returns0. M1 was indexing=true2215sessions~143kchunks during these queries.
- Native M1 runtime18791 exact source readback independently shows assistant message55df3efa-5cef-4614-8f46-22ee27858230 content exactly MAVIS_M1_ACCESS_OK_20261023. No new canary/send occurred for search acceptance.
- Global no-hit query through root API1863ms and MCP1893ms returned IDENTICAL five-host area: roomhacker-server-100,server-44,roomhacker-server-88,mac-mini-2012.lan,MacBook-Pro-User.local. All5stateavailable, all5partialtrue.10020108sessions469485chunks scancomplete;4487/170complete;88894/5607complete;Mini44/403complete;M12215/~143kindexingtrue. No unavailable node was disguised as zero matches.
- Mini own real APIagent+hostMini+harnesscodex1742ms2hits, nohit1669ms0; MCP1243ms same two IDs01a155c3-1223-70c3-a9d1-cfe3e2a93005 and01a155bf-b22c-7523-95d2-bbdd954c6ad1. Partial retained.
- M1 direct exact native-session-ID query1006ms includes expected target; title phrase "Enabled Plugin"982ms returns real session IDs. Simultaneous launch-policy responsiveness20028ms. Other independent tester owns additional global title/text matching; no claim that this phrase isolates titles from message content.
- M1 stable observer window: three ticks spanning over90s retain managerPID22230,runs97; native NodePID22385 child22230 survives13:11 at finalcheck. launch-policy20028ms then2001028ms; final filtered exact canary2002280ms, expected ID, indexing=true. last-run.json mtime1792776638.7730796 unchanged throughout; last exit78 shown by launchctl is historical, not a new failure. This bounded observation is not an indefinite SLA.
- Independently opened derived M1 index readonly at /Users/user/.local/state/agent-herder/session-search/index.sqlite; PRAGMAquick_check=ok. It is separate from native DB and artifact release tree.

Secondary owner evidence read from task.md section 'Итоговые установленные доказательства': all5quick_checkok+FTS5integrityok, manifest hashes, node-config semantic preservation exceptsourceSha; nativeDBs not written/recreated; ragnotreplaced. These are owner receipts, not silently relabelled as tester hash baselines. Historical dynamic audit/history byte baseline absent; profiles/projects/secrets files absent, not invented hashes. Own query-before/after full settings preservation was NOT independently proven.

Coverage limits from owner receipts: Codex missing rollouts1006296,4478,88833,Mini22,M1759; M1MiniMax69missingnative message files; qoder/fast-agent/chatgpt persisted readers unsupported. Existing transcript generations retained; per-pass source counters differ from accumulated corpus. Search queries use existing mirror; no native refresh was observed, but source inspection was deliberately excluded and no claim of complete no-refresh trace is made. Old connector namespace caches tools; actual fresh HTTP MCP consumer advertised and executed new tools.

## Final separate ops diagnostic closure

M1 wrong/stale8040 helper and Python fallback hypotheses excluded: actual plist resolves fleet/mac-node-watchdog.py, correct regular nativeMachOarm64helper34704B SHA256f62922934c5a7505e6ae2b125205ab3cda28218335b712ac1b4f9ee4e3bc301e matches config. Darwin native --mutable is explicit, no Python fallback. Exact291927B temp census6ms; three Background-parent→utility-child probes29/31/30ms allsuccess. Canonical C exists git6e58a90f:deploy/fleet/mac-artifact-probe.c. No helper rebuild/quota change was justified or made. Parent native counter0 does not mean native traversal0files. Historical failure recovered through existing launch manager and subsequent bounded acceptance passed.

Mini missingmodule diagnostic found ERR_MODULE_NOT_FOUND dist/codex-quota-guard.js before owner fixed selected payload; post-fix real consumer proof above passed. No tester runtime control or source edits. Additional one-time user policy send and actual own ACK remain separately evidenced above; they are not search canary writes.

Ownership release: this tester changed only this evidence file, performed no commit/push/stash/reset/build/deploy/restart/delete. Parent may publish owned receipt. No remaining tester process/browser/session/tunnel to clean up.
