# V003: изолированный app-server 0.167.0

7 ноября 2026. Первоначальный исследуемый потребитель выбран руководителем: Codex App / app-server. Hub проверяется отдельно.

Релиз: https://github.com/openai/codex/releases/tag/rust-v0.167.0 , файл codex-app-server-x86_64-unknown-linux-musl.tar.gz. SHA-256 архива b41e6c0e3432de25ff8bb405018de876e653dc0501f253a9268fbd19cf6636f0 совпал с digest GitHub release API. Бинарник сообщает codex-app-server 0.167.0. SHA-256 бинарника 94d8d5f26531a1846c5d943eef57d7ab80b1eef86b6edf5a3b4a78fb8bf063ee. Probe: существующий herder-wire-probe, SHA-256 47a3b8eb07224c9dd8813e7765c6050cd408d9a63eba2d3b48083be9f9e4b5c0.

Изолированный config: features.mcp_2026_07_28=true и env CODEX_MCP_PROTOCOL_VERSION=2026-07-28 для этого stdio MCP сервера. Официальный сценарий использует оба opt-in: https://github.com/openai/codex/blob/rust-v0.167.0/scripts/mcp_conformance/run_codex_compliance.py .

Сырой прямой обмен: mcp-transcript-2020791.jsonl — server/discover, tools/list, tools/call, ответ {"probe":"ok"}, isError=false. Отдельное соединение статуса: mcp-transcript-2020818.jsonl. App RPC: app-transcript.jsonl, результат mcpServer/tool/call и статус. tap.py побайтово пересылает stdio без преобразования содержимого. run.py управляет официальным app-server по JSON-RPC, модельный turn не создаёт. Провайдер задан на неиспользуемый localhost; нет ключей и модельных запросов.

На успешном соединении клиент указал protocolVersion 2026-07-28, elicitation form/url и experimental codex/auth-change. Поля extensions и capability Tasks не объявлены; это факт trace, а не доказательство невозможности во всех режимах. Сервер V001 объявляет только tools. Tasks, Skills, subscriptions и их жизненный цикл этим probe не проверены. Реальный UI Codex App, его текущая установленная версия, production Herder, Hub, HTTP и другие ОС не проверены. V003 целиком не пройден.

Начальная контрольная попытка без серверного opt-in: app-initial-no-server-optin.jsonl, mcp-initial-no-server-optin.jsonl; отправлен initialize 2025-06-18 и получен -32022. Промежуточный mcp-transcript.jsonl от другого запуска смешан из-за конкурентной записи двух процессов и не является доказательством; используйте файлы с PID. Глобальные установки, сервисы, пользовательские конфигурации и source не менялись.
