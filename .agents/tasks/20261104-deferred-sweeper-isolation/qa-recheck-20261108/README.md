# Проверка deferred sweeper, 08.11.2026

Карточка: c8f7d92b-aa00-48be-9220-acd165cc9eaf.
Существующий план: 20261104-deferred-sweeper-isolation, L01.
Проверял dot, /root/advance_1105_board. Это независимая QA-проверка, не новый исполнитель разработки.

## Новый подтверждённый результат

- Исправление 19c2b3b60b17e36ce3a3970c44de5193d242dc53 присутствует в ancestry текущего source e9d56ed31f0b5a4b2aeba34eb62e8d9dae744962.
- Реальный Vitest для tests/deferred-delivery-sweeper.test.ts: 11/11 PASS, exit 0. Исходник и тест не изменены.
- agent-herder active/running, PID 4151979. Прочитан entrypoint действующего процесса: /home/roomhacker/agents-projects/.fleet-candidate/releases/3b2cf4d64df8043993847947e160dd75d99ed471/dist/index.js.
- Установленный deferred-delivery-sweeper.js содержит prefilter неподходящих записей и ключ JSON.stringify([harness, sessionId]). SHA256 7f8964169473201a1ce171867e9de23a5489b6754dc5697c1fff8e55c14f10ec.
- Установленный JS выполнен с отдельным временным store и fake adapters: 9/9 PASS. Сценарии: legacy first/last, одинаковые ID разных harness, бюджет, definite rejection retention, accepted/UNKNOWN no-replay, running/needs_input hold.
- Реальных доставок, новых сессий и изменений runtime: 0. Два исторических deferred record не читались и не менялись.

## Границы приёмки

Это не полная suite/build, не пользовательская runtime end-to-end приёмка и не основание закрыть общую карточку Herder. Старый статус L01 blocked после rollback 04.11 сохранён: запись требует сверки существующим release owner с фактически установленной более поздней версией. Новая сборка или повтор старого rollout не нужны только для уже установленного исправления. Точная revision установленного bundle установлена по пути процесса; git ancestry release SHA отдельно не проверялась.

Прямой coordination_note list/create/update работает в текущем проходе; запись ownership eddd478c-0e77-46ec-8b4a-2f22ba381192 относится только к этому каталогу evidence. Это не runtime-приёмка file reservations. MCP не передал caller-session identity; чужая identity не подставлялась.

AgentMemory read-only recall получил forbidden. Отказ не повторялся и не обходился. Существующий план и source использованы как проверяемые источники.

## Следующий шаг

Существующий владелец реализации, записанный в L01: Codex 01a1a714-c361-7993-acf2-8c735d711ebc. Его текущая активность не подтверждена и сессия не запускалась. Release owner должен сопоставить поздний установленный релиз и L01, затем выполнить одну согласованную безопасную проверку координации/reservations в тестовом контексте. Оценка 20-40 минут после подтверждения владельца и тестовой identity; внешнее ожидание неизвестно.

Карточка остаётся открытой. Продуктовый код, публикация, деплой, permissions и авторитетное состояние LHC не менялись.
