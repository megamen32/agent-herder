# V003: проверка extensions через app-server 0.167.0

Дата: 07.11.2026. Только изолированный stdio, без model turn, платных запросов, изменения пользовательской конфигурации, исходного кода и установленного runtime. Это не проверка Codex App UI и не полный V003 gate.

## Воспроизведение

Из корня `/home/roomhacker/.codex/worktrees/herder-v1-implementation/agent-herder`:

```sh
python3 .tmp/v003-ext/run.py > .tmp/v003-ext/run-output.txt 2>&1
```

Нужны имеющиеся бинарники `.tmp/v003-followup/codex-app-server-x86_64-unknown-linux-musl` (SHA-256 `94d8d5f26531a1846c5d943eef57d7ab80b1eef86b6edf5a3b4a78fb8bf063ee`) и `crates/herder/target/debug/v002_probe` (SHA-256 `b0c16b3872af234bd981dc4469a35871d04b6215b0ee48646db8657562a640a5`). Исходник V002: `crates/herder/src/bin/v002_probe.rs`; самостоятельная проверка V002 описана в `crates/herder/probes/v002-findings.md`. Код tap прозрачно пересылает байты и записывает отдельный transcript для каждого процесса. Driver создаёт изолированный HOME/CODEX_HOME, fixture-провайдера с недоступным localhost и только idle thread. Повторный запуск перезаписывает `app-transcript.jsonl` и `run-output.txt`, а MCP-файлы создаются с PID.

Конфигурация в `codex-home/config.toml`: `mcp_2026_07_28=true`, `mcp_tool_list_changed=true`, для stdio-сервера `CODEX_MCP_PROTOCOL_VERSION=2026-07-28`. Первый вариант без `mcp_tool_list_changed` сохранён как `app-default.jsonl`, MCP `mcp-transcript-2343521.jsonl` и `mcp-transcript-2343536.jsonl`. Финальный вариант: `app-transcript.jsonl`, MCP `mcp-transcript-2349647.jsonl` (thread, вызовы и чтение) и `mcp-transcript-2349661.jsonl` (отдельный status). Процессы имеют независимое состояние; не смешивать их счётчики.

Официальный feature-list API `experimentalFeature/list` вернул все страницы (`nextCursor=null`): оба вышеназванных флага включены, по умолчанию выключены; отдельного флага с именем MCP Tasks или MCP Skills в возвращённом перечне нет. Это не доказательство отсутствия альтернативных режимов. [Реестр флагов версии](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/features/src/lib.rs) описывает `mcp_tool_list_changed` как обработку обычных уведомлений списка инструментов, а `codex_apps_mcp_2026_07_28` — как флаг другого, host-owned Apps сервера. Последний не включался для данного stdio probe. [Протокол app-server версии](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server-protocol/src/protocol/common.rs) содержит `mcpServer/resource/read` и экспериментальный event-stream API; последний относится к потоку вызова инструмента и не выдан за MCP `subscriptions/listen`.

## Матрица

| Проверка | Результат и границы |
| --- | --- |
| Wire и negotiation | Реальный app-server отправил `server/discover` и `_meta` с `2026-07-28`; V002 объявил `extensions` Tasks/Skills, resources и tools; app-server status вернул эти server capabilities. Клиентские capabilities содержали elicitation и в thread-соединении experimental `codex/auth-change`, без Tasks/Skills. |
| Tasks: отрицательный вызов | `mcpServer/tool/call` для `probe_task` породил реальный MCP `tools/call`; V002 вернул `-32021 Missing required client capability` с требуемой Tasks capability. `probe_count` до и после в том же процессе: `created: 0`. Это конкретная проверка отказа, а не доказательство отсутствия Tasks во всех режимах. |
| Tasks: жизненный цикл | `tasks/get`, `update`, `cancel` через app-server не вызваны: в исследованном app-server API не установлен поддерживаемый путь таких запросов; task не создан. V002 сам по себе проверял их другим клиентом, что не является проверкой Codex. |
| Skills | Сервер объявил extension, app-server сохранил её в статусе. `skills/list` и `skills/get` в trace не появились; поддерживаемый MCP extension-вызов через исследованный app-server API не установлен. Нативный `skills/list` app-server не приравнивается к MCP `skills/list`. |
| Ресурс skill | `mcpServer/resource/read` с `skill://probe/SKILL.md` породил `resources/read` и вернул статический текст fixture. Это не подтверждает обнаружение/активацию Skills моделью. |
| subscriptions/listen | В обоих сценариях автоматический `subscriptions/listen` не наблюдался; тест фильтра, событий и восстановления клиентом не выполнен. Это не доказывает невозможность в других сценариях. |
| tools/list | V002 возвращает пустой список: его handlers для `probe_count` и `probe_task` доступны при прямом вызове app-server, но модельное discovery этих инструментов здесь не доказано. |

Предыдущий базовый успешный вызов V001, отдельно от этого теста: `.tmp/v003-followup/RESULT.md` и `mcp-transcript-2020791.jsonl`. Клиентские extensions, весь жизненный цикл, UI, Hub и production не подтверждены; V003 целиком не пройден.
