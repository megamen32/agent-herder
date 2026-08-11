# Task: CDP website chat MCP

Started at: 2026-08-11 07:27 MSK
Lifecycle provenance: copied from todo-20260811-cdp-website-mcp.md by Lead before implementation; standalone MCP route authorized by the user, with later Agent Herder adapter integration explicitly deferred.
Last task-file mtime observed: 2026-08-11 17:47:46 MSK
Harness: Codex desktop
PID: unknown (desktop harness)
Agent session: current Codex task thread (opaque ID not exposed to task shell)
PID status: unknown (desktop harness)
Last PID signal: none observed
Last task-file transition: standalone implementation completed; registry integration and live canary remain separately deferred/gated.

## Original request

> create mcp for cdp website to fast list_chats( unread,working,recent) , search(chat), export_chat, send_message, edit_message , download media,

## Objective

Create a CDP-backed ChatGPT/E-Frontier MCP surface with fast chat operations:

- `list_chats` with `unread`, `working`, and `recent` views;
- `new_chat`;
- `search_chat`;
- `export_chat`;
- `send_message`;
- `edit_message`;
- `download_media`.

## Business canary

Use the same authenticated ChatGPT/E-Frontier site but create one new chat and use only that chat as the disposable fixture. Prove read operations against that chat and a bounded fixture message/media attachment. Prove that `send_message` and `edit_message` require an explicit write confirmation/idempotency gate. Do not send any canary prompt to the existing production E-Frontier conversation.

## Confirmed scope

- Agent Herder MCP integration seam and existing BrowserClaw/CDP browser seam.
- New-chat acquisition/ownership and stable opaque chat/message references.
- Fast read path, pagination/limits, bounded export/media output.
- Explicit authorization/idempotency behavior for send/edit.
- Focused tests, redacted receipts, and documentation.

## Explicit exclusions

- Telegram MCP, Overpod, Telegram sessions, or Telegram polling.
- Existing production E-Frontier conversation.
- BrowserClaw/BrowserOS restart or deployment without a separate explicit authorization.
- Editing/creating a Custom GPT, changing plugins, production endpoints, credentials, or MFA.

## Initial estimate (UTC+3, immutable)

- Started: 2026-08-11 07:27 MSK
- Minimum / maximum active time: 60 / 120 minutes for research, three plans, selected implementation preview, first implementation slice, and local/new-chat canary; any deployment/restart remains separately gated.

## Plan / execution

- Research route was bounded by an independent Overseer; generic contract is feasible, and the user has now named the target site and disposable new-chat fixture.
- Drafted three plans; user selected `YAGNI 80/20`.
- Before implementation: present the complete technical preview and wait for the separate approval gate.

## Draft plans for review

### 1. Максимально идеальный

Build a provider-neutral chat contract plus a ChatGPT/E-Frontier adapter behind the existing single-page BrowserClaw/CDP worker. Add stable opaque chat/message/media references, bounded pagination, a read snapshot/index for fast `list_chats` and `search_chat`, bounded Markdown/JSON `export_chat`, attachment-only `download_media`, and explicit write intent plus idempotency for `send_message`/`edit_message`. Add a disposable new-chat browser fixture, fake-CDP contract tests, redacted receipts, and documentation. No existing E-Frontier prompt is used.

Included: reusable adapter boundary, session/page ownership, cache invalidation, rate/deadline controls, write audit records, fixture and real-new-chat read canary.

Omitted: Telegram/Overpod, production deployment, Custom GPT changes, and any hidden/private ChatGPT API dependency.

Trade-off: strongest long-term reuse and safer recovery, but largest migration and selector/API discovery cost. Risk is that the ChatGPT UI does not expose all requested fields consistently.

Estimate: 90-120 active minutes for the first complete local slice; deployment/restart is separate.

Verification graph: contract tests → fake-CDP fixture → single-page new-chat ownership/read canary → reviewer/tester evidence → optional deployment gate.

### 2. Нормальный

Add the six MCP tools to Agent Herder and implement one ChatGPT/E-Frontier adapter over the existing BrowserClaw/CDP worker. Use fresh page snapshots per call, stable opaque IDs, bounded results, and a required confirmation token plus idempotency key for send/edit. `download_media` accepts only an attachment ID and an allowlisted output directory. Use a new chat for read-only live smoke; keep write behavior covered by fake-CDP tests until an exact payload is explicitly approved.

Included: tool schemas/handlers, single-tab routing, list views (`unread`, `working`, `recent`), search, bounded export, media download, write rejection/acceptance tests, docs.

Omitted: generalized multi-provider plugin system, background indexing, Telegram, deployment/restart, and production-chat canaries.

Trade-off: good business result with controlled scope and moderate migration cost; UI selector changes may require adapter maintenance.

Estimate: 60-90 active minutes for implementation and focused verification; deployment/restart remains gated.

Verification graph: failing schema/handler tests → adapter implementation → fake-CDP canary → new-chat read/ownership proof → independent review/tester.

### 3. YAGNI 80/20 — полный результат сейчас

Implement a narrow ChatGPT/E-Frontier-specific MCP adapter directly on the existing BrowserClaw/CDP worker. Support the six requested operations with small bounded limits, no persistent index, no provider abstraction, and one configured selector map. Guard send/edit with an explicit confirmation field and idempotency key. Use a newly created chat only for page ownership and read smoke; do not touch the existing E-Frontier chat.

Included: fast list views, search, current-chat export, attachment download, guarded send/edit, focused fake-DOM tests, and a short runbook.

Omitted: multi-site support, cache/index, generic transport package, automatic retries, deployment/restart, and real write canaries.

Trade-off: fastest path to a usable MCP, but highest selector drift and later refactor cost. It is still a complete bounded result, not a placeholder.

Estimate: 40-60 active minutes for local implementation and verification; live deployment is separate.

Verification graph: focused failing tests → narrow adapter → fake-DOM canary → new-chat read-only smoke → handoff.

## Append-only estimate revisions

- 2026-08-11 07:39 MSK — initial research slice did not produce evidence because a worker remained in a broad scan; new route stayed within the immutable 60/120-minute envelope.

## Evidence / result

Pending.

## Selected-plan technical preview — YAGNI 80/20

### Call stack

```text
MCP client
  -> existing MCP tool registry/dispatch
     -> src/mcp-tools/handlers.ts
        -> src/cdp-chat.ts (ChatGPT/E-Frontier adapter)
           -> one owned BrowserClaw/CDP page driver
              -> current authenticated ChatGPT site
```

The existing `browser_wake` path remains unchanged. No Telegram or Overpod path is called.

### File-tree diff

```text
src/cdp-chat.ts                         new: narrow adapter, driver, types, write gate
tests/cdp-chat.test.ts                  new: fake-DOM/CDP contract and safety tests
docs/cdp-chat-mcp.md                    new: tool contract and runbook
src/mcp-tools/definitions.ts            add six schemas/tool definitions
src/mcp-tools/handlers.ts               add six handlers and adapter wiring
src/mcp-tools/index.ts                  register the handlers
```

No source change is planned for Telegram, Overpod, Custom GPT configuration, or the existing production-chat workflow. If the current worker requires a public page-driver method, that is the only permitted additional change in `src/browser-worker.ts`; otherwise the adapter uses the existing seam unchanged.

### Tool contracts

```text
new_chat({ confirmation: NEW_CHAT, idempotencyKey, title? })
list_chats({ view: unread|working|recent, limit?, cursor? })
search_chat({ query, limit? })
export_chat({ chatId, format: json|markdown, maxMessages? })
send_message({ chatId, text, confirmation: SEND_MESSAGE, idempotencyKey })
edit_message({ chatId, messageId, text, confirmation: EDIT_MESSAGE, idempotencyKey })
download_media({ chatId, messageId, mediaId, outputDir? })
```

`working` means a chat row with an observable in-progress generation/stop state; it does not claim hidden server-side work. IDs come only from the owned page. Export is bounded; media accepts attachment IDs only and writes under an allowlisted directory.

### Pseudocode

```text
handler(args): parse schema
  -> resolve one owned page (never open a tab)
  -> adapter performs fresh snapshot + one semantic action
  -> return bounded structured result

send/edit:
  -> reject unless exact confirmation literal and idempotencyKey are present
  -> reject duplicate idempotencyKey before UI action
  -> perform one action and read back the resulting message
```

### Exact canary

1. Read-only BrowserClaw handshake and `tabs list`; establish one owned E-Frontier page.
2. Call `new_chat` with the exact confirmation/idempotency gate; verify it uses the same page and returns a new chat identity without submitting a prompt.
3. Run `list_chats` for all three views, `search_chat`, and bounded `export_chat` against the new chat.
4. Run media behavior only against the fake-CDP fixture; no real attachment is required.
5. Prove `send_message` and `edit_message` reject without their exact confirmation literal and do not mutate the page.
6. No existing E-Frontier conversation, Telegram chat, BrowserClaw restart, or production deployment is touched.

### Approval boundaries

- Creating the separate new chat: user has explicitly authorized it; it happens only after the technical preview is approved.
- Any real send/edit: requires a separate exact payload and confirmation at the MCP call; never used as an implicit canary.
- BrowserClaw restart, deployment, or cleanup: separate approval required.

### Execution graph

- Worker — `src/cdp-chat.ts`, MCP definitions/handlers — implement adapter and six tools; fake contract tests green; max 20 min; depends on this preview approval.
- Worker — `tests/cdp-chat.test.ts`, docs — cover write-gate, idempotency, bounded export/media, and single-page invariant; max 15 min; joins implementation.
- Reviewer — task-owned diff — inspect safety and scope; max 10 min; depends on focused tests.
- Tester — new-chat BrowserClaw surface — prove one-page ownership and read-only canary with screenshot evidence on failure; max 15 min; depends on reviewer.
- Lead — task card/handoff — integrate evidence and report deployment gate; max 10 min; depends on reviewer/tester.

Second approval required: `Да, реализуй этот preview`.

## Critic plan review (2026-08-11)

**Verdict: RETHINK.** Ни один план пока не закрывает главный риск: «новый чат»
назван fixture, но не определены доказуемые origin/account/page ownership,
способ наполнить новый чат сообщением и media, и запрет fallback на текущий
production chat. Пустой новый чат не доказывает search/export/download_media,
а `current-chat export` в плане 3 прямо противоречит exclusion.

- План 1 переусложняет первый срез: provider-neutral контракт, индекс,
  инвалидация и audit/recovery до доказательства DOM-семантики создают дорогую
  миграцию и ложное ощущение fast path. Индекс также добавляет staleness и
  ownership-проблемы.
- План 2 — лучшая база, но `fresh page snapshots` не решают selector/API drift
  и могут не дать заявленную скорость. Один владелец должен быть не просто
  «single-tab routing», а page-bound lease/lock с отказом при потере страницы;
  каждый opaque chat/message/media ref должен быть привязан к origin, session,
  page и chat, без глобального `current chat`.
- План 3 наиболее опасен: configured selector map, отсутствие ownership/
  capability checks и `current-chat export` делают fallback и drift вероятными;
  fake-DOM canary не является бизнес-доказательством. Его YAGNI экономит время
  только за счёт переноса rewrite и риска чтения production.

Во всех планах не определены семантики `unread`, `working`, `recent` (источник,
порядок, timezone, cursor/dedup, empty/error), поэтому «полный результат» пока
не имеет проверяемого контракта. `export_chat` должен иметь явные message/byte
limits и truncation marker; media — только attachment ref из fixture, MIME/size
allowlist, confined output path с защитой traversal/symlink. Confirmation и
idempotency key для send/edit недостаточны сами по себе: gate должен быть
одноразовым/TTL и связанным с точным operation+chat+message+payload; edit — с
ожидаемой версией/старым текстом; после timeout нужен read-back, а retry не
должен дублировать отправку.

**Рекомендация:** выбрать план 2, но сначала сузить его до adapter seam +
opaque refs + page lease + bounded read/write policy. Явно зафиксировать
одноразовый disposable fixture (origin/account/page/chat receipt), exact
fixture message/media setup, и hard rejection любого target без fixture binding
или при ownership ambiguity. Провести independent fresh Tester на реальном
BrowserClaw/CDP surface: list/search/export/download с лимитами и negative
cases, send/edit без token, с неверным/повторным token и с тем же idempotency
key, затем один явно подтверждённый write только в fixture с read-back. Метрика
«fast» должна быть измерена на bounded page/limit, а не выведена из unit/fake
тестов. До этого не принимать ни один план и не делать deployment/restart.

## Worker pause status (2026-08-11 08:16 MSK)

- Status: `PAUSED` at the user's direction after the critic safety finding. No
  implementation, cleanup, revert, browser, Telegram, or deployment action was
  taken by this worker after the pause request.
- Assigned implementation paths changed by this worker in this pass: none.
  `src/cdp-chat.ts` and `tests/cdp-chat.test.ts` were not created; no change was
  made to `src/mcp-tools/index.ts` or `src/browser-worker.ts`.
- Focused tests: not run. Build/typecheck: not run. No live browser or real
  ChatGPT prompt was used.
- The following is the exact shared-worktree status observed with
  `git status --short --untracked-files=all`; all entries were preserved and
  were not reverted or cleaned:

```text
 M ROADMAP.md
 M docs/autopilot.md
 M package.json
 M src/autopilot-hook.ts
 M src/autopilot/index.ts
 M src/index.ts
 M src/mcp-tools/definitions.ts
 M src/mcp-tools/handlers.ts
 M tests/autopilot-core.test.ts
 M tests/http-api.test.ts
 M tests/mcp-definitions.test.ts
?? .agents/tasks/todo-20260804-codex-child-completion-parent-wake-hook.md
?? .agents/tasks/todo-20260809-flint-sing-adviser.md
?? .agents/tasks/todo-20260809-flint-sing-explorer.md
?? .agents/tasks/todo-20260809-flint-sing-ui-complete.md
?? .agents/tasks/todo-20260809-opencode-cwd-filter-leak.md
?? .agents/tasks/todo-20260811-cdp-website-mcp.md
?? .agents/tasks/work-20260804-adapter-defaults-final-review.md
?? .agents/tasks/work-20260804-adapter-defaults-repair-review.md
?? .agents/tasks/work-20260804-adapter-defaults-review.md
?? .agents/tasks/work-20260804-codex-harness-filter-live-tester.md
?? .agents/tasks/work-20260804-codex-harness-filter-no-effect.md
?? .agents/tasks/work-20260804-hermes-sessions-absent-from-ui.md
?? .agents/tasks/work-20260805-codex-harness-filter-live-tester.md
?? .agents/tasks/work-20260809-browseros-touchpoint-repair.md
?? .agents/tasks/work-20260809-herder-session-cache.md
?? .agents/tasks/work-20260810-health-blackbox-tester.md
?? .agents/tasks/work-20260810-hermes-cli-critic.md
?? .agents/tasks/work-20260810-hermes-cli-review.md
?? .agents/tasks/work-20260811-cdp-website-mcp.md
?? .agents/tasks/work-20260811-hermes-initialization-stall.md
?? .agents/tasks/work-20260811-hermes-observation-timeout.md
?? .agents/tasks/work-hermes-mcp-schema-gap.md
?? docs/browser-worker.md
?? src/browser-wake.ts
?? src/browser-worker.ts
?? src/browserclaw-worker-main.ts
?? src/browserclaw-worker.ts
?? tests/browser-wake.test.ts
?? tests/browserclaw-worker.test.ts
?? trash/logs/agent-herder-canary-after-failure-20260811-0244.png
?? trash/logs/agent-herder-canary-after-failure-20260811-0253.png
?? trash/logs/agent-herder-canary-after-submit-20260811-0320.png
?? trash/logs/agent-herder-canary-after-submit-20260811-0400.png
?? trash/logs/agent-herder-canary-before-20260811-0244.png
?? trash/logs/agent-herder-canary-before-20260811-0253.png
?? trash/logs/agent-herder-canary-before-20260811-0300.png
?? trash/logs/agent-herder-canary-before-20260811-0310.png
?? trash/logs/agent-herder-canary-before-20260811-0320.png
?? trash/logs/agent-herder-canary-before-20260811-0330.png
?? trash/logs/agent-herder-canary-before-20260811-0340.png
?? trash/logs/agent-herder-canary-before-20260811-0350.png
?? trash/logs/agent-herder-canary-before-20260811-0400.png
?? trash/logs/agent-herder-canary-failure-20260811-0320.png
?? trash/logs/agent-herder-canary-failure-20260811-0340.png
?? trash/logs/agent-herder-canary-failure-20260811-0400.png
```

- `git diff --stat` at the same check: 11 tracked files, 184 insertions,
  8 deletions; these shared changes remain untouched.
- Resume is blocked until the revised minimum is designed and explicitly
  reassigned: one-time fixture binding `(origin, account, page, chat)`, page
  lease with hard rejection on ownership ambiguity, explicit `unread` /
  `working` / `recent` semantics, bounded export/media with confined output
  path, and a one-shot TTL gate bound to exact operation + chat + message +
  payload. No global current-chat or unbound IDs.

## Route correction after Critic

The user-selected YAGNI route remains the intended cost target, but it must
adopt the non-negotiable safety prefix from the Critic: one disposable fixture
binding, page-bound lease, origin/account/page/chat-bound opaque references,
explicit list-view semantics, bounded export/media confinement, and a
one-shot TTL write gate bound to the exact operation and payload. The active
implementation worker was paused before further scope expansion; no browser,
Telegram, or deployment action occurred.

## Pre-existing worktree collision

The intended Agent Herder registry paths (`src/index.ts`,
`src/mcp-tools/definitions.ts`, `src/mcp-tools/handlers.ts`, and related
tests) already contain older user changes for `browser_wake`. This task has
not modified those paths. Safe continuation is a standalone `src/cdp-chat.ts`
plus `src/cdp-chat-mcp.ts` MCP entrypoint and isolated tests/docs; merging the
seven tools into the existing registry is excluded until the foreign hunks
are explicitly authorized for integration.

## Authorized standalone implementation slice

User decision: implement the standalone MCP now; add it to the Agent Herder
registry later as a separate adapter integration. Worker may create or edit
only these task-owned paths:

- `src/cdp-chat.ts`
- `src/cdp-chat-mcp.ts`
- `tests/cdp-chat.test.ts`
- `docs/cdp-chat-mcp.md`

Worker must not edit the existing MCP registry, package metadata, browser
runtime, Telegram/Overpod code, deployment files, or any real browser. The
acceptance gate is a green focused fake-CDP suite covering `new_chat`, the
three list views, search/export/media bounds, page lease/fixture binding, and
negative/positive one-shot TTL write-gate behavior. Maximum: 20 active minutes.

## Worker runtime receipt — 2026-08-11 17:09 MSK

- Harness: multi-agent worker / Codex desktop
- Agent session: `019ff124-1620-7911-aff0-a20d21522e86`
- PID: unknown; PID status: shutdown after bounded wait
- Last PID signal: close_agent after no completion receipt
- Last task-file transition: task card unchanged at 17:04:51 MSK; no standalone source/test files created
- Result: implementation slice overran/returned no evidence; do not infer completion.

## Overseer assignment after implementation overrun

Audit whether the standalone route can continue without source collision or
whether the task needs a smaller slice/reassignment. Inspect this task card and
current receipts only; no source edits, browser/CDP, Telegram, deployment, or
new worker. Return one verdict: CONTINUE, RETHINK, ASK_USER, or
STOP_SCOPE_DRIFT, with the smallest next slice and max 20 minutes.

## Worker retry receipt — 2026-08-11 17:12 MSK

- Resumed prior Worker session: `019fef3d-7469-79b1-a3e2-c404834b0211`.
- PID: unknown; PID status: shutdown after bounded retry; last PID signal: close_agent.
- No completion receipt, source files, tests, browser actions, Telegram calls, or deployment actions were produced.
- The standalone implementation remains pending; do not infer completion from the worker filename or resume status.

## User resume receipt — 2026-08-11 17:23 MSK

- User explicitly resumed the request with `делай`.
- Retry is authorized for the same standalone implementation slice only.
- Next Worker must edit only the four authorized new paths, run the focused
  fake-CDP checks, and return a completion receipt or a concrete blocker.

## Worker retry receipt — 2026-08-11 17:25 MSK

- Agent session: `019ff134-db69-7d31-ab41-ac25edefcbf1`
- PID: unknown; PID status: shutdown; last PID signal: close_agent after bounded wait
- No completion receipt, source files, focused tests, browser actions, Telegram calls, or deployment actions were produced.
- Child runtime is dead/unknown for this route; standalone implementation remains incomplete.

## Worker completion receipt — 2026-08-11 17:46 MSK

- Status: `DONE`; feature/implement slice completed within the authorized standalone scope.
- Business-canary delta: the standalone contract now creates one disposable fixture, returns origin/account/page/lease-bound opaque refs, supports explicit `unread`/`working`/UTC-`recent` list semantics, case-insensitive search, bounded export, confined allowlisted media download, and fixture-only guarded send/edit. No real browser, existing E-Frontier prompt, Telegram, deployment, or registry integration was used.
- Changed only the four authorized paths: `src/cdp-chat.ts` (adapter, page lease, refs, fixture binding, bounds, one-shot TTL gate), `src/cdp-chat-mcp.ts` (seven standalone MCP tools plus explicit driver-module loader), `tests/cdp-chat.test.ts` (fake-CDP acceptance suite), and `docs/cdp-chat-mcp.md` (contract/runbook).
- Verification: `npx vitest run tests/cdp-chat.test.ts --config vitest.config.ts` => 4 tests passed; `npx tsc --noEmit` => passed; `npm run build` => passed; `git diff --check` => passed.
- Focused evidence covers: new fixture creation, all three list views, search, production target rejection, lost page lease rejection, bounded UTF-8 export, MIME/size/path-confined media write, exact confirmation rejection, operation/payload-bound idempotency conflict, one-shot duplicate rejection, expected-version edit, and TTL expiry on replay.
- Remaining risk: the concrete BrowserClaw/CDP page driver is intentionally injected through `CDP_CHAT_DRIVER_MODULE`; Agent Herder registry/package integration and live new-chat canary remain separately deferred/gated. The standalone MCP is therefore locally verified but not a live ChatGPT/E-Frontier deployment.

## Reviewer assignment — post-implementation gate

Fresh context-free Reviewer: inspect only the task-owned standalone diff and
the worker's evidence. Check scope isolation, MCP tool registration, fixture
binding/page lease, list semantics, bounds/path confinement, write gate,
idempotency/version behavior, and test quality. Do not edit source, use a real
browser, touch Telegram, deploy, or modify foreign hunks. Return PASS or one
concrete finding with exact path/line and append the receipt. Maximum 15 active
minutes.

## Overseer assignment — post-implementation gate

Continue the task audit from this card. Confirm the worker completion is real,
the standalone route stayed within user-authorized scope, and the remaining
CDP-driver/registry/live-canary exclusions are explicit. Do not edit source or
perform browser/deployment actions. Return CONTINUE or a blocking verdict and
append the receipt. Maximum 10 active minutes.

## Reviewer receipt — post-implementation gate (2026-08-11 17:59 MSK)

- Scope: reviewed only `src/cdp-chat.ts`, `src/cdp-chat-mcp.ts`,
  `tests/cdp-chat.test.ts`, and `docs/cdp-chat-mcp.md`; foreign dirty paths,
  registry files, browser/CDP runtime, Telegram, and deployment were not
  touched.
- Verification: `npx vitest run tests/cdp-chat.test.ts --config
  vitest.config.ts` passed 4/4; `npx tsc --noEmit` passed; `npm run build`
  passed. An in-memory MCP handshake returned exactly
  `new_chat`, `list_chats`, `search_chat`, `export_chat`, `send_message`,
  `edit_message`, and `download_media`.
- Verdict: `CHANGES_REQUIRED`.

### Finding [P1]

`src/cdp-chat.ts:432-444` binds whatever raw ID `page.createChat()` returns as
the disposable fixture without proving that the ID is newly created and was
not already visible before the action. If BrowserClaw selector drift or a
driver fallback returns an existing production chat, `newChat` marks its
existing reference as `fixture=true`; `resolveChat(..., true)` then permits
`exportChat`, `sendMessage`, `editMessage`, and `downloadMedia` against that
production chat. A fake-driver repro returned `production-chat` from
`createChat()`: `newChat` succeeded and `exportChat` returned the production
message text.

Smallest bounded fix: snapshot the page before `createChat`, reject a returned
ID already present in that snapshot, then confirm the returned ID appears in a
fresh post-create snapshot before setting `this.fixture` or marking the
reference fixture-bound. Add one regression test for a driver that returns an
existing ID and assert that no write-capable fixture reference is issued.

Unverified by design: the concrete BrowserClaw/CDP driver, Agent Herder
registry integration, and live ChatGPT/E-Frontier canary remain deferred and
were not used as acceptance evidence.

## Overseer receipt — 2026-08-11 17:56 MSK

- Verdict: `CONTINUE`.
- Worker completion is real: the four task-owned paths exist as untracked files,
  and the focused fake-CDP suite passed 4/4; `npx tsc --noEmit`, `npm run build`,
  and `git diff --check` also passed.
- Scope held: no registry, package, browser runtime, Telegram/Overpod, live
  browser, deployment, or restart action was taken; the existing dirty registry
  and BrowserClaw worker hunks remain preserved as foreign work.
- Remaining exclusions are explicit in the task card and docs: the concrete
  `CDP_CHAT_DRIVER_MODULE`, Agent Herder registry integration, and live
  ChatGPT/E-Frontier new-chat canary remain deferred/gated.
- Next minimum action: fresh context-free Reviewer inspects only the four
  standalone paths and this evidence, maximum 15 active minutes; no deployment
  follows without a separate gate.

## Reviewer finding — P1 fix required

Reviewer found at `src/cdp-chat.ts:432-444` that `new_chat` trusted the ID
returned by `createChat()` and could bind an existing production chat as the
disposable fixture; a fake-driver reproduction returned production text from
`exportChat`. No live CDP canary is allowed until fixed.

### Fix assignment

Fresh Worker owns only `src/cdp-chat.ts` and `tests/cdp-chat.test.ts`. Start with
a failing regression: pre-create snapshot, driver-returned existing ID, and
post-create verification must reject the fixture. Then implement the smallest
fix: reject any pre-existing chat identity, require a new post-create identity
bound to the same origin/account/page lease, and prove export cannot read the
old production chat. Run focused tests, tsc, build, and diff-check; append
evidence. Maximum 20 active minutes. No browser, Telegram, deployment, or
foreign MCP edits.

## Worker concurrency-fix receipt — 2026-08-11 19:07 MSK

- Status: `DONE`.
- Business-canary delta: concurrent `new_chat` calls are now fail-closed; the
  second call deterministically returns `new_chat_in_progress` before
  `createChat()`, while the first call creates the sole fixture and its receipt
  remains usable for `export_chat`.
- Red: the new deferred fake-page regression failed `1 failed, 7 passed`; the
  second call resolved a second fixture receipt under the old implementation.
- Green: the same focused suite passed `8/8`; the regression observed exactly
  one `createChat` call, one fixture receipt, and successful export through the
  first receipt.
- Changed only `src/cdp-chat.ts` and `tests/cdp-chat.test.ts`. The client now
  owns a per-instance `newChatInFlight` guard released in `finally`, so failed
  creation cannot leave the client permanently locked.
- Checks: `npx vitest run tests/cdp-chat.test.ts --config vitest.config.ts`
  passed `8/8`; `npx tsc --noEmit` passed; `npm run build` passed; both
  untracked-file `git diff --no-index --check` runs emitted no diagnostics
  (exit 1 is the expected no-index difference status).
- Scope held: no registry, package metadata, concrete browser/CDP runtime,
  Telegram/Overport, deployment, restart, branch/worktree, or foreign dirty
  path was touched.
- Remaining risk: concrete `CDP_CHAT_DRIVER_MODULE`, Agent Herder registry
  integration, and live ChatGPT/E-Frontier canary remain deferred and gated;
  the injected driver/page lease still needs the separately assigned review and
  real-surface acceptance slices.
- Smallest next slice: fresh context-free Reviewer read-only gate for the two
  changed paths, then the separately gated live new-chat canary.

## Post-new-chat-race Reviewer/Overseer assignment

Fresh Reviewer: verify the in-flight `new_chat` guard and deferred concurrency
regression on task-owned source/tests; return PASS or an exact finding. Fresh
Overseer: audit final scope and deferred live-driver/registry gates. Read-only
only; no browser/CDP, Telegram, deployment, or foreign hunks. Reviewer max 15
minutes; Overseer max 10 minutes.

## Final Tester assignments

Fresh `Tester` blast-radius pass: inspect the documented standalone MCP as a
user-facing surface, attempt the smallest black-box business flow that is safe
without production credentials, and report durable evidence. It may use the
documented stdio entrypoint but must not read source to explain away a missing
driver. If `CDP_CHAT_DRIVER_MODULE` is absent, return `STOP_MISSING_REAL_SURFACE`
with that exact boundary; do not fabricate a driver or touch real ChatGPT.

Fresh `Tester` zero-knowledge pass: read no source or Git changes; approach the
standalone MCP as a typical user using only its documented contract. Prove the
available tool surface or report `STOP_MISSING_REAL_SURFACE` if the concrete
CDP driver is unavailable. No browser credentials, Telegram, deployment, or
foreign edits. Both testers append evidence and return only a compact TL;DR.
Maximum 20 active minutes each.

## Worker fix receipt — 2026-08-11 18:06 MSK

- Status: `DONE`.
- Business-canary delta: `new_chat` now snapshots the owned page before creation,
  rejects a driver-returned chat ID already visible in that snapshot, and
  requires the returned ID to appear in a fresh post-create snapshot before any
  fixture-bound opaque reference is issued. A production chat cannot be adopted
  as the disposable fixture through this fallback path.
- Changed only `src/cdp-chat.ts` and `tests/cdp-chat.test.ts`. Added a focused
  `ExistingIdPage` regression driver and asserted that the returned existing
  production row remains `fixtureBound: false` and cannot be exported.
- Red proof: `npx vitest run tests/cdp-chat.test.ts --config vitest.config.ts`
  failed 1/5 because the pre-fix `newChat` promise resolved with a
  `fixture: true` reference for `production-chat`.
- Green proof: the same focused command passed 5/5. `npx tsc --noEmit` passed;
  `npm run build` passed. `git diff --check --no-index /dev/null` checks for
  both task-owned untracked files produced no whitespace diagnostics (exit 1
  is the expected no-index difference status).
- Scope/evidence: no browser or CDP session, existing E-Frontier prompt,
  Telegram, deployment, registry integration, foreign dirty path, branch, or
  worktree was touched. Live driver behavior and registry/live canary remain
  deferred as documented.

## Post-fix Reviewer assignment

Fresh Reviewer: inspect the task-owned diff after the P1 fix, reproduce the
existing-ID fake-driver case, and return PASS or a concrete finding. Do not
edit source, use browser/CDP, touch Telegram, deploy, or modify foreign hunks.
Maximum 15 active minutes.

## Post-fix Overseer assignment

Fresh Overseer: audit the post-fix evidence, scope, and remaining exclusions.
Return CONTINUE or a blocking verdict; do not edit source or perform live
browser/deployment actions. Maximum 10 active minutes.

## Post-fix Reviewer receipt — 2026-08-11 18:18 MSK

- Scope: reviewed only `src/cdp-chat.ts`, `src/cdp-chat-mcp.ts`,
  `tests/cdp-chat.test.ts`, and `docs/cdp-chat-mcp.md`; the existing registry,
  browser runtime, Telegram/Overpod paths, deployment, and foreign dirty hunks
  were not touched.
- Verification: `npx vitest run tests/cdp-chat.test.ts --config
  vitest.config.ts` passed 5/5; the focused existing-ID regression passed 1/1;
  `npx tsc --noEmit` passed; `npm run build` passed; and the built MCP server
  exposed exactly the seven documented tools. The post-fix existing-production
  ID case is therefore reproduced and remains rejected.

### Finding [P2]

`src/cdp-chat.ts:401` creates the caller-selected `outputDir` recursively before
`src/cdp-chat.ts:403` checks whether its real path is inside the configured
media root. A fake-CDP download with `outputDir=../cdp-review-root-*-outside`
was rejected with `media_path_escape`, but still created that directory outside
the root. This violates the promised confined output side effect and lets a
caller create arbitrary writable directory paths even though the media request
fails; the focused suite has no negative assertion for this.

Smallest bounded fix: perform a lexical containment check on the resolved
candidate before `mkdir`, and validate the real existing parent/ancestor before
recursive creation so a symlinked component cannot cause outside directory
creation; retain the post-`realpath` check. Add one regression asserting that a
rejected traversal target is not created. This is a <=20-minute Worker slice.

- Verdict: `CHANGES_REQUIRED`.
- Unverified by design: the concrete `CDP_CHAT_DRIVER_MODULE`, Agent Herder
  registry integration, and live ChatGPT/E-Frontier canary remain deferred and
  were not used as acceptance evidence.

## Worker raw-result projection final receipt — 2026-08-11 18:48 MSK

- Status: `DONE`.
- Business-canary delta: `send_message` and `edit_message` now project page
  records through `ExportedMessage`; serialized results expose only opaque
  `messageRef`/`mediaRef` values and never raw page message/media IDs.
- Red: the new focused regression failed `1 failed, 6 passed` before the fix
  because serialized `send_message` contained `message.id = "sent-1"`.
- Green: `npx vitest run tests/cdp-chat.test.ts --config vitest.config.ts`
  passed `7/7`; `npx tsc --noEmit` passed; `npm run build` passed; and both
  untracked-file `git diff --no-index --check` runs emitted no diagnostics
  (exit 1 is the expected no-index difference status).
- Changed only `src/cdp-chat.ts` and `tests/cdp-chat.test.ts`; no registry,
  package metadata, browser/CDP runtime, Telegram/Overpod, deployment,
  restart, branch/worktree, or foreign dirty path was touched.
- Remaining risk: concrete `CDP_CHAT_DRIVER_MODULE`, registry integration, and
  live ChatGPT/E-Frontier canary remain deferred and gated. Next slice is the
  fresh Reviewer/Overseer read-only gate.

## Overseer receipt — post-final projection gate (2026-08-11 18:55 MSK)

- Verdict: `CONTINUE`.
- Business delta: closer — all four standalone task-owned files exist; the
  focused fake-CDP suite independently passed `7/7`, `npx tsc --noEmit`
  passed, and the current source projects write results through opaque refs and
  rejects traversal before creating the caller-selected directory.
- Scope held: no Agent Herder registry/package integration, concrete CDP driver,
  live ChatGPT/E-Frontier page, Telegram/Overpod path, deployment, restart, or
  foreign dirty-hunk edit was taken; registry files remain unrelated dirty work.
- Estimate: within — no receipt proves the immutable 120-minute active ceiling
  was exceeded; the next gate is independently bounded to a fresh Reviewer
  slice of at most 15 minutes.
- Next minimum action: run that fresh context-free Reviewer on the final
  projection fix, then keep driver/registry/live-canary gates closed.

## Post-opaque-projection Reviewer/Overseer assignment

Fresh Reviewer: verify the public write-result projection and raw-ID leak
regression on the task-owned source/test files; return PASS or an exact
finding. Fresh Overseer: audit the final standalone scope and deferred gates.
Read-only only; no browser/CDP, Telegram, deployment, or foreign hunks.
Reviewer maximum 15 minutes; Overseer maximum 10 minutes.

## Worker raw-result projection fix receipt — 2026-08-11 18:47 MSK

- Status: `DONE`.
- Business-canary delta: `send_message` and `edit_message` now return the
  existing public `ExportedMessage` projection, so serialized MCP results
  contain opaque `messageRef`/`mediaRef` values and never raw page message or
  media IDs.
- Red proof: before the fix,
  `npx vitest run tests/cdp-chat.test.ts --config vitest.config.ts` failed the
  new regression (`1 failed, 6 passed`) because serialized `send_message`
  contained `message.id = "sent-1"`.
- Green proof: the same focused command passed `7/7`; `npx tsc --noEmit`
  passed; `npm run build` passed; and `git diff --no-index --check` against
  `/dev/null` for both task-owned untracked files emitted no whitespace
  diagnostics (exit 1 is the expected untracked-file difference status).
- Changed only `src/cdp-chat.ts` (public result types and write-result
  projection at `sendMessage`/`editMessage`) and `tests/cdp-chat.test.ts`
  (serialized raw-ID regression). No registry, package metadata, browser/CDP
  runtime, Telegram/Overpod path, deployment, restart, branch/worktree, or
  foreign dirty path was touched.
- Remaining risk: the concrete `CDP_CHAT_DRIVER_MODULE`, Agent Herder registry
  integration, and live ChatGPT/E-Frontier canary remain deferred and gated.
- Smallest next slice: fresh Reviewer/Overseer read-only gate on this fix;
  keep live-driver, registry, and deployment gates closed.

## Reviewer finding — P2 opaque-result fix required

Reviewer found at `src/cdp-chat.ts:542` and `:558` that `send_message` and
`edit_message` return raw `MessageRecord` objects from the page seam. The raw
message ID and raw media IDs can escape the MCP result, bypassing the opaque
reference contract. No live canary is allowed until fixed.

### Fix assignment

Fresh Worker owns only `src/cdp-chat.ts` and `tests/cdp-chat.test.ts`. Add a
failing regression asserting serialized send/edit results contain only public
opaque `messageRef` and opaque media refs, never raw page message/media IDs.
Implement the smallest public message projection and keep read-back/version
behavior green. Run focused tests, tsc, build, and diff-check; append evidence.
Maximum 20 active minutes. No browser, Telegram, deployment, or foreign MCP
edits.

## Overseer receipt — post-fix gate (2026-08-11 18:12 MSK)

- Verdict: `CONTINUE`.
- Business delta: closer — the bounded standalone MCP exists, and the P1
  fixture-adoption path now has red/green regression evidence; the concrete
  CDP driver, Agent Herder registry integration, and live ChatGPT/E-Frontier
  canary remain intentionally unproven.
- Estimate: within — no recorded active-time total proves the immutable
  120-minute maximum was exceeded; the current next slice is independently
  bounded to the assigned 15-minute post-fix Reviewer gate.
- Scope: held — the four task-owned files are present; no browser/CDP,
  registry/package, Telegram/Overpod, deployment, restart, branch, or foreign
  dirty-path action was evidenced.
- Next minimum action: run the already assigned fresh context-free Reviewer on
  the two changed source/test paths and require PASS or an exact finding;
  preserve the live-driver/registry/deployment gates until then.

## Reviewer finding — P2 fix required

Reviewer found at `src/cdp-chat.ts:401` that `download_media` created
`outputDir` before containment validation. A traversal request was rejected,
but an external directory was already created. No live CDP canary is allowed
until fixed.

### Fix assignment

Fresh Worker owns only `src/cdp-chat.ts` and `tests/cdp-chat.test.ts`. Start
with a failing regression proving a rejected traversal creates no directory.
Move lexical containment and realpath-parent validation before `mkdir`, then
keep the successful confined download path green. Run focused tests, tsc,
build, and diff-check; append evidence. Maximum 20 active minutes. No browser,
Telegram, deployment, or foreign MCP edits.

## Worker P2 fix receipt — 2026-08-11 18:26 MSK

- Status: `DONE`.
- Business-canary delta: rejected `download_media` output paths are now
  fail-closed before any caller-selected directory is created. The adapter
  performs lexical containment and validates the realpath of the nearest
  existing ancestor before recursive creation, then retains the post-create
  realpath containment check. Successful confined media downloads remain green.
- Red proof: before the fix,
  `npx vitest run tests/cdp-chat.test.ts --config vitest.config.ts` failed the
  new traversal regression because the rejected outside directory already
  existed after the call (`5 passed, 1 failed`).
- Green proof: the same focused command passed `6/6`; `npx tsc --noEmit`
  passed; `npm run build` passed; and `git diff --check --no-index` against
  `/dev/null` for both task-owned untracked files emitted no whitespace
  diagnostics (exit 1 is the expected untracked-file difference status).
- Changed only `src/cdp-chat.ts` and `tests/cdp-chat.test.ts`; the test covers
  rejection without external directory creation and the existing successful
  confined download test remains passing.
- No browser/CDP session, existing E-Frontier prompt, Telegram, deployment,
  restart, registry integration, branch/worktree operation, or foreign dirty
  path was touched. Concrete driver behavior and live canary remain deferred
  as previously documented.

## Post-P2 Reviewer/Overseer assignment

Fresh Reviewer: verify the traversal fix and no-directory-created regression
on the two changed task-owned files; return PASS or an exact finding. Fresh
Overseer: audit this final fix and explicit deferred boundaries. Both are
read-only, with no browser/CDP, Telegram, deployment, or foreign hunks.
Reviewer maximum 15 minutes; Overseer maximum 10 minutes.

## Overseer receipt — post-P2 gate (2026-08-11 18:34 MSK)

- Verdict: `CONTINUE`.
- Business delta: closer — the P2 fix is present, and the focused fake-CDP
  suite passes `6/6`, including rejection without creating a traversal target.
- Scope: held — only the four standalone task-owned paths are relevant; no
  registry integration, concrete CDP driver, live ChatGPT/E-Frontier canary,
  Telegram, deployment, restart, branch, or foreign-hunk action was taken.
- Estimate: within — the current next gate remains the separately bounded
  context-free Reviewer slice (maximum 15 minutes); no evidence proves the
  immutable 120-minute active-time ceiling was exceeded.
- Next minimum action: run that fresh Reviewer on the P2 fix, require `PASS`
  or one exact finding, and keep live-driver/registry/canary gates closed.

## Post-P2 Reviewer receipt — 2026-08-11 18:39 MSK

- Scope: reviewed only the four standalone task-owned paths; the existing
  registry, concrete browser runtime, Telegram/Overpod paths, deployment, and
  foreign dirty hunks were not touched.
- Verification: `npx vitest run tests/cdp-chat.test.ts --config
  vitest.config.ts` passed `6/6`, including the no-directory-created traversal
  regression; `npx tsc --noEmit` passed; `npm run build` passed; and an
  in-memory MCP handshake exposed exactly the seven documented tools.
- The P2 traversal fix is present at `src/cdp-chat.ts:396-421`: lexical
  containment and nearest-existing-ancestor realpath validation happen before
  `mkdir(candidate)`.

### Finding [P2]

`src/cdp-chat.ts:542` and `src/cdp-chat.ts:558` return the raw `MessageRecord`
from the page seam inside `send_message` and `edit_message`. That nested object
contains the page's raw `message.id` and can also contain raw media IDs, even
though the surrounding result exposes an opaque `messageRef` and the task
contract promises stable opaque chat/message/media references. A built-server
reproduction returned `message.id = "raw-page-message-1"` to the MCP caller.

Smallest bounded fix: map write results through a public message projection that
contains the opaque `messageRef` and opaque media refs, never the raw
`MessageRecord`; add a regression asserting the serialized MCP result contains
no raw page message/media ID. This is a <=20-minute Worker slice.

- Verdict: `CHANGES_REQUIRED`.
- Unverified by design: the concrete `CDP_CHAT_DRIVER_MODULE`, Agent Herder
  registry integration, and live ChatGPT/E-Frontier canary remain deferred and
  were not used as acceptance evidence.

## Worker raw-result projection final receipt — 2026-08-11 18:49 MSK

- Status: `DONE`.
- Business-canary delta: `send_message` and `edit_message` now project page
  records through `ExportedMessage`; serialized results expose only opaque
  `messageRef`/`mediaRef` values and never raw page message/media IDs.
- Red: the new focused regression failed `1 failed, 6 passed` before the fix
  because serialized `send_message` contained `message.id = "sent-1"`.
- Green: `npx vitest run tests/cdp-chat.test.ts --config vitest.config.ts`
  passed `7/7`; `npx tsc --noEmit` passed; `npm run build` passed; and both
  untracked-file `git diff --no-index --check` runs emitted no diagnostics
  (exit 1 is the expected no-index difference status).
- Changed only `src/cdp-chat.ts` and `tests/cdp-chat.test.ts`; no registry,
  package metadata, browser/CDP runtime, Telegram/Overpod, deployment,
  restart, branch/worktree, or foreign dirty path was touched.
- Remaining risk: concrete `CDP_CHAT_DRIVER_MODULE`, registry integration, and
  live ChatGPT/E-Frontier canary remain deferred and gated. Next slice is the
  fresh Reviewer/Overseer read-only gate.

## Reviewer receipt — post-opaque-projection gate (2026-08-11 18:58 MSK)

- Scope: reviewed only `src/cdp-chat.ts`, `src/cdp-chat-mcp.ts`,
  `tests/cdp-chat.test.ts`, and `docs/cdp-chat-mcp.md`; no registry, concrete
  browser/CDP runtime, Telegram/Overpod path, deployment, or foreign dirty
  hunk was touched.
- Verification: `npx vitest run tests/cdp-chat.test.ts --config
  vitest.config.ts` passed `7/7`; `npx tsc --noEmit` passed; `npm run build`
  passed; `git diff --no-index --check` reported no whitespace diagnostics
  for all four untracked task files (exit 1 is the expected no-index status);
  the built standalone server exposed exactly the seven documented tools.
- Independent fake-CDP concurrency repro: two `newChat` calls started with
  different idempotency keys while `createChat()` was awaiting. Both calls
  passed, two fixture rows were created, and both returned `fixture: true`.
  The second call overwrote `this.fixture`; the first returned `chatRef`
  subsequently failed `exportChat` with `fixture_required`, while the second
  chat exported successfully.

### Finding [P1]

`src/cdp-chat.ts:451-473` checks only `this.fixture` before the first
  asynchronous page operation and has no in-flight creation lock. Concurrent
  MCP calls can therefore create multiple disposable chats despite the
  "exactly one" contract, return two apparently valid fixture receipts, and
  leave the first receipt unusable after the second call overwrites the binding.
  This is an unintended write-side effect even though no existing production
  chat is targeted.

Smallest bounded fix: add a per-client `newChat` in-flight guard/promise that
  rejects or serializes a second call before `createChat()`; add a deferred
  fake-page regression asserting one page creation, one successful fixture
  receipt, and deterministic rejection of the concurrent call. This is a
  <=20-minute Worker slice.

- Verdict: `CHANGES_REQUIRED`.
- Unverified by design: the concrete `CDP_CHAT_DRIVER_MODULE`, Agent Herder
  registry integration, and live ChatGPT/E-Frontier canary remain deferred and
  were not used as acceptance evidence. The review assumes the injected driver
  itself honors the documented page lease; no mid-action identity-switch live
  proof exists.

## Reviewer finding — P1 new-chat concurrency fix required

Reviewer found at `src/cdp-chat.ts:451-473` that concurrent `new_chat` calls
can both pass the preflight, create two chats, return two fixture receipts, and
then let the second overwrite the first fixture binding. No live CDP canary is
allowed until fixed.

### Fix assignment

Fresh Worker owns only `src/cdp-chat.ts` and `tests/cdp-chat.test.ts`. Add a
failing deferred fake-page regression with two concurrent `new_chat` calls;
then add a per-client in-flight guard/promise that rejects or serializes the
second call before `createChat()`. Assert exactly one page creation, one valid
fixture receipt, deterministic second-call rejection, and successful export
through the first receipt. Run focused tests, tsc, build, and diff-check;
append evidence. Maximum 20 active minutes. No browser, Telegram, deployment,
or foreign MCP edits.

## Overseer receipt — post-new-chat-race gate (2026-08-11 19:14 MSK)

- Verdict: `CONTINUE`.
- Worker completion is real: the task-owned standalone source/test/docs files
  exist; `src/cdp-chat.ts` contains the per-client `newChatInFlight` guard and
  the deferred concurrency regression passes. Fresh verification passed
  `npx vitest run tests/cdp-chat.test.ts --config vitest.config.ts` (`8/8`),
  `npx tsc --noEmit`, and `npm run build`.
- Scope held: only `src/cdp-chat.ts`, `src/cdp-chat-mcp.ts`,
  `tests/cdp-chat.test.ts`, and `docs/cdp-chat-mcp.md` are task-owned; no
  registry/package, concrete browser/CDP, Telegram/Overpod, deployment,
  restart, branch/worktree, or foreign dirty-path action was taken.
- Estimate: within — no receipt provides an active-time total proving the
  immutable 120-minute ceiling was exceeded; this audit stayed read-only apart
  from its task receipt.
- Remaining gates: concrete `CDP_CHAT_DRIVER_MODULE`, Agent Herder registry
  integration, and live ChatGPT/E-Frontier canary remain explicitly deferred.
- Next minimum action: fresh context-free Reviewer gate on the concurrency fix,
  maximum 15 active minutes; keep live-driver/registry/deployment gates closed.

## Reviewer receipt — post-new-chat-race gate (2026-08-11 19:16 MSK)

- Scope: independently reviewed only the four task-owned standalone paths:
  `src/cdp-chat.ts`, `src/cdp-chat-mcp.ts`, `tests/cdp-chat.test.ts`, and
  `docs/cdp-chat-mcp.md`. No source, registry, browser/CDP runtime,
  Telegram/Overpod, deployment, or foreign dirty path was changed.
- Verification: `npx vitest run tests/cdp-chat.test.ts --config
  vitest.config.ts` passed `8/8`; `npx tsc --noEmit` passed; `npm run build`
  passed; four untracked-file `git diff --no-index --check` runs reported no
  whitespace diagnostics (exit 1 is the expected no-index difference status).
  An actual built-server MCP client handshake over `InMemoryTransport` returned
  exactly `new_chat`, `list_chats`, `search_chat`, `export_chat`,
  `send_message`, `edit_message`, and `download_media`.
- Review result: `src/cdp-chat.ts:451-480` sets `newChatInFlight` before the
  first asynchronous page operation, rejects a concurrent call with
  `new_chat_in_progress` before `createChat()`, and releases the guard in
  `finally`. The deferred regression at `tests/cdp-chat.test.ts:201-221`
  proves exactly one page creation, deterministic rejection of the second
  call, and successful export through the first fixture receipt. The previous
  P1 race is fixed; no additional bounded finding remains.
- Unverified by design: the concrete `CDP_CHAT_DRIVER_MODULE`, Agent Herder
  registry integration, and live ChatGPT/E-Frontier canary remain deferred;
  this approval is for the standalone fake-CDP/MCP contract only.
- Verdict: `APPROVE`.

## Tester receipt — real-use standalone MCP boundary (2026-08-11 19:23 MSK)

- Role/mode: fresh Tester blast-radius pass. I read this task card only for
  intended outcome, canary, allowed actions, target surface, and stop
  conditions; I did not inspect source, tests, docs, or Git changes to explain
  away the result.
- Surface/tool: attempted the actual standalone stdio MCP entrypoint
  `src/cdp-chat-mcp.ts` from the task checkout through an MCP SDK
  `StdioClientTransport`, with `CDP_CHAT_DRIVER_MODULE` unset/empty. The
  required environment value was absent. No BrowserClaw/CDP page or
  authenticated ChatGPT/E-Frontier surface was opened.
- Journey: attempted MCP `initialize` and `tools/list`; the client received
  `MCP error -32000: Connection closed` before `tools/list`, so no
  `new_chat`, read operation, write operation, or media operation ran and no
  chat was created or mutated.
- Bounded launcher observation: `timeout 8s npx --no-install tsx
  src/cdp-chat-mcp.ts </dev/null` failed before server startup with
  `npm error npx canceled due to missing packages and no YES option:
  ["tsx@4.23.12"]`. This is additional launcher evidence, not a substitute
  for the missing concrete CDP driver.
- Evidence boundary: no browser/page was owned or created, so a browser
  screenshot is not applicable; there is no real-user business-result proof.
  Unit/fake-CDP/build receipts in earlier sections were not used as live
  acceptance evidence.
- Verdict: `STOP_MISSING_REAL_SURFACE`.
- Smallest unblock: provide the supported standalone runner and an attested
  concrete `CDP_CHAT_DRIVER_MODULE` bound to the authenticated ChatGPT/
  E-Frontier page, then repeat both fresh real-use Tester passes. No browser,
  credential, registry, Telegram, deployment, or cleanup action was taken.

## Tester receipt — standalone real-use gate (2026-08-11 19:22 MSK)

- Scope: fresh context-free Tester pass for the documented standalone MCP
  surface; no production credentials, existing E-Frontier conversation,
  Telegram, deployment, or source changes were used.
- Intended journey: establish the concrete owned CDP/BrowserClaw driver first,
  then create the disposable new-chat fixture and run the bounded read canary
  (`list_chats`, `search_chat`, `export_chat`, and media behavior). This is the
  required precondition before any guarded write check.
- Observed surface availability: `CDP_CHAT_DRIVER_MODULE=absent` and the
  `browserclaw` executable is absent in this Tester context. Playwright is
  installed, but no configured concrete driver module or owned authenticated
  ChatGPT/E-Frontier page is exposed; it was not used as a substitute.
- Result: the main user journey could not be started. No new chat, prompt,
  send/edit operation, media download, fake driver, synthetic HTTP/CDP flow,
  or alternate browser surface was used. No screenshot was captured because
  no owned browser page/session existed and no UI error or timeout occurred.
- Required unblock: provide the authorized concrete `CDP_CHAT_DRIVER_MODULE`
  and owned authenticated page surface, then rerun this fresh Tester pass.
- Verdict: `STOP_MISSING_REAL_SURFACE`.

## Final handoff — 2026-08-11

- Standalone contract status: `DELIVERY P0 CONFIRMED LOCALLY` — seven tools,
  fixture binding, page lease, list semantics, bounded export/media, guarded
  writes, opaque projections, traversal confinement, and new-chat concurrency
  are covered by fresh red/green fake-CDP evidence and approved review gates.
- Live ChatGPT/E-Frontier business status: `P0 NOT CONFIRMED` — both fresh
  real-use testers stopped at `STOP_MISSING_REAL_SURFACE` because no concrete
  `CDP_CHAT_DRIVER_MODULE`, BrowserClaw page, or authenticated owned surface
  was available. No browser screenshot is applicable because no page/session
  was owned or opened.
- Task-owned files: `src/cdp-chat.ts`, `src/cdp-chat-mcp.ts`,
  `tests/cdp-chat.test.ts`, `docs/cdp-chat-mcp.md`.
- Verification after the last fix: focused fake-CDP suite `8/8`, `tsc`,
  `npm run build`, whitespace checks, and in-memory MCP handshake exposing
  exactly seven tools.
- Explicitly deferred: concrete BrowserClaw/CDP adapter, Agent Herder
  registry integration, live new-chat canary, deployment/restart, Telegram,
  Overpod, and existing production E-Frontier.
- Next follow-up: add the concrete driver as a separate adapter integration,
  then repeat both real-use Tester passes before any guarded write or deploy.
