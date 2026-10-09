# Herder: exact Codex discovery/delivery

Владелец: Codex 01a12176-7266-7071-9e9f-82b1becf5db8. Координатор: 01a12170.
Разрешены только codex.ts, codex-app-server.ts, named-session.ts, новый тест и этот файл. Без git mutations, deploy/restart.

Подтверждено: `findNamedSessions` одновременно с exact SQLite вызывает full paginated `thread/list`; `getSession` вызывает raw `getSession` -> global `listSessions` -> full rollout metrics; automation metadata тоже использует global state cache.

RED выполнен Root штатным focused helper: `worker-red-case.json`, `attempt-96e06341c28ddcb57a908cf82f6e18e5.json`, `run-temp/bounded-jr9_2pca/focused.log` под `.tmp/coordination-repair-20261009`. 5 selected, 4 failed / 1 passed, duration 1.82s, tests 614ms. Ошибки ровно global thread/list и global rollout scan; explicit metrics прошёл. Helper exit1; cleanup_enforced_by_existing_helper=true.

Source fix готов для GREEN (9 selected cases):

- `codex.ts`: `getSessionObservation(id)` exact SQLite + fresh bounded rollout tail, без global states/list/metrics. Старый формат без SQLite смотрит filenames exact ID и только его header/tail. `getNativeAutomationMetadata` использует эту точную observation. Явный raw `getSession` сохраняет полную статистику.
- `codex-app-server.ts`: exact native name lookup сначала; usable empty index не запускает thread/list. Найденные IDs проверяются native thread/read; ошибка не становится пустым результатом/новой сессией. Exact getSession для socket/stdio вызывает thread/read + turns/list, не global list; fresh stop метаданные берёт за одно чтение exact tail. `getSession(id, {includeMetrics:true})` сохраняет явную полную статистику. Native read failure имеет `nativeStateObserved:false`; admission отказывает до мутации. Persisted task_started не заменяет live status; stale active turn сбрасывается перед fresh observation.
- `named-session.ts`: прежняя защита reuse при eventual provider discovery сохранена; попытка bypass native cache отозвана после discriminating old regression (two creations). Итогового source diff этого файла нет.
- Тест: 9 быстрых unit cases (expected <1s pure cases, ceiling5s each), дополнены verified-empty-index, persisted-vs-live-status, native read failure admission и unreadable named thread no-replacement regressions.

Root: запусти один GREEN через existing focused helper: новый тест (9 cases) + `tests/codex-app-server.test.ts`, `tests/codex-adapter.test.ts`, `tests/named-session.test.ts`, `tests/deliver-named-session.test.ts` если эти direct suites присутствуют; существующие timeout/no-replay tests обязательно входят. Нет разрешения worker самостоятельно запускать full/build/deploy; Root pins/tests mutable owned source перед запуском. Source изменения закончены; этот файл можно читать как handoff, actual GREEN evidence ещё требуется.

Root-cause map для повторения (запись только в owned task, не чужой code-map): admission `CodexAppServerAdapter.getSession` -> raw `CodexAdapter.getSession` -> global `listSessions` + full metrics; named exact lookup параллельно с pagination скрывал задержку. Discriminating probe: новый тест запрещает global RPC/list/state scan/metrics. Do not claim live recovery from these source tests. Consumer/deploy acceptance остаются у Root.

## GREEN и read-only consumer review

Root GREEN через existing helper: `.tmp/coordination-repair-20261009/green-case-2.json`, `attempt-d54549d8d74d4ce9d57e62f668342def.json`, `run-temp/bounded-f3owvec6/focused.log`, `result-d54549d8d74d4ce9d57e62f668342def.json`. 20/20 PASS, мои 9/9, duration4.92s. Native peak141815808B, swap0, OOM0, helper_exit0, same_generation_cleanup=true. Root запускает direct regression suites/backend build/integration. `git diff --check` owned src PASS. Source frozen после этого результата; git/deploy/restart не выполнялись.

Конкретный consumer gap (вне ownership worker; передан Root через Herder stable inputId `herder-worker-explicit-stats-finding-20261009`):

- `src/session-supervisor.ts:678` full `getSessionDetails(!quick)` -> ordinary `getSession` -> lightweight native observation. `src/web-ui/main.tsx:927/1528` использует details.session и показывает messageCount/duration/tokens/cost; эти поля без explicit metrics исчезнут.
- `src/mcp-tools/handlers.ts:357` `handleAgentInfo` -> findSession -> ordinary getSession -> formatSession(verbose=true); та же потеря чисел.
- Deep activity `/api/statistics/activity` -> `src/session-statistics.ts` отдельно читает native archive, не зависит от lightweight getSession и сохраняется.

Smallest next action у Root: применять `getSession(id,{includeMetrics:true})` только для explicit full detail/agent_info (через optional interface option либо narrow trait), оставив quick/findSession/admission лёгкими. Менять эти unowned consumer files worker не уполномочен. Не считать новую optional method argument уже подключённой к UI. Новые source edits worker не выполняет без конкретной находки в owned delta.

## Дополнительные исправления после independent/old-regression review

Root сообщил 113 selected /106PASS/7FAIL в `run-temp/bounded-ec1har8_/focused.log`. Собственная delta исправлена; source снова frozen, GREEN нового final source ещё нужен (новый тест теперь12 selected):

- P1 rollout move: ENOENT теперь re-read exact SQLite ID once и tail нового пути. Если нового пути нет или новый tail тоже недоступен, ошибка сохраняется; sendNativeMessage возвращает preflight failed/admitted:false до native mutation. Новые реальные file-move+manual-stop и missing-tail-no-mutation tests.
- CWD aliases: exact SQLite name query сравнивает canonical CWD только у совпавшего имени; native result тоже проверяет realpath. Так `/proc/<pid>/fd/...` или другой alias совпадает с normalized named identity без global thread/list. Новый test aliases, и existing zero-turn duplicate regression retained.
- Actual rollout writer: `/proc` inspection сверяет canonical session directory, а persisted status — canonical rollout path с physical FD target. Configured path и exported raw source.location остаются прежними. Иначе runner TMPDIR FD alias терял реального writer на list observation.
- Owned stdio turn/started receipt сохраняется при unsupported turns metadata; supported empty turns list по-прежнему сбрасывает active ID. Shared socket всегда reverify ID с очисткой старого. Exact native reads с отсутствующим name/cwd сохраняют только cached identity fields, не cached live status.
- Existing eventual reuse cache полностью сохранён. Нет итоговой delta named-session.ts.
- По расширенному Root полномочию изменён только `tests/fixtures/fake-codex-app-server.mjs`: fake thread/fork регистрирует возвращаемый thread для последующего thread/read, как native creation/fork. Assertions не ослаблены. `node --check` fixture и owned `git diff --check` PASS.

Дополнительная concrete delta finding исправлена: explicit includeMetrics раньше взял бы stop из cached full statistics state (regression к original fresh getNativeAutomationMetadata). Теперь exact fresh observation выполняется и для явной статистики, metrics добавляются отдельно; fresh stop не заменяется cached statistics. Новый тест проверяет fresh stopped turn при cached stats. Новый тест теперь13 selected.

Root владеет исправлением explicit stats seam, dist setup и слишком длинного Unix fixture socket. Эти пути worker не менял. Следующий шаг Root: repin final source/new13 + old direct regressions, GREEN/build, интеграция/live consumer. Предыдущее20GREEN больше не подтверждает изменённые final paths.

Новая граница shared file по direct Root message: методы `CodexAppServerAdapter.listSessions(options)` и `listAllThreads(optional bound)` теперь принадлежат Root для finite MCP first-page discovery (20, incomplete receipt), без изменения correctness full supervisor path. Worker эти методы не меняет; весь `codex-app-server.ts` не считать исключительно worker-owned в интеграции. Остальные worker source frozen.

Fresh final suites: `run-temp/bounded-jc9zu4wh/focused.log`, helper result-c31946a208c2a283c435e15619b67ef2.json. 155PASS/1FAIL из156 executed (38.00s), включая мои13PASS; отдельный Root test syntax parse failure. Единственный executed failure — raw source.location стал physical вместо configured alias из constructor normalization. Исправлено минимально: constructor сохраняет configured codexDir; canonicalization только в `/proc` sessionRoot comparison и persisted status comparison. Raw export path contract восстановлен без изменения assertion. Этот последний codex.ts fix требует proportional regression; остальные13 уже PASS final suites. Новый код не расширен. Source снова frozen.

## FINISHED — worker source + actual focused evidence

Final proportional GREEN Root: `.tmp/coordination-repair-20261009/attempt-f25853b587ebd072e33efaa81270552d.json`, `result-f25853b587ebd072e33efaa81270552d.json`, `run-temp/bounded-vhd6jslr/focused.log`. 18/18 SELECTED PASS (13/13 worker cases +5 affected source/handler checks), duration5.72s, tests2.59s. 34 other cases intentionally outside testNamePattern — не full52GREEN. Helper ordinary_selected_passed18, peak148987904B, swap0, OOM0, same_generation_cleanup=true. Live source pin readback всех четырёх worker paths совпал с fresh tested sources. Последний export-path regression исправлен и GREEN; raw archive contract/assertion не ослаблен. Ранее broad155 passes переиспользуются у Root по неизменным путям, не выдаются worker за полный новый green.

Finished files:

- `src/adapters/codex.ts` — exact lightweight metadata/stop observation, archive move retry-once/fail-before-admission, name/CWD exact SQLite discovery с canonical aliases, canonical FD matching без изменения exported paths.
- `src/adapters/codex-app-server.ts` — exact native read/turn observation, fresh stop даже при explicit stats, indexed named target verification без pagination, preflight failure до mutations, сохранение sparse native identity и verified owned-stdio receipts. Shared methods listSessions/listAllThreads принадлежат Root; их worker не правил.
- `tests/herder-discovery-delivery-latency.test.ts` —13 discriminating fast unit regressions, actual final all13PASS.
- `tests/fixtures/fake-codex-app-server.mjs` — только registration returned fork thread для последующего native read, отдельно разрешён Root.
- Этот task file — ownership, RED/GREEN/history, reproducible probes и точные pending owner actions.

`src/named-session.ts` восстановлен к исходному cache contract, итоговой worker delta нет. Все собственные проверки завершены; git mutations/deploy/restart не выполнялись, чужой WIP не тронут. Release integration, final rebuilt artifact и controlled live MCP discovery/delivery canary остаются у Root по явной границе ownership. Worker не заявляет runtime acceptance до этого consumer proof.
