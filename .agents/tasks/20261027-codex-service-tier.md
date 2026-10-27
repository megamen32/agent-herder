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
