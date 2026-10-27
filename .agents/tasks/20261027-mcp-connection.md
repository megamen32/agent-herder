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
