# Точный статус и чтение существующей ZCode-сессии

Поручение: исправить Herder для `session_d609b412-12d2-44c0-999e-507aba8daba1`, не создавать сессии/агентов/worktree/ветки, сохранить чужой WIP. Исполнитель исходников: Codex `01a172ba-16c4-7cb2-8015-feef2150afb9`.

## Проверенный результат исходников

Причина: `ZcodeAdapter.getSession()` для official-running возвращал только materialized metadata: `running`, `needsPermission=false`, без модели. Реальный `readSession(existing-only)` того же official owner содержал pending permission. Fleet дополнительно запрещал чтение из-за lazy `isReady=false`, хотя официальный WebSocket позволяет присоединиться к существующему owner без запуска/возобновления сессии.

Минимальная правка: существующий official-owner read явно объявлен отдельной capability; точечный getSession читает native snapshot и secret-safe тип/инструмент/причину разрешения без аргументов; Fleet допускает только этот безопасный seam и возвращает статус/разрешение. Sleeping adapters без capability остаются заблокированы. Массовая discovery не получает чтение истории на каждую сессию.

RED: `npx vitest run tests/zcode-official-permission-read.test.ts --reporter=dot` — две исходные регрессии упали: ложный running вместо needs_input; fleet_session_native_not_ready.

GREEN: те же регрессии и fail-closed guard; focused набор `tests/zcode-official-permission-read.test.ts tests/zcode-official-running.test.ts tests/fleet-minimax-read.test.ts` — 6 passed, 1 skipped до добавления отдельного opt-in live probe. `npx tsc --noEmit --pretty false` — exit 0. Без полного suite.

Live source probe: `ZCODE_PERMISSION_READ_PROBE=1 npx vitest run tests/zcode-official-permission-read.test.ts --reporter=dot` — 4 passed, 25.10.2026 14:14 МСК. Read-only attach к тому же runtime; получены `needs_input`, точная модель `account:zai-individual-coding-plan/GLM-5.3-Flash$high` и новый pending `perm_67c91186-223f-4ff5-af8b-02266750504b`. Это проверка исправленного исходника на живом native runtime, НЕ установленного Herder.

## Native identity и разрешения

Сервер: roomhacker-server-100, официальный supervisor PID 1199550, native runtime PID 1199736, generation 1. Workspace `/home/roomhacker/PycharmProjects/account-broker`. Active turn `turn_0b8e8655-dc50-4354-9a65-261189bef48c`. Местный desktop unit `zcode-server100-local.service` inactive; привязка к GUI пользователя не доказана. Не выдавать этот headless runtime за его текущую локальную GUI-вкладку.

Первый запрос `perm_3450437d-ebff-44f8-87aa-c6c0c0be34ec` был реальным: high-risk `ctx_execute` с shell-чтением AFC диагностических файлов; `cat observe_final.py`, а не запуск Python. Первые cat/head не маскировали вывод. Сам исполнитель запрос не разрешал/отклонял.

Broker Lead сообщил прямое однократное разрешение человека, затем единственную принятую отправку P0 `broker-p0-stable-after-user-single-permission-20261025`. Повтор запрещён. После этого native eventSeq вырос с 789 до 857 и появился НОВЫЙ pending `perm_67c91186-223f-4ff5-af8b-02266750504b`; старое однократное разрешение его не покрывает. Содержательный P0 ACK пока не доказан. readSessionEvents/readSessionMessages для некоторых окон дают native output-schema errors; это явное ограничение native API, а не доказательство отсутствия событий/истории.

## Доставка и оставшаяся проверка

В начале installed Herder был 8dde6bcb; независимая внешняя выкладка в 14:06 МСК сменила его на ccb7722c408b6b33bfbfa25f01840bf3ea5e14b1, PID 1403720. Эти версии исправление не содержат. Наш canonical main d9c622c отстаёт от origin/main на 211 путей и содержит чужой WIP, в том числе пересекающийся с удалённой историей; чужие байты/индекс не менялись. Штатный builder нового SHA создаёт worktree; в этой сессии он запрещён и не запускался.

Позднее назначен единственный интегратор/исполнитель выпуска `01a172c2-3daf-7190-82ef-639dea9dc8d2`; его сообщение `90878418` прочитано полностью. Ему отдельно разрешён worktree от актуального origin/main; наше разрешение не расширяется. Ему передаётся scoped commit для интеграции, одного выпуска и installed MCP/UI приёмки. Самостоятельной второй выкладки не будет. Исходный inputId его steer в тексте сообщения отсутствует, поэтому факт read_message доказан, transport inputId не выдуман.

Следующий шаг: интегратор переносит только scoped commit в актуальный main, публикует и штатно устанавливает; проверяет agent_info/fleet_session_view той же exact session и показывает реальный permission в UI. Accepted P0 не повторять, pending не approve/deny за человека. До installed readback продуктовый результат не объявлять завершённым.
