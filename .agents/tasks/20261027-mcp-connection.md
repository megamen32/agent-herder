# Подключение к Agent Herder MCP

## Результат и план

Владелец открывает Настройки → Подключение MCP, видит постоянный публичный
адрес, создаёт bearer для своего клиента, копирует готовую конфигурацию и
может отозвать этот токен. Действующие MCP клиенты и static bearer сохраняются.

Минимальное решение: существующий /mcp transport плюс owner-only issuance API
и небольшой локальный hashed-token registry. Без отдельного MCP gateway,
смены model policy, существующих секретов и ротации глобального bearer.

1. Backend worker: client-token-store.ts, mcp-connection-api.ts,
   server.ts/fleet-wiring.ts — issue/list/revoke, owner+same-origin,
   random token once, hash-only persistence, existing MCP handler accepts it.
2. Root: settings/mcp-connection-section.tsx + settings-screen.tsx — URL,
   issuance/copy/config/revoke, no raw secret in logs/localStorage/ordinary DOM.
3. Root: relevant compiler/build, scoped main push, immutable install,
   exact /mcp nginx bearer route, runtime/source readback and consumer path.

Backend и UI параллельны; критический путь backend→build/install→browser/MCP.
Новый shared bearer не выдаётся и существующий не раскрывается. Токен получает
полные действующие owner MCP права — это ясно написано до выдачи. Реестр хранит
только digest+metadata, revoked token fails auth. Lost issuance response не
повторяется автоматически. Для QA — собственный локальный owner browser на
server100 по штатному loopback пути; public testlogin не подменяется владельцем.
Только initialize/tools-list/read-only MCP, без команд сессиям/LLM/уведомлений.
Suite/tests не добавляем и не запускаем по developer instruction; проверки —
compiler/build и реальный узкий потребительский путь. Чужой WIP сохраняем.

index.ts исключён: действующая L56 ownership53261bd2. Общий singleton registry
между web server и guard позволяет не пересекать этот файл/соседнюю работу.

## Установлено и принято 27.10.2026

Source `4c7c958d2d9e615a128601996f9e7584c1654b7d` опубликован в main.
Immutable runtime использует тот же SHA, PID959614, start20:55:52MSK;
bundle SHA256 `1a06dc05b02c20248f2d9b85bc537c392869c69423124eedbc4aba1985e56f15`.
Compiler/build/plugin/package checks прошли, suite не запускалась.
Policy ETag и Settings SHA сохранены; события продолжили запись без потери.
Public static pin совпадает с source; exact /mcp bearer route установлен
infra commit `acdb64cb`, rollback `20261027T175824Z`. Остальной UI сохраняет SSO.

Owner browser mc27: создан ровно один QA токен, значение скрыто password input;
обе copy кнопки показали подтверждение. Содержимое clipboard независимо не
подтверждено: browser read запрещён. Токен отозван кнопкой, список показал
«Отозван»; собственный браузер закрыт. Evidence: masked/revoked screenshots
`/tmp/mc27-token-created-masked.png`, `/tmp/mc27-token-revoked.png`.
Первый private browser bridge не смог прочитать собственную страницу и показал
about:blank; screenshot `/tmp/mc27-tokenlist-selector-miss.png`. Он удалён,
accepted issuance не повторялась. Это не засчитывается как MCP acceptance.

Отдельный native protocol canary с другой QA credential (секрет только в памяти):
публичный SDK initialize + tools/list без Cookie →200/200, 98 инструментов;
после собственного отзыва тот же bearer →401. tools/call не выполнялся.
Метаданные: `.tmp/mcp-connection-20261027/protocol-canary.json`;
credential ID `8222cf6f-c06d-424e-8294-0a7661fbed59`, revoked18:11:11Z.
Durable intent предотвращает повтор issuance при повторном запуске helper.
Никакие native сессии, модели, уведомления или чужие runtime не запускались.
