# Режим Codex при создании сессии

## Результат и план

Новая сессия Codex получает Normal по умолчанию; явный аргумент
`serviceTier: "fast"` выбирает Fast. В форме создания Codex тот же выбор.
Параметр относится только к новой сессии, не меняет глобальную конфигурацию,
существующие сессии и их режимы доступа или reasoning effort.

1. Worker: проверить установленный app-server schema, провести аргумент от
   MCP/web/named create к native thread/start и сохранить его при дальнейших
   turn/resume, если контракт этого требует. Неподдерживаемые значения отказать.
2. Root: Normal/Fast в существующей форме создания, Normal при каждом открытии.
3. Root: проверка diff и TypeScript/build, scoped main push, immutable install;
   проверка опубликованного контракта и фактических native параметров без LLM.

Минимальный путь — одно поле в текущем create API; отдельный реестр или
глобальная настройка не нужны. Worker не трогает UI или deployment. Root не
трогает чужой index.ts L56. Tests/suite не добавляются и не запускаются по
developer instruction. Секреты не выводятся; чужой WIP сохраняется.

Официальное описание Fast: https://learn.chatgpt.com/docs/agent-configuration/speed.
Нативный wire contract проверяется на установленной версии Codex.

## Контракт

`create_session` и `new_or_resume`: необязательное `serviceTier`, значения
`normal` или `fast`; отсутствие означает Normal только для новой Codex-сессии.
В web API — то же поле у POST `/api/sessions` и `/api/sessions/new-or-resume`.
Для других harnesses явное поле отклоняется. В `new_or_resume` найденная
сессия сохраняет tier; аргумент не является переключателем существующей сессии.

Установленный `codex-cli 0.162.1` app-server schema принимает `serviceTier`
на `thread/start`; Normal передаётся явно как `default`, Fast как `fast`.
`turn/start` без `serviceTierForTurn` наследует настройку треда. Resume не
отправляет нового tier. Подтверждение native tier остаётся отдельным от
запрошенного: `requestedServiceTier`, `serviceTier`, `serviceTierMismatch`.
`priority` — официальный прежний alias Fast; он нормализуется в `fast`.

Плановая приёмка по developer ограничению: compiler/build, installed source
identity, read-only MCP schema и выбор в UI; новые тестовые сессии/turns и
suite не запускаются. Ускорение/списание квоты провайдером не объявляется
подтверждённым без соответствующей native/provider квитанции.

## Установка 27.10.2026

Source `48626f861e4565c6a8efda36a8dcc0f1d604759d` опубликован в main.
TypeScript/build/plugin/package прошли; новая форма и backend собраны из
одних закреплённых compiler inputs без чужого WIP. Immutable runtime100:
PID1843383, start21:31:49MSK, bundle SHA256
`8c6a1088a593543d126d4325730a348da1f0508eaf33c6c856ee3c55328b9169`.
Policy ETag `c4d46cbefd965e8eb4e21d1426355edd` и settings hash сохранены;
persisted event sequence23633729 → live23633749, рестартов после активации0.
Публичный static pin совпадает; infra commit496d43b3, rollback183303Z,
managed diff без расхождений. MCP tools/list после установки подтвердил
enum normal/fast у create_session, new_or_resume, fleet_create_session;
receipt `.tmp/codex-service-tier-20261027/contract.json`.

Установка ограничена Herder на server100. Другие runtime флота не обновлялись;
старый strict fleet_create_session отклонит новое поле без создания сессии.
Пользовательские Codex-сессии и глобальный config.toml не изменялись.
Запрошенный tier не объявляется подтверждением фактической скорости провайдера.

Независимая read-only UI приёмка worker ct27: новая Codex форма открывается
с Normal, выбор Fast работает; после отмены/повторного открытия снова Normal.
В OpenCode поле отсутствует. Создать не нажималось, собственный браузер закрыт.
Screenshots: `/tmp/ct27-newsession-fast-selected.png`,
`/tmp/ct27-newsession-default-reopen.png`, `/tmp/ct27-main-opencode-tier-hidden.png`.
Fleet selector отдельно не принят:100 был «Нужна проверка», выбор среды
отключён;44/88 доступны. Screenshot `/tmp/ct27-fleet-hosts-not-ready.png`.
Это наблюдение не засчитывается как успешное remote create.

Последующий root readback fleet с refresh подтвердил100/44/88ready; screenshot
наблюдение ct27 было временным, новая remote-сессия всё равно не создавалась.
Затем по отдельному owner-forwarded поручению gate release45fbd0b установлен
на100 PID2197008 start21:45:26MSK. Все четыре frontend файла побайтно совпадают
с принятым ct27 release48626f86; Normal/Fast и его QA receipts сохранены.
