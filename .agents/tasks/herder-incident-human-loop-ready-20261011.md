# Agent Herder: готовая ветка для интеграции Root

Исполнитель: Codex `01a12c46-c81c-70e0-b115-991dc09619f6`.
Рабочее дерево: существующее `herder-incident-human-loop`.
Ветка: `codex/herder-incident-human-loop`. Новые деревья и сессии не создавались.
Сохранена история передачи OpenCode; текущий `origin/main` включён через merge.

## Доставляемые исправления

1. Полный native receipt запуска хранится в attempt log. Первый ответ, replay
   после рестарта и проигравший atomic claim используют один projector.
   Реальный create/resume следует native `created`; admission flags не теряются.
2. Пустой override модели маршрута удаляет ключ и наследует общую модель.
   Удаление среды из маршрута удаляет её override. Production validator принимает
   итоговые настройки без пустых моделей и unused-harness ошибок.
3. Human queue OpenCode использует `/prompt_async`; успешный native ответ
   подтверждает admission независимо от окончания LLM. Повтор inputId не отправляет
   сообщение заново.
4. Только definite `agent-resume:native-unavailable` допускает атомарную повторную
   admission того же canonical resultRef. Attempt/key/answer time сохраняются;
   conflicting answer, неизвестный приём и живой lease не создают второй transport.
   Старый unavailable query не снимает reservation восстановленного вызова.
5. Только explicit project route и exact MiniMax subscription model используют
   preflight до create/send. Один минимальный probe, timeout 5 секунд, cache 30
   секунд, ответ до 16 KiB, один pending request. Existing protected MINIMAX_API_KEY
   остаётся в runtime environment; новых secret stores нет. Доказанный 4292056
   записывает quota_exhausted/not_attempted и выбирает следующий harness маршрута.
   Unknown probe и unconfigured default сохраняют явную OpenCode policy.

## Проверка и границы

Production build и **128/128 focused checks, 17 файлов** прошли одним ordinary
release-проходом. Build + checks: **62.417 секунд**; весь bounded запуск с setup
укладывается в 180 секунд. Runner: existing herder-delivery-build100, RAM high
1 GiB/max 2 GiB, swap 0, CPU 1, tasks 128, Vitest worker 1 (лимит пользователя 2),
CPU affinity 2, temp 256 MiB/20000 objects, IOWeight 10. Peak 648450048 bytes;
OOM и swap отсутствуют, native cleanup подтверждён.

| Сценарий | Найденный дефект / цель | Категория | Ожидаемые / максимальные секунды |
|---|---|---|---|
| First/restart/replayed atomic claim: accepted, pending, admitted failure, unknown | Разная форма receipt и неверный create вместо resume | fast unit | 2 / 10 |
| Настройки маршрута → production validator | Пустой override и модель удалённой среды ломали сохранение | fast unit | 1 / 5 |
| HTTP composer → supervisor → OpenCode native HTTP | Sync endpoint ожидал LLM вместо async admission; повтор должен быть один | focused integration | 1 / 5 |
| Concurrent reservation / named sessions в двух процессах | Один native runner, одинаковые cwd/model/name, рестарт без новой отправки | focused integration | 3 / 15 |
| Native-unavailable → restart → concurrent canonical answer | Terminal failure запрещал безопасное восстановление; неизвестное состояние не replay | focused integration | 2 / 10 |
| Stale query / lease expiry / более новый human stop | Старый failure receipt не должен снимать живую reservation или stop fence | focused integration | 2 / 10 |
| Minimal MiniMax probe → named runner → ordered route | Async business turn мог быть принят до позднего quota error; нужен pre-admission fallback | focused integration | 2 / 10 |
| Остальные выбранные queue, admission, crash и judge regression checks | Защита совместимых путей и включённого origin/main | focused integration | 15 / 45 |

Slow nightly и wide baseline suite не запускались. Исторические неудачные
результаты сохранены; лимиты не обходились. Исправлен nondeterministic reservation
test и ограничено число native threads без увеличения бюджета.

Точный manifest, команда, source pins, payload и native result находятся в
`.tmp/incident-release-ready/`. Manifest ожидает ровно 128 passed; helper exit 0.
Полный retry receipt и маршрутизация описаны в `docs/autopilot.md`.

Это готовность source-ветки, не live acceptance. Следующий шаг Root: интеграция
в main, согласованный deploy, реальный current-quota OpenCode → ZCode consumer
canary, Notice answer/resume и настоящий звонок. Телефонная модель, секреты,
сервисы, покупки и чужой canonical WIP не изменялись.

## MCP completion retry: дополнительное исправление после review

Изменён только `src/mcp/human-request-tools.ts`: retryable native-unavailable
проходит через atomic core; resumed и non-retryable terminal shortcuts сохранены.
`retry` объявлен в MCP output schema и передаётся обоими resolve handlers,
включая значение false. Registered MCP Client/Server regression проверяет
canonical recovery, concurrent callbacks, конфликтующий answer, неизменные
attempt/key/answer time, resumed shortcut и отсутствие native вызова при unknown.

Focused integration: `tests/human-request-mcp-resolve.test.ts`, 7/7 PASS,
ожидаемые/максимальные 2/10 секунд, фактически 1.66 секунды. Production build
и эти семь checks выполнены одним bounded проходом за 36.88 секунды; прежние
128 не повторялись. Peak 575393792 bytes, swap/OOM 0, cleanup подтверждён.
Manifest/команда/source pins/native evidence: `.tmp/incident-mcp-retry-release/`.
Включён опубликованный Root `origin/main` 7b0f388; main/deploy остаются Root.

## Legacy Notice opaque result ref: consumer compatibility

HTTP completion теперь проверяет `result_ref` как ровно 36 символов hex/hyphens
формата 8-4-4-4-12, без интерпретации UUID version/variant. Исторический Notice
selection ref с variant F передаётся без изменения через прежний atomic core.
`request_id` использует прежнюю строгую UUID проверку; event/version/status,
kind и наличие request проверяются до admission. Canonical stored ref сохраняется
при повторе с другим RFC ref; неизвестный native admission не replay.

Focused integration: `human-request-opaque-result-ref` и существующий
`human-request-completion-admission`, 6/6 PASS (ожидаемые/максимальные checks
4/10 секунд, фактически 3.32). Production build + checks за 37.813 секунды,
existing bounded runner; peak 612012032 bytes, swap/OOM 0, native cleanup PASS.
Evidence: `.tmp/incident-opaque-ref-release/`. RED для legacy HTTP400 сохранён.
128 baseline checks не повторялись. Существующая live question/outbox не читалась
и не изменялась; её definitive-400 reconciliation и runtime rollout выполняет Root.

После совместимого merge актуального `origin/main` 72057b9 выполнены build и те
же 6 focused checks: PASS за 33.548 секунды, peak 570949632 bytes, swap/OOM 0,
cleanup PASS. Финальный manifest и source pins:
`.tmp/incident-opaque-ref-main-release/`. Собственный diff к main ограничен
validator, новым coupled regression и этим handoff; изменения Root сохранены.

## Codex human callback: native admission before LLM completion

`resumeSelectedTarget` использует существующий native queue ACK для Codex и
ZCode. Для уже running Codex задаётся steer; native adapter проверяет текущий
expectedTurnId. Exact inputId, original humanRequestedAt, cwd verification и
stop fences сохранены. Callback не ждёт LLM completion и не подтверждает
resumed до настоящего RPC ACK. Никакого нового transport или resolver.

Новая focused integration `human-request-codex-admission`: real HTTP -> registry
-> supervisor -> production Codex adapter -> isolated Unix WebSocket peer.
Модельный turn остаётся running после ACK; callback завершается <1.5 секунды.
Проверены idle/active, duplicate до и после ACK с одним native вызовом,
exact expectedTurnId, incomplete turn receipt без replay и newer human stop.
RED: idle callback timeout и отсутствие active steer; evidence сохранён
в `.tmp/incident-codex-admission-red3/`. Fixture path-limit failure отдельно
сохранён в red/red2, не считается consumer RED.

Production build + четыре новых checks + пять existing resume fences: 9/9 PASS
на merge origin/main cf6a890, release command 39.085 секунды, с case setup и
runner cleanup 45.510 секунды. Категория focused integration, expected/max tests 5/10 секунд,
фактически 5.22. Existing bounded runner CPU1/max2GiB/tasks128, pools <=2;
peak 562274304 bytes, swap/OOM 0, native cleanup PASS. Scoped review PASS:
production diff только options существующего resumeSelectedTarget; pins без
изменений. Manifest, result и log: `.tmp/incident-codex-admission-release/`.
128 baseline checks повторно не запускались.

Cheap read-only inspection AgentResumeClient: OpenCode/Claude entrypoint
запускает detached CLI, Hermes wake вызывает finite gateway admission;
ожидание полного LLM turn в этих inspected seams не подтверждено. Ничего
вне owned worktree не изменено. Runtime100 build/restart/deploy только Root;
его canonical image/autocontinue/ZCode/UI WIP не тронут. Исходный Detailed
request уже admitted: transport/reconcile/stop/interrupt не вызывались;
query-only settlement и настоящий live consumer acceptance остаются Root.

## Original Notice incident and actual execution identity (2026-10-12)

Confirmed consumer defect: OpenCode completion was emitted as a new generic
Hermes-scoped notification. Generic done/human/choice messages now carry actual
harness, native session ID, execution model when the native receipt supplies it,
cwd and exact session URL. Human-readable result/question leads; execution
metadata follows. OpenCode model comes from assistant info.providerID/modelID,
never the judge model or producer project. Unconfirmed model is explicit.

Coupled contract with Notice owner: existing PUT /api/autopilot/sessions/{harness}/{nativeId}
accepts noticeIncident:{incidentId,project} from the receipt-authoritative arm.
It is stored in sessions.json and retained on ordinary on/off. Existing bound
identity/cwd cannot be replaced. No token/file path is copied into the context.
Runner and Stop-hook read this same binding; mismatched cwd does not fall back
to a generic notification.

Bound continue/done observations use POST /v1/incidents/{originalId}/health/progress:
plan_id repair, bounded Russian step, actual native session URL evidence ref,
stable fingerprint and Idempotency-Key, actor agent-herder. This is observation,
not verification/resolve. Credentials come only from the existing protected
GPTADMIN_HEALTH_CALLBACK_FILE (default ~/.config/gptadmin/health-callback.json):
url + tokens[originalProject], legacy token only when the map is absent. Missing
original project refuses delivery without widening scope or Hermes fallback.

Receipt pendingIncidentUpdate is checkpointed before callback. The existing
finite completion sweeper retries that exact original update and pendingQuestion,
including process restart/caller failure. Confirmed delivery clears only the
matching field from the latest locked receipt snapshot. No new scheduler, registry,
transport or token store. Unknown native admission remains non-replayable.
Bound human/choice decisions use one existing HumanRequest + /v1/human-requests
with original incident_id/project and actual native_target; choice buttons retain
opaque values/labels and answer via canonical Notice resultRef. These bound
questions wait for the canonical answer; the legacy unbound ChoiceRegistry timeout
path remains unchanged. Legacy terminal hooks remain terminal; pending legacy
notices can migrate with explicit trusted incident context without another judge.

Final tested Herder source: 8e78ce8863b0f25a313df4cb76a6a4ab2504bd85, includes
accepted origin/main a2ae53d51d09a13fd307193df03d00846bcfe18e and compatible
foreign image/queue/ZCode/UI changes. Notice peer source frozen at
2c54bd89458fccfefeedce90c5447d93b57fd976. Scoped self-review PASS; source pins
unchanged after tests. Fourteen owned source/test files; canonical WIP untouched.

Final ordinary release: build + eight selected files, 58/58 PASS. Command 46.397s,
case setup through runner cleanup 51.985s (<180s). Existing CPU1/max2GiB/tasks128
budget, one Vitest worker, finite pools <=2; peak 581783552 bytes, swap/OOM 0,
cleanup PASS. Fast unit: core/state/runner/direct question contracts (expected/max
5/15s); focused integration: real arm HTTP, native model, persisted outbox and
actual Notice HTTP/DB/card handler + existing Codex admission fences (5/15s).
No slow nightly or the earlier 128 baseline checks rerun. Evidence/manifest/log:
.tmp/incident-card-final/. Retained prior held/setup/build failures are not GREEN.

Coupled consumer proof uses isolated Notice DB and real HTTP/card handlers with
an in-memory Telegram network: exactly one original incident, one progress event
after lost ACK/retry/restart, one initial message42, subsequent completion and
question edits to that same message42. No real Telegram action, incident, model
probe, call, conntrack repair/restart/cleanup or deployment was performed. Root
owns final main/runtime/actual Debug Telegram and phone acceptance. Original
admitted Detailed/request/ref/outbox remains untouched.

## Review blocker: UI reset retains original Notice binding

DELETE /api/autopilot/sessions now resets only enabled override on a bound
session. The same sessions.json row retains native harness/ID/cwd and immutable
noticeIncident; enabled is absent and policy inheritance is real. Legacy unbound
rows still delete. Parser accepts binding-only rows, while metadata-only rows
without a valid incident remain invalid. GET/runner status report policy, not
session override; DELETE uses retained cwd for Codex allowlist selection. The
semantic launcher also inherits policy when enabled is absent. PUT on/off remains
explicit and preserves binding. No UI workaround or new registry.

Focused integration RED/GREEN: real bind PUT -> DELETE -> fresh state read ->
production runner Stop for OpenCode and Codex allowlist. Old source loses binding
(OpenCode null row) and cwd (Codex reports inherited false). GREEN retains original
incident, removes stale disabled override, publishes exactly one original progress,
repeated Stop has one judge/receipt, generic notify.send==0. Repeated DELETE is
idempotent; a later global disable is inherited and stops judgement/delivery.
Category focused integration; expected/max 2/10s. Historical initial fixture schema
error and the real RED are retained separately; neither is claimed GREEN.

Latest published origin/main 20969f1042fc0e6ba2be4d73e1f84fd988ced29c merged into
clean owned tree before the final run (includes published review changes beyond
836344e). Canonical uncommitted ZCode source/tests were never touched. Final tested
source 23c2fe469c9b917a67b77c0895bcef62c958155a. Scoped self-review PASS: four
production files plus one regression; prior progress/outbox and native fences unchanged.

Build + five selected files, 14/14 PASS: new reset2, legacy state2/http3/runner6,
existing coupled Notice1. Notice peer stays frozen2c54bd8; one original message/card
proof passed. Fast unit and focused integration expected/max combined 6/15s; actual
tests6.73s. Command39.400s, setup-through-cleanup44.859s. All executed RED/setup/
GREEN/release checks in this fix including setup79.050s (<180s). Existing CPU1/
max2GiB/tasks128, one test worker/pools<=2; peak593915904 bytes, swap/OOM0, cleanup
PASS, source pins unchanged. No broad128/58 rerun, nightly, restart or deployment.
Manifest/hash/command/native result/log: .tmp/incident-reset-release/. Root integrates
this ready branch with paired Notice2c54 and owns runtime/live consumer acceptance.
