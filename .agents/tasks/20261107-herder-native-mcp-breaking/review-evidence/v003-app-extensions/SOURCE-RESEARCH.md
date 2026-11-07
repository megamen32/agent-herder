# V003: source Codex и Hub, 7 ноября 2026

Исследован официальный Codex tag rust-v0.167.0 (commit 086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a). Один ключевой файл сверён по SHA-256 с официальным commit; весь исходный архив таким способом не проверен.

- Формирование per-request client capabilities: codex-rs/codex-mcp/src/client_capabilities.rs:53 и rmcp_client.rs:1351. Фильтр пропускает известные extensions elicitation и MCP App UI; пути включения Tasks и Skills в этом месте не найдено.
- Dispatcher app-server: codex-rs/app-server/src/message_processor.rs:1606 и 1793; catalog_processor.rs:527 обрабатывает локальные/plugin skills, а mcp_processor.rs:655 предоставляет MCP resources/read. Это не подтверждает MCP skills/list и skills/get.
- mcp_event_stream.rs:47 ограничивает проверенный event-stream hosted Apps, а rmcp_client.rs:1250 использует events/stream, не subscriptions/listen.
- SDK rmcp в Cargo.lock (3.5.1, commit 98a54789...) содержит типы и client helpers Tasks/listen. Наличие методов SDK не является подтверждением, что их предоставляет app-server конечному потребителю.
- Hub/ShellMCP: исследованный исходный код git commit 00699117... содержит пустые client capabilities для child MCP и ограниченный набор resources/prompts в child mcp_request; собственные Tasks Hub отдельно. Установленный бинарник не прочитан, соответствие содержимого текущему runtime не подтверждено.

Реальный isolated probe app-server 0.167.0: протокол 2026-07-28 согласован; серверные Tasks/Skills видны, клиент не объявил Tasks; вызов отклонён -32021 до создания задачи (счётчик 0). resources/read прошёл, discovery Skills и subscriptions не установлены. Это результаты конкретной конфигурации, не доказательство отсутствия всех иных режимов. Доказательства — RESULT.md и PID-specific wire trace в этом каталоге. V003 не пройден.

Ссылки: https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/codex-mcp/src/client_capabilities.rs#L53 ; https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/codex-mcp/src/rmcp_client.rs#L1351 ; https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server/src/message_processor.rs#L1606 .
