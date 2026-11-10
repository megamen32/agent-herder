# Координация Agent Herder: проверка 09.11.2026

Карточка: c8f7d92b-aa00-48be-9220-acd165cc9eaf. Доска: https://todo-board.airlock.bezrabotnyi.com/.
Продолжение существующего реестра 20261104-deferred-sweeper-isolation, без нового плана и изменения статуса LHC.
Исполнитель проверки: dot, /root/advance_1105_board.
Фактический старт сверки 11:04 UTC; тесты 11:06:34-11:06:41 и 11:07:54-11:07:55 UTC.

## Реально выполнено

1. На source c492b6b6d16b3bfff7532748bc03721c2f514b63 выполнены tests/coordination-notes.test.ts и tests/remote-workspaces.test.ts: 28/28 PASS, 2 файла, exit 0.
2. Read-only проверка процесса PID 1168864 установила entrypoint immutable release fd99743bcc1875879315ff508b551e5e722b63cc.
3. Compiled CoordinationNoteStore и workspace MCP handlers этого установленного релиза выполнены с отдельными временными store, fake hosts и in-memory MCP transport: 7/7 PASS.
4. Проверены: сохранение launch host при remote declare; конфликт reservations на рабочем хосте; независимость одинакового пути другого хоста; точный адрес владельца; release декларации; отказ wrong peer без сохранения; отказ несуществующего пути и undeclared activity.
5. В тестах реальных сетевых вызовов, запусков сессий и доставок сообщений 0. Состояние работающего сервиса, чужие сессии и существующие данные не менялись. ExManager QA и его расписания не запускались.

Это не live end-to-end приёмка существующей пользовательской сессии и не полный build/test gate. Реальные native owners/reservations внешнего клиента этими изолированными тестами не установлены. Общая карточка не объявляется завершённой.

## Доказательства

- source-vitest.log: SHA256 87c3ad607ed5c7aaa16f6c7513f42855158ad659c3470ad30314cbea2c02a829
- installed-check.mjs: SHA256 0d139e8e36b1ac9ac789f51b7e9b84d89bd5368a1c1efed656690d4a63d4d067
- installed-check.log: SHA256 b8bfb1f4a203c2abaf1999e53885419170021e6208842b55cf0b33c50bedf915
- установленный coordination-notes.js: SHA256 4b185b8db7c26c2fa548fd478ef99297937a184f89a685bb70288c957b5ce92a
- установленный mesh/workspace-tools.js: SHA256 f0582bd6d743111dfde970d5f1d2ac8ced7a0cb3c12ab880992429579a74303b

Все файлы evidence находятся здесь; sha256.json проверен повторным чтением.

## Исполнители и ограничения

Herder snapshot 11:04 UTC наблюдал не менее 5 активных сессий: Z.ai Rust/z.ai на server100, OpenCode winramp и сторож TVC/ATV на server100, Codex без названия на server100, Codex по Airlock на server44. Покрытие частичное, все пять без подтверждённого workspace. Этих исполнителей проверка не запускала и не переназначала. Активный владелец именно c8f7d92b не подтверждён.
Codex использовано 97%, остаток 3%. Новые Codex/Work сессии не создавались и не возобновлялись.

Полученные родителем 403 Todo list/read через GPTAdmin ro и 403 LHC web_fetch не повторялись и не обходились альтернативным чтением тех же данных. Поэтому актуальная версия карточки не читалась и карточка не изменялась. Подготовленный точный текст для неё находится в card-update-pending.txt. Центральный LHC не обновлён; локальный evidence добавлен без изменения авторитетных leaves.

## Следующий шаг

Через разрешённый доступ владельца прочитать текущую версию этой карточки, добавить подготовленный результат с optimistic-version check и связать evidence с прежним LHC листом. Затем одна безопасная native проверка с подтверждённой тестовой identity, без новых Codex/Work и чужих reservations. Перенос доказательств: 5-10 минут после доступного writer; native acceptance: 15-30 минут после согласованной identity. Срок снятия доступа неизвестен. Сборка, повторная реализация и rollout ради уже прошедших проверок не нужны.
