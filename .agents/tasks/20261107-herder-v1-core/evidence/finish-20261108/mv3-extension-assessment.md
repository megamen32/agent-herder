# Universal UserIO Agent 0.9.11: offline assessment

Owner follow-up: extension is installed in Mac Default from
`/Users/roomhacker/Downloads/Universal-UserIO-Agent-0.9.11`, ID
`aoigpennaaneniokbkochaojddgifamc`. Multiple service-worker targets were observed;
gateway evaluate failed with `Chrome access unavailable`; Chrome quit was executed
for five-minute quiet. These facts were supplied by the owner, not independently
probed here. Installation is now reported present; which worker issued the 429
request remains unproven. No browser reopen or network probe by this reviewer.

## Concrete existing enqueue/result contract: offline follow-up

Parent reports profile regressions repaired/published in `f7007b93` (54 PASS).
This follow-up made only filesystem/source reads; no HTTP requests, secret reads,
browser actions, extension execution, installation or implementation.

**Owner source:** `/home/roomhacker/agents-projects/universal-userio`, repository
`megamen32/universal-userio`; local inspected HEAD `0bad386`. ZIP
`README.md:28` and `lib/config.js:5` point to `https://msg.bezrabotnyi.com`;
README names `extensions/vk-inbox/`, the extension folder in this checkout.
Stored extension options can override the endpoint; actual saved settings were
not read. The source tree verifies the API contract, not currently deployed bytes.

Exact server implementation:

- `src/universal_userio/http_api.py:1568-1573`: enqueue/result POST routes.
- `src/universal_userio/http_api.py:2245-2266`: poll/results/status GET routes.
- `src/universal_userio/agent_channel.py:43-177`: queue and result shapes.
- `tests/test_agent_channel.py:52-87`: existing roundtrip test (read, not run).
- `extensions/vk-inbox/lib/agent.js` / ZIP same member: extension dispatcher.

All operations are scoped by the authenticated UserIO username. The extension
must authenticate as the same UserIO principal as the caller and use the exact
agent_id configured for that browser profile. No token was retrieved here.

| Existing operation | Request and actual response |
|---|---|
| Enqueue | `POST /v1/agent/commands` with `{agent_id,action,args}` -> HTTP 202 `{queued:true,id:"<agent>:<sequence>",agent_id,action}` |
| Extension dequeue | `GET /v1/agent/poll?agent_id=<agent>&wait=20` -> HTTP 200 `{command:{id,agent_id,action,args,queued_at,user}}` or `{command:null}`; wait clamped 0..30s |
| Extension result POST | `POST /v1/agent/results` with `{id,agent_id,action,result:{...}}` -> HTTP 202 `{accepted:true}` |
| Caller result read | `GET /v1/agent/results?agent_id=<agent>&limit=20` -> HTTP 200 `{results:[...]}`, newest first, limit clamped 1..200. No command-id query filter; select exact id+agent_id+action locally |
| Agent status | `GET /v1/agent/status` -> `{agents:[{agent_id,pending,last_poll_at,seconds_since_poll}]}` where fields exist |

Stored result rows are
`{type:"universal.agent.result.v1",id,agent_id,action,result,user,received_at}`.
`result` is a dictionary; max serialized row size is 4,000,000 bytes. Pending
queue bound is 32 per `(user,agent_id)`. Enqueue accepts any nonempty action;
the installed extension dispatcher decides whether that action is supported.

Request examples are documentation only; none was sent:

```json
{"agent_id":"<verified-profile-agent>","action":"tabs_list","args":{}}
{"agent_id":"<verified-profile-agent>","action":"eval","args":{"tab_id":7,"world":"MAIN","expression":"(() => ({url:location.href}))()"}}
{"agent_id":"<verified-profile-agent>","action":"dot_action","args":{"operation":"snapshot","url":"https://chatgpt.com/dots/<room-route>","room":"<exact-room-id>","after":"<known-native-cursor>"}}
```

`eval` returns `{ok:true,value:<JSON>}` or `{ok:false,error}`. A driver function
string can be invoked as `(<function>)()` using the same action and exact tab_id.
Dots snapshot returns `{ok:true,room,messages,cursor}` or e.g.
`cursor_not_visible,resync_required:true`; exactly one URL-matching tab is
required (`lib/agent.js:572-579`, `lib/dot.js:2-75`). Source checkout's extension
is older here and has no dot_action case; that action is verified in the supplied
0.9.11 ZIP, not assumed present in every installed build. Owner reports 0.9.11
installed, but its actual bytes/capability response remain unprobed.

**Correction to the initial survey:** ZIP `lib/agent.js:454-456` already has
`tabs_list`; there is no need to invent tab enumeration or a new server route.

| ChromePageTools call | Existing reuse | Missing contract |
|---|---|---|
| `list_pages` | `tabs_list` -> `{ok:true,tabs:[{id,url,title}]}`; format tab IDs into existing driver's page-list text | selected flag and durable browser-generation identity are not returned; expected account must still be checked by existing driver |
| `evaluate_script` | `eval` with exact tab_id and MAIN world; unwrap value and format the JSON fence expected by parseChromeEvaluation | No new eval engine required; transport must preserve errors and exact command ID |
| `take_snapshot` | No corresponding action in 0.9.11 | No accessibility tree / snapshot UID map used by the ChatGPT driver |
| `fill` | No UID-based fill action | Existing gpt_send/dot_action send are whole operations, not equivalent to filling the driver's selected UID |
| `click` | No UID-based click action | eval can execute a DOM click, but is not a compatible snapshot-ref click API and must not be advertised as one |

Additional driver dependencies: `close_tab` exists; `navigate` exists but uses
ensureTab/url-prefix selection, not an explicit target tab ID. It is not a safe
drop-in for `navigate_page(pageId,...)`; there is no guaranteed-fresh `new_page`
action. These differences block an unchanged full ChatGPT driver over this queue.

### Bounded 2–3-file seam, no new generic adapter or ledger

Read-only reuse needs two Herder seams: (1) a small
`src/adapters/userio-command-page-tools.ts` transport wrapper for the **existing**
enqueue/results API and just `list_pages`/`evaluate_script`, rejecting unsupported
calls; (2) `src/ahap-browser-runner.ts` factory selection/injection. Keep the
existing BrowserChatAdapter and account-aware driver. These are proposed paths,
not files created by this assessment. No UserIO server change is needed.

If full legacy driver compatibility is required, the third seam is the owning
UserIO `extensions/vk-inbox/lib/agent.js`: explicit owned-tab snapshot/fill and
targeted navigation capabilities must be supplied there, with their real UID
semantics tested. This is remaining implementation, not an already working
transport. Prefer existing Dots snapshot commands for a read-only Dots journey;
do not route it through gpt_send(auto), cookie export or a new generic adapter.

No replacement ledger is proposed. Important existing queue limits must remain
visible: `_PENDING`, `_WAITING` and `_SEQ` are process memory; JSONL is audit,
not automatic queue restoration. Sequence IDs reset on server restart, and
enqueue has no supplied request_key/dedupe field. On missing results or restart,
do not re-enqueue a mutation; report UNKNOWN and use retained existing receipts.
Server `agent_channel.call()` is an internal Python helper, not an additional
HTTP blocking RPC endpoint; use the documented command/results routes from TS.

This resolves the earlier server-enqueue unknown. It does not reopen the browser,
verify a running agent, or attribute 429 to a particular installed worker.

## Verdict

Reuse the existing UserIO command transport and exact-room Dots DOM functions.
The ZIP is not a ready account-isolated replacement for the existing ChatGPT
driver, and installing it unchanged would introduce its own periodic ChatGPT
requests. An extension transport does not itself fix upstream 429.

No extension installation, browser/network calls, native mutations, or source
changes were performed. ZIP instructions were treated as data, not executed.
All probes were local source tests or static artifact analysis.

## Artifact and evidence

- ZIP: `/home/roomhacker/.codex/attachments/b4e4f879-6841-492f-bd0e-d3617e433524/Universal-UserIO-Agent-0.9.11.zip`.
- SHA-256: `a96c6c7e1e8aa8f3aa144beed5894be49956f6b78112c87354319a90145ce0a6`.
- 27 entries, 175795 uncompressed bytes. Extracted as data after absolute-path,
  traversal and symlink checks to `/tmp/herder-mv3-assessment-3n7o5m23/Universal-UserIO-Agent-0.9.11`.
- References below are paths/line numbers inside that ZIP.
- REA static selected-file analysis: `lib/chatgpt.js`, `lib/agent.js`, `lib/dot.js`;
  evidence `ev_4c82380de131b44abf35caa5cadad956f8056eaa85225a8d6ce05e6a1641ec00`,
  `/tmp/herder-mv3-assessment-rea.json`. Bounded graph extraction does not prove
  runtime installation, OAuth availability or server-side command behavior.

## Existing capabilities and transport

`manifest.json`: MV3 service worker, tabs/scripting/storage/alarms/cookies/identity,
HTTP(S) host permissions. Automatic content scripts match VK only, not ChatGPT
or Dots. ChatGPT/Dots code is injected on demand into MAIN world.

`lib/agent.js:48-84`: per-worker serial command loop, authenticated UserIO
`GET /v1/agent/poll?agent_id=...&wait=20`, then
`POST /v1/agent/results` containing command id, agent_id, action and result.
`lib/oauth.js` provides OAuth PKCE; `lib/userio.js:24-45` attaches the access token.
This is an existing HTTPS bridge; there is no native messaging/CDP dependency
for these commands. ZIP contains the client, not the server enqueue contract;
that exact existing server endpoint must be inspected before implementation.

`lib/agent.js:134-153,450-453`: `eval` supports explicit tab_id, MAIN/ISOLATED
world, and JSON result. It can carry existing owned browser scripts, but the
current command neither checks expected account nor preserves a durable mutation
receipt. Do not route arbitrary LLM JavaScript through it as an implicit capability.

`lib/agent.js:517-593` and `lib/dot.js` already provide:

| Capability | Existing behavior | Acceptance limit |
|---|---|---|
| Dots snapshot | `dot_action(operation=snapshot,url,room,after)`; exactly one URL-matching tab; DOM room prefix and cursor checked | Visible DOM only; cursor absent returns resync_required; no full-history guarantee |
| Dots send | Same route, room, draft, composer and send-button checks; one click | Returns submitted_unconfirmed, not native admission receipt |
| Draft recovery | Backup/hash, inspect, preserve/clear/restore phases | Scoped to URL/room; no account fingerprint |
| Media | Existing chunked upload/read with room/source checks and source fingerprints | Media read performs authenticated fetch; it is not a zero-request DOM snapshot |
| ChatGPT sync | List latest ten chats, fetch changed full mappings, forward latest visible-text message | Not full transcript/export; no pagination/completeness contract |
| ChatGPT send | `gpt_send` API-first by default, UI mode available | Current API/UI fallback and receipts unsuitable for UNKNOWN no-replay |

Dots room guards use `room~room~CalpicoMessage~` native message IDs
(`lib/dot.js:2-7,65-75`). Reply-panel exclusion and matching room are useful
existing primitives. Neither proves the logged-in account.

## Account/profile isolation

Chrome extension storage/cookies are naturally local to the installed browser
profile. Commands select `agent_id`; however the packaged defaults are empty
agentId and fallback `vk-browser` (`lib/config.js:7`, `lib/userio.js:11-21`).
`options.js` stores a manually selected agent ID. Two unchanged installations
can therefore poll the same logical agent channel; uniqueness is not enforced
by this client. Do not equate extension ID, browser profile, UserIO OAuth user,
ChatGPT account and ChatGPT workspace.

`lib/chatgpt.js:15-18,48-59` calls its identity `account_id` but reads
`session.user.id`; its fingerprint is SHA256(JSON({id,email})). Herder's existing
scope is SHA256(session.account.id). These values are not interchangeable,
especially when one login has multiple workspaces. Session registration checks
a selected fingerprint before cookie export (`71-92`), but `gpt_send`, Dots
actions and `eval` do not require that fingerprint before each operation.

`gpt_send` chooses the first ChatGPT-origin tab (`lib/agent.js:221`);
Dots is stronger on room/tab routing (exact URL, unique tab) but still lacks
profile/account assertion. A shared Dots room can exist under two accounts.
`gptSync` watermark is keyed only by chatId (`lib/chatgpt.js:114,137,167-169`),
not account/workspace; the forwarding source is an email slug (`121-126`).

## Event-driven versus polling

- UserIO command transport is a 20-second long-poll; watchdog alarm is 30s/1min,
  errors sleep 5s (`lib/agent.js:12-84`). These requests go to UserIO, not ChatGPT.
- ChatGPT sync is a separate 15-minute alarm (fallback 30 minutes), first wake
  after 1 minute (`lib/chatgpt.js:97-110`). It starts unconditionally on worker
  evaluation (`background.js:403-405`), not on a ChatGPT tab event.
- Generic collect checks due recipes every minute; minimum interval 30s,
  default 300s, authenticated fetch (`lib/collect.js:12-38,50-70`). It can produce
  additional target-site traffic depending on server tasks, unknown from ZIP.
- MutationObservers exist for VK content capture only. Dots snapshot is
  request/response DOM scraping, not an installed push observer. No ChatGPT/Dots
  fetch/WebSocket passive event subscription is supplied.
- ChatGPT UI completion polls the DOM once/second up to 120 iterations
  (`lib/agent.js:349-366`); this is no extra upstream history fetch but is still
  polling rather than native turn-completion evidence.

## What can explain 429, and what cannot be concluded

Concrete additional traffic source: `lib/chatgpt.js:113-141` performs one auth,
one list and up to ten detail requests per sync (plus a UserIO registration
lookup). Manual `gpt_sync` can also invoke it. There is no single-flight guard,
429/Retry-After handling or shared per-account cooldown in this path. Parsing
`.json()` discards HTTP status; failure becomes a generic error and alarm handler
swallows it. This can overlap other clients. Closing tabs does not stop the
extension service worker or its alarms.

The archive contains no literal 429/cooldown handling and no `num_turns=60`
request. That exact plural `/backend-api/conversations/{id}?num_turns=60...`
is generated by Herder `src/adapters/browser-chat-api-scripts.ts:185-186`.
The extension's direct history GET uses singular `/backend-api/conversation/{id}`.
Thus this ZIP cannot identify the request issuer of the observed 429 beyond
distinguishing these source paths, and it does not prove the extension was
installed/running. Shared account/device/IP/provider rate-limit cause requires
correlated saved timing/status/Retry-After receipts; none is present in ZIP.
Do not label this a browser restriction and bypass it with extension fetch.

`gpt_send(auto)` is a further unsafe reuse route (`lib/agent.js:228-314`): it
POSTs a turn, catches any later stream error as ok=false, then sends via UI.
A lost response after accepted POST could duplicate the model input. It also
uses model=auto, random IDs, and no exact account header. It must not be used
as Herder's correlated send path unchanged. UI mode also uses `#prompt-textarea`
and Enter fallback (`317-346`), both weaker than the current verified driver.

## Smallest usable reuse route through existing TS adapter

1. Keep Rust core -> existing AHAP browser runner -> BrowserChatAdapter and its
   driver contracts. Use existing UserIO command/result transport behind a
   ChromePageTools-compatible transport for bounded DOM/script operations;
   preserve the existing driver send/read identity checks. No new scheduler,
   full adapter rewrite, cookie export or server-side ChatGPT session clone.
2. Add an explicit capability handshake for agent_id/profile installation,
   supported actions, exact tab identity and **Herder's** session.account.id hash.
   Reject duplicate agent binding, changed account, ambiguous URL/marker and stale
   tab generation before mutations. Require the same binding in each result.
   Reuse room/tab guards in Dots; do not alias Dots room to normal `/c/{id}`.
3. Add a durable command ledger keyed by core request/input ID on the extension
   side, persisted before click and reconciled from the native DOM ID afterward.
   A result POST lost after a click remains UNKNOWN; SW restart must not repeat
   it. Existing in-memory running flag and result command id alone are insufficient.
4. For normal readback, use already-rendered DOM/native events. Reuse Dots
   `pageAction` snapshot and existing ChatGPT selector scripts. Add a narrowly
   scoped SPA/DOM observer plus coalesced event result reporting if push behavior
   is required; this is a missing seam, not an existing capability. Keep partial
   coverage explicit; export stays separate and must not claim completeness.
5. Before any future authorized installation, make background GPT sync/collect
   opt-in for the owned task, instrument all upstream calls and share observed
   Retry-After/account cooldown across transports. A genuine quiet diagnostic
   window must include service-worker alarms and server-side consumers, not only
   closed tabs. This report changed none of those settings or runtimes.

Existing reusable starting point: UserIO poll/results plus exact-tab script
injection and Dots room/native ID parser. Missing minimums: account-bound action
guard, persistent no-replay receipt, passive event feed and explicit coverage.
Archive, projects, full-history pagination and model/cancel control are not
implemented by this extension's ChatGPT/Dots command surface.

## Independent one-core profile review completed before ZIP assessment

Update: after parent commit `f7007b93`, the unchanged four-test regression file
passes 4/4 with stable source hashes. The RED descriptions below preserve the
original findings, not current unresolved defects. Exact classification,
discarded intermediate fake-init error and current GREEN evidence are in
`profile-isolation-review.md`, `profile-isolation-review-run.log` and
`profile-isolation-review-snapshot.json`.

New local-only `tests/browser-profile-isolation-regression.test.ts` contains
expected-behavior regressions, not live acceptance:

- PASS: ChatGPT archive stays on the pinned account after page renumbering and
  fresh-driver restart; no tab writes/closes.
- RED: after SPA removes URL markers, two identical account `window.name`
  markers are accepted by `resolveOwnedTab` (first match) instead of raising
  duplicate_owned_browser_tabs. This proves ambiguous ownership, not a successful
  cross-account read; the subsequent account verification still guards reads.
- RED: configured Z.ai AHAP init validates A, but create checks cached account
  only; `ZaiCdpDriver.createChat` accepts B and creates a B-scoped local draft.
  Fixture isolates passive init and exercises real factory/create/runner. No live
  send is claimed. Same driver rebind in send would need its own exact test.
- RED: `v1_multi_browser_stand.run` accepts duplicate scope values far enough to
  invoke bootstrap; the two-account acceptance can therefore accidentally test
  the same account twice unless inputs are checked externally. Regression mocks
  bootstrap before any process launch.

Additional source coverage limitation in the multi-profile consumer: it never
forces target disappearance/renumbering or account switch; archive checks only
`archived=true`, not matching returned session_ref/effect/isError. Current positive
path is not proof of these negative cases. Source/fixture/integration remain
with the parent and browser owners; this review changed only the new test file
and this report. No architecture redesign is required.
