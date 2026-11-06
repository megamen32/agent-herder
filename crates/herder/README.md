# V001: минимальный MCP wire probe

Это локальный SDK gate новой реализации Agent Herder. Бинарник
`herder-wire-probe` обслуживает stdio через штатный `rmcp::ServerHandler` и
`ServiceExt::serve`; единственный инструмент `wire_probe` возвращает
`{"probe":"ok"}`. Адаптеров, хранилища и настоящих сессий здесь нет.

## Зафиксированная сборка

Проверено 7 ноября 2026 на `x86_64-unknown-linux-gnu`:

| Компонент | Фактическая версия / настройка |
| --- | --- |
| Rust | `1.96.1 (31fca3adb 2026-06-26)` |
| Cargo | `1.96.1 (356927216 2026-06-26)` |
| Toolchain | Корневой `rust-toolchain.toml`: `1.96.1`, профиль `minimal` |
| Edition | `2024` |
| rmcp | Ровно `3.9.0`, crates.io; SDK MSRV `1.88` |
| rmcp: явно включённые features | `server`, `transport-io`; `default-features = false` |
| rmcp: итоговые features | `schemars,server,transport-async-rw,transport-io,uuid` |
| serde_json | `1.0.154` |
| tokio | `1.54.1`; явно включены `macros`, `rt` |
| Wire revision | `2026-07-28` — единственная объявленная версия |

`Cargo.lock` лежит рядом с manifest и фиксирует транзитивные зависимости.
`rust-version` фиксирует проверенный минимальный baseline проекта `1.96.1`,
а не более низкий MSRV SDK. Существовавший `stable` уже содержал Rust/Cargo
1.96.1; для воспроизводимого числового pin rustup установил ту же 1.96.1
под именем версии. Старый toolchain не устанавливался.

## Воспроизведение

Из корня worktree, с Rustup и Python 3:

```sh
cargo build --locked --manifest-path crates/herder/Cargo.toml
python3 crates/herder/probes/wire_probe.py
```

Если `CARGO_TARGET_DIR` переопределён, передайте путь к бинарнику первым
аргументом Python-скрипта. Probe запускает только свой дочерний процесс,
отправляет два JSON-RPC запроса с metadata на каждом запросе, проверяет
ответы и завершение процесса. Timeout ответа/завершения — 10 секунд;
при ошибке дочерний процесс уничтожается. `initialize` не отправляется.

Результат выполненного probe:

- `server/discover`: `resultType: "complete"`,
  `supportedVersions: ["2026-07-28"]`, `capabilities: {"tools": {}}`,
  metadata `serverInfo.name: "herder-wire-probe"`.
- `tools/call` с `name: "wire_probe"`, `arguments: {}`:
  `resultType: "complete"`, `structuredContent: {"probe":"ok"}`,
  `isError: false`.
- Итог: `{"status":"PASS","transport":"stdio","protocol":"2026-07-28","requests":2,"server_exit":0}`.

`resultType` создаётся SDK; ни сервер, ни клиент не дописывают его в ответ.
Клиент использует стандартную библиотеку Python и проверяет фактические
JSON-строки из stdout отдельного Rust-процесса, без общего SDK декодера.

Локальные квитанции запуска находятся в `.tmp/v001/` в корне worktree:
`build-locked.log`, `versions-features.log`, `wire-probe.jsonl`.
Первая попытка сборки (`build.log`) выявила неверное использование
отсутствующего `ListToolsResult::with_tools`; исправлено присваиванием
публичного поля `tools`, после чего locked build и wire probe прошли.

## Граница результата

Доказаны сборка зафиксированных зависимостей и два успешных stdio запроса
через rmcp 3.9.0. Не доказаны HTTP/auth, native клиенты Codex/OpenCode/ZCode/
ChatGPT/Z.ai, Tasks/Skills/subscriptions/MRTR, durability, адаптеры,
production runtime, macOS и arm64. Дополнительные suites не запускались.
