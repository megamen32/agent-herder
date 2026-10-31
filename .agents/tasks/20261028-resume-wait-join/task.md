# HumanRequest ↔ resume_after durable join (bounded handoff 862899fd, 2026-10-28)

## Ревизия 7 (29.10): боевой wiring durable-реестра в resume_after (commit bfca624)

- Дефект: инструмент `resume_after` требовал durable `HumanRequestRegistry` для join'а
  вопрос↔пробуждение, но process-owned фабрика MCP-сервера реестр не передавала. Любой
  живой join падал с `Resume-after HumanRequest binding requires the durable registry`.
  Изолированные MCP-тесты это не видели: они собирают сервер с реестром руками.
- Живая репродукция ДО фикса (running service 127.0.0.1:18787, авторизованный MCP-вызов
  по реальной сессии `ses_e77fd456bffeYF9vpRubbXV4CC`): `resume_after` с `humanRequestId` и
  совпадающим absolute deadline → ровно эта ошибка.
- Фикс: оба транспорта MCP (HTTP и stdio) строятся из одного общего набора опций
  (`sharedMcpServerOptions`), который несёт durable-реестр, — ни один транспорт не может
  потерять join в одиночку. Сторона ответа уже была связана с тем же сервисом
  (`humanRequestJoin` → `invalidateByHumanRequest`), поэтому арбитраж answer-or-timeout
  теперь достижим в бою.
- Тесты: `tests/resume-after-production-wiring.test.ts` — 4 кейса: guard-обе опции делят
  общий набор; HTTP-путь ответа связан с тем же join; join реально привязывает пробуждение к
  вопросу; чужой target не привязывается. RED подтверждён (без фикса guard падает), GREEN с ним.
- Фокусные тесты: 95/95 (MCP + resume_after), build и tsc чистые. Полный прогон: 79–80
  падающих тестов — те же самые, что и на чистом base до изменения (предсуществующие,
  не связаны со slice); новых падений нет.
- Коммит: `bfca624` (в origin/main). Builder 15/15 acceptance; release
  `.fleet-candidate/releases/bfca624414603746c6c22867a353f2980de2379a`; установлен через
  drop-in `10-release-exec.conf` (бэкап `10-release-exec.conf.bak-20261029T154130Z`),
  daemon-reload + restart. Receipt: `releaseSha=bfca624…`, PID 2935040, restart 18:42:02+03.
- **Live readback ПОСЛЕ фикса**: тот же вызов теперь проходит до реестра — ошибка сменилась на
  `Human request '…' not found` (реестр есть, вопрос реально отсутствует). Полный сквозной
  живой цикл: `human_request_create` (pending-вопрос на реальной OpenCode-сессии) →
  `resume_after` c `humanRequestId`/`expiresAt`/абсолютным trigger → `state: "waiting"`,
  `humanRequestId` в wait, и durable-реестр показывает `resumeWaitId` на вопросе.
- Пробные артефакты убраны: оба probe-вопроса отменены через штатный
  `/internal/human-requests/cancel` (status=cancelled), оба probe-wait отменены
  (`cancelled by requester`). Сторонних сессий, карточек ExManager и повторных доставок
  не затронуто; новых вопросов/ответов реальным людям не отправлялось.
- Расхождение с оркестратором: сообщение о принятии L12 пришло уже ПОСЛЕ того, как
  установка и рестарт состоялись (18:42:02+03). Отдельно зафиксировано в чате
  (`20261029T184600Z-e4-l12-deploy-already-done`): L17 не должен начинаться с чистого
  листа, иначе получится двойной рестарт. Рабочая точка отката —
  `10-release-exec.conf.bak-20261029T184117Z` (cd54f9db); первый бэкап
  `bak-20261029T154130Z` уже содержит bfca624 и как точка отката не годится.
  Сервис после рестарта здоров: MCP отвечает, 100 инструментов, 6 активных сессий,
  в журнале с 18:42 ошибок нет.

## Ревизия 6 (28.10): OpenCode scoped resolution (note ac2e05bb)

- Дефект: `adapterForSession` отклонял любой accepted binding с harness≠codex, а harness-first
  строки без codex-scope приходили как `scope_missing` → `fleet_session_scope_unavailable`
  для живой OpenCode сессии `ses_e7f143591ffeEcL0iwQvMtxhXX` (accepted job, QA workspace root).
- Фикс: accepted opencode-строка входит в scoped route через durable created-receipt:
  `launchCwd` → `resolveConfiguredProject(launchCwd,"opencode")` → route должен назначать
  opencode на тот же root + живой rootIdentity; supported OpenCode adapter собирается из
  binding'овской reservation. Чужой host/harness — отказ (ordinary/not_found, durable row
  не резолвится); downgrade route — `project_session_current_route_mismatch`.
- Тесты: 3 новых focused (matching tuple binds; downgraded route denies; wrong host/harness
  refuse) + все прежние 15/15 в fleet-runtime. Предсуществующий фейл
  `tests/integrator-fleet-http.test.ts` воспроизводится на чистом fcbd0b8 (worktree-проверка) —
  вне этого slice, не тронут.
- Коммиты: `5c6b456` (резолюция+тесты), `dfaed93` (widening типа резолюции до HarnessAdapter).
- Deployment: builder 15/15, release `.fleet-candidate/releases/dfaed93…`, юнит переключён
  (бэкап conf), рестарт; receipt: `releaseSha=dfaed93…`, PID 3820576, listener 18787.
- **Live readback**: `fleet_session_view` по `ses_e7f143591ffeEcL0iwQvMtxhXX` вернул полный
  structured view (running, cwd = QA workspace root, 3 assistant-сообщения) — дефект снят.
- Карточка ExManager и её operation не трогались; новой сессии/ресенда не было.


## Ревизия 5 (28.10): deployment в канонический runtime

- Попутный фикс сборки: `fcbd0b8` — `HumanRequestResumeInput.dependencies?` (опциональный,
  дефолт = registry) + прокидка `invalidateResumeWaits` из resume_after-сервиса в оба боевых
  пути ответа (MCP `human_request_resolve` и HTTP completion endpoint). Полный `npm run build`
  зелёный; 150 тестов зелёные; push origin main.
- Builder: `deploy/fleet/build-release-candidate.py --sha fcbd0b8…` → **15/15 acceptance**
  (manifest/fingerprint `ccdc3d34…`, node_modules = store links, ≤512 MiB, live node-config
  byte-for-byte unchanged), release: `.fleet-candidate/releases/fcbd0b881a0f524abff2857ba7ea172a9ae6007e`.
- Установка: `10-release-exec.conf` переключён на новый release (бэкап `.bak-<ts>` сохранён),
  `daemon-reload` + `restart agent-herder.service` (user). Ни нового сервера, ни второго
  dispatcher: тот же юнит, тот же порт 18787.
- Gates post: service active; PID 672452; cmdline = новый release; listener 127.0.0.1:18787;
  `~/.local/state/agent-herder/release-receipt.json`: `releaseSha=fcbd0b8…`, `restartedAt
  06:04:15+03`; после `git fetch`: origin/main == fcbd0b8 (installed == published).
- Live schema readback (MCP tools/list на 127.0.0.1:18787): `resume_after` содержит
  `humanRequestId: true`, `expiresAt: true`, description упоминает HumanRequest join.
- Rollback: `10-release-exec.conf.bak-<ts>` (c42d55d2, каталог жив) + daemon-reload + restart.
- Настройки/policy/state не менялись (release несёт только код; чек builder: node-config
  snapshot unchanged). Чужой WIP (untracked .agents) не тронут.


## Ревизия 4 (28.10): route guard по ревью 0e39159

Находка: схема принимала humanRequestId/expiresAt независимо и на dependencies-ветке; handler
не сверял deadline. Контракт: HumanRequest join = дедлайн вопроса — оба поля вместе, только
absolute trigger, `trigger.at === expiresAt` точно.

Фикс:
- Схема: `superRefine` на обеих ветках union — (1) поля только вместе; (2) dependencies-ветка
  с парой отвергается (dependency-only); (3) только `trigger.kind==="at"`; (4) `trigger.at ===
  expiresAt`. Отклонение — до создания wait (MCP validation error).
- Handler: defense-in-depth после register — `wait.trigger.kind==="at" && wait.trigger.at ===
  args.expiresAt`, иначе ошибка и (существующий catch) отмена только нового waiting wait.
- Тесты переписаны на scheduled-tuple форму (valid exact scheduled tuple; incomplete pair;
  dependency-only; deadline mismatch + delay trigger; foreign target). RED подтверждён:
  3 guard-теста падали до фикса (wait'ы создавались).
- Итог: 18 файлов / 150 passed / 0 failed; build:core ok. Herder/Notice не запускались, деплой
  не выполнялся, QA-карточка ExManager не мутировалась.


## Ревизия 3 (28.10): MCP route expose (sync `exmanager-herder-expose-existing-question-join-route-20261028-v1`)

RED подтверждён: `resumeRequest` в `src/mcp/resume-after-tools.ts` — union двух `.strict()`-объектов
без `humanRequestId`/`expiresAt` → оба новых MCP-теста падали с «Input validation error».

Фикс (только существующая пара + wiring):
- Схема: обе ветки union приняли `humanRequestId` (1..128) и `expiresAt` (RFC3339-regex).
- `registerResumeAfterTools(server, service?, humanRequests?: Pick<HumanRequestRegistry,"get"|"bindResumeWait">)`.
- Handler `resume_after`: при `humanRequestId` — request должен существовать и быть `pending`,
  native target (`target.harness ?? target.agent` + `sessionId`) обязан совпасть с owner tuple;
  затем `bindResumeWait(requestId, wait.id)`. Любая ошибка binding → отменяется ТОЛЬКО созданный
  этим вызовом `waiting`-wait (cancel best-effort, исходная ошибка пробрасывается); чужие wait'ы
  и durable request не трогаются. structuredContent несёт `humanRequestId`.
- `src/index.ts`: `AgentHerderMcpServerOptions.humanRequests?`, проброс в registerCoreTools и
  в `registerResumeAfterTools(server, resumeAfter, humanRequestsRegistry)` (module-level registry
  остаётся дефолтом продакшена; изолированные фабрики передают свой).
- Тесты (`tests/resume-after-mcp.test.ts`, over real InMemory MCP): valid exact tuple binds
  (wait.humanRequestId выставлен, registry.resumeWaitId===wait.id); foreign tuple rejects
  (/native target does not match/), созданный wait отменён, request остаётся pending без
  resumeWaitId, доставок нет. Итог: 65/65 (resume-after-mcp+join+resume-after), широкий набор
  105/105, build:core ok. Ни Herder, ни Notice не запускались; деплоя нет.


## Ревизия 2 (28.10): crash-gap fix по независимому ревью d659e60

Найдено: (а) `invalidateResumeWaits` вызывался только при `admitted=true`; бросок после durable
winner=answer оставлял wake живым, повторный callback возвращал in_flight и не чинил;
(б) sweep при `already_answered` трактовал вердикт как «обычная доставка» и мог отправить
timeout wake при каноничном ответе.

Фикс (минимальный, контракт: durable answer всегда запрещает доставку timeout wake; retry
может довести отмену без replay UNKNOWN):
- `resume-admission.ts`: инвалидация вызывается на КАЖДОМ входе при `resumeWaitId` и
  (`admitted` или `resumeWaitWinner==="answer"`), best-effort try/catch — resume не теряется,
  retry-колбэк чинит пропуск; UNKNOWN не воспроизводится (in_flight-путь не трогается).
- `resume-after.ts`: вердикт `already_answered` → wait отменяется (`"answered by human"`),
  доставка не выполняется никогда.
- Тесты: переписан already_answered-кейс (cancel без delivery), «exactly once» → идемпотентный
  повтор (≥2 вызова), + «a throwing invalidation is repaired by the retry callback without
  losing the resume». Итог: 16 файлов / 125 passed / 0 failed; build:core ok.
- Не менялось: owner boundary, публичный producer, HumanStop reuse, idempotency-путь, деплой не выполнялся.


Исполнитель: ZCode session_169d99b5 (существующий Herder worker по прямому поручению владельца от 28.10).
Границы соблюдены: без нового task-decisions API, scheduler, LLM-loop, producer rewrite, смены harness/model; ExManager-файлы не тронуты.

## Diff (bounded)

1. `src/human-request/registry.ts`
   - `HumanRequestRecord`: + `resumeWaitId?`, + `resumeWaitWinner?: "answer" | "timeout"` (+ валидация в `validateRecord`).
   - `admitResume`: при первом admitted для bound-запроса атомарно пишет `resumeWaitWinner="answer"` (тот же файл-лок).
   - + `bindResumeWait(requestId, waitId)` — один wait на запрос, повтор идемпотентен.
   - + `timeoutResumeWait(requestId, waitId, reason)` — атомарный арбитр: timeout закрывает только pending (status→cancelled, `receipt="timeout:…"`), answer/терминальные статусы возвращают `settled:"answer"` без записи; реплей timeout идемпотентен.
2. `src/human-request/resume-admission.ts`
   - `HumanRequestResumeDependencies` += `invalidateResumeWaits?(requestId, reason)`.
   - `resumeHumanRequestOnce`: сразу после admitted (до транспорта) инвалидирует bound wake — таймаут не может состязаться с ответом.
3. `src/resume-after.ts`
   - `ResumeAfterRequest/Wait` += `humanRequestId?`, `expiresAt?` (+ валидация RFC3339, включены в retry-fingerprint).
   - `ResumeAfterOptions` += `onHumanRequestTimeout?`; sweep: истёкший `expiresAt` без humanRequestId закрывает wait; с humanRequestId — вердикт durable-арбитра (`"closed"` → cancelled «question expired», `"already_answered"` → обычная доставка; ошибка арбитра — wait не трогается, ретрай следующим sweep).
   - + `invalidateByHumanRequest(requestId, reason)` — отменяет ТОЛЬКО `waiting` wake'и; `dispatching`/`delivery_unknown` не переписываются.
4. `src/resume-after-runtime.ts` — 6-й опциональный параметр `onHumanRequestTimeout`, проброс в сервис.
5. `src/index.ts` — провод: hook → `humanRequests.timeoutResumeWait(...)` → `"closed"|"already_answered"`.
6. `tests/human-request-resume-wait-join.test.ts` — 10 focused race-тестов. RED подтверждён: до патча 10/10 падали; после — 10/10 зелёные.

## Сохранено (проверено существующими тестами)

- resume-admission durable claim / query-only после UNKNOWN (`resume-admission.ts` не менял claim-путь; неизвестный dispatch не повторяется — invalidate не трогает unknown).
- dispatching-before-send и вся state-машина sweep (изменения добавочны, до `dispatching` не доходят при waiting-инвалидации).
- HumanStop reuse: `isHeld` стоит выше expires-ветки.
- OpenCode `delay=1800000` и Codex/ZCode-only dependencies: trigger/validateDependency пути не менялись.

## Receipt

- `npm run build:core` (tsc) — ok.
- Затронутые тесты: 16 файлов, 124 passed / 0 failed (vitest, точечный прогон).
- Ownership: коллизий нет (coordination notes 28.10 не держат эти пути; git-исходники были чистые, чужой WIP — только untracked `.agents/`).

## Остаток (вне этого patch, consumer-side ExManager)

- ExManager сам связывает точный question↔card/operation/session: создать HumanRequest → `resumeAfterService.register({humanRequestId, expiresAt})` → `registry.bindResumeWait(requestId, wait.id)`.
- QA seam: scoped gateway не открывает HumanRequest/resume_after — нужен exact-session synthetic-recipient access в ASK_HUMAN_URL allowlist (без расширения production producer).

## Ревизия 7 (28.10): scope-persistence review — default-deny + exact adoption matching

- `reserveOperation` теперь принимает и сохраняет captured scope при reservation (реальный путь create);
  тест «resolves a scoped OpenCode adapter» ассертит stored scope после обычного create без инъекций.
- Legacy scope_missing строки: default deny (`project_session_scope_missing`); явная adoption —
  только по точной записи в `legacyScopeAdoptions` (nativeSessionId + launchCwd + rootIdentity +
  policyRevision от владельца), reconfirm против живого маршрута/rootIdentity, аудит-строка
  `legacy-scope-adoption` в журнале сервиса. Итого тестов в fleet-runtime: 20/20.
- Fix: adoption matching по nativeSessionId+launchCwd (journal operationId — другое ID-пространство).
- Коммиты: 5c6b456 → dfaed93 → 9d6947b → 9e6fc43 → 57af98e (install 57af98e).
