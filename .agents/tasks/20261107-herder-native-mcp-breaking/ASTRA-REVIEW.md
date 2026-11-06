# Решения независимого ревью для v1

Нулевая ревизия, 7 ноября 2026. Владелец после ревью ограничил первый выпуск Codex, OpenCode, ZCode, ChatGPT и Z.ai и разрешил убрать историю из рабочего графа. Действуют SPEC/WORKPLAN; [полная критика прежнего плана](history/astra-review-before-v1-zero/ASTRA-REVIEW.md) сохранена для сравнения.

1. **Rust оставить условным baseline.** MCP 2026-07-28 и rmcp 3.9.0 подтверждены официально. Ранний compile/wire/реальный client gate предшествует основной реализации. Отсутствие extensions в Go не доказано ограниченным поиском — этот аргумент не используется как факт.
2. **Durable Tasks реализовать одним backend.** Штатный TaskManager rmcp держит HashMap; он не заменяет restart-safe SQLite. Отдельные условия для input, cancellation, unknown outcome и receipt retention. Нет публичного собственного jobs API.
3. **Сократить каталог до 14 инструментов.** Модели входят в discovery, заметки — workspace, cron/autopilot используют один admission executor. Нет implicit create в deliver, второго delayed-send scheduler и собственного workflow DAG.
4. **Адаптеры — чистые решения и небольшие соединения.** Parse/normalize/reduce/dispatch decisions тестируются без I/O. State остаётся у process/socket/profile; маленькие ports/traits отделяют эффект. Полностью функциональный framework не нужен.
5. **Упростить ownership.** Один atomic owner JSON + стабильный lock; CLI и MCP используют одну библиотеку. Реальный release сериализуется на одном target runner, который проверяет owner после lock и сохраняет receipt до эффекта. UNKNOWN не повторяется. Нет двухфазного owner/state файлового протокола.
6. **Не считать чтение контекста доставкой модели.** Creator/native parent/sender хранятся отдельно; reply_to разрешает адрес сервером. Native hooks и context generations проверяются отдельно для каждой из пяти сред.
7. **Не прятать неизвестность в часовых задачах.** У каждого native adapter сначала gate с точным API/версией; unsupported не success. В графе есть явные estimate_unknown_reason. Часовой максимум относится к исполнимому slice, не к неограниченному поиску отсутствующего API.
8. **Сохранить полный delivery.** Отдельные importer/rollback/native candidate lanes, реальные consumers, четыре platform artifacts, установка Linux/macOS и две независимые приёмки. Личному телефону не звонить; test-only messaging.

Нулевой граф содержит только 159 V-листьев, все queued/unassigned. Старые R/A/L/M листья и прежняя история revisions находятся в архиве, не в контексте исполнителей. Остальные среды перечислены в NEXT-UPDATE.md без активных задач.
