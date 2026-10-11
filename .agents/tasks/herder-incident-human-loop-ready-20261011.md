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
на merge origin/main cf6a890, release command 39.085 секунды, включая setup
менее 45 секунд. Категория focused integration, expected/max tests 5/10 секунд,
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
