# list_agents: восстановление клиентского контракта

Владелец: Codex 01a11b43-e944-7663-9ce8-d75df67c1167.
Статус: текущий сервер и GPTAdmin child проверены; исходный сбойный клиент ещё не установлен. Инцидент не объявлен исправленным.

## Проверенные факты

- Сообщение об inc_d982d2b1 пришло без проверенной сессии отправителя. В текущей базе Notice Place запись с таким ID отсутствует (точный read-only lookup).
- На HTTP MCP `http://127.0.0.1:18787/mcp`, PID 2712488, `list_agents` проходит для all/codex/zcode/opencode, limit=1. Текущая tools/list и structuredContent содержат ровно шесть полей: complete, unavailable, sessions, total, limited, filters.
- Зарегистрированный GPTAdmin child `mcp:shell:roomhacker-server-100:AgentHerder` публикует ту же схему; фактический execute list_agents(codex, limit=1) завершён успешно, job 052251f3d29e9f6e2fd58589bc0ba269.
- MCP client SDK v2 формирует приведённый -32602 при локальной валидации ответа в Client.callTool. На том же живом сервере старая toolDefinition без complete/unavailable даёт точное сообщение с двумя additional properties; после получения текущей схемы вызов проходит. Это доказательство несовместимости legacy-схемы, а не доказательство состояния неизвестного исходного клиента.
- Серверная схема уже содержит оба поля в src/mcp/session-tools.ts; удалять сведения о неполном discovery нельзя. Пересборок, рестартов, SDK updates и изменений адаптеров не выполнялось.

## Восстановление и оставшаяся приёмка

1. Установить исходный клиент, его MCP-адрес и фактически используемую outputSchema. Владельцу GPTAdmin 55 передан результат через registered active steer, admitted=true; стабильный inputId herder-list-schema-consumer-owner55-20261011-1. Повторять эту отправку не нужно.
2. Для установленного SDK v2 обновить tools/list на существующем клиенте: `await client.listTools(undefined, {cacheMode: "refresh"})`. Если вызывающий код явно передаёт toolDefinition, заменить именно её опубликованным определением. `bypass` не обновляет индекс валидаторов. Не повторять побочные действия; list_agents является чтением.
3. Проверить исходный зарегистрированный вызов с прежними параметрами. Только его PASS закрывает consumer acceptance. Общий рестарт клиентов/чатов и произвольный wrapper не нужны.

## Доказательства

Сохранены в ignored `.tmp/herder-list-agents-contract-20261011/`: live-probe.json, schema-refresh-proof.json, owner-info.json, owner-delivery.json. stale-schema-discriminating-probe.json — ранняя ошибочная диагностическая попытка с третьим аргументом callTool; сохранена как история и не является PASS/RED. В установленном SDK v2 callTool принимает `(params, options)`.

Категория проверки: focused integration, read-only текущий зарегистрированный MCP. Цель — отделить серверный outputSchema mismatch от legacy клиентского определения; вызовы ограничены request timeout 10–15 секунд. Полезный следующий шаг — получить identity сбойного клиента и проверить его адресное обновление схемы, а не собирать правильный сервер заново.
