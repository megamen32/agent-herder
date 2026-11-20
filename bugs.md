# Обнаруженные дефекты

## 2026-11-16 — wrapper session_info не повторяет прямой MCP readback

- **Симптом:** подключённый wrapper-вызов mcp__agent_herder__session_info для существующей OpenCode-сессии ses_eac7ce778ffeFIOQrMsi8BFRzl возвращает fleet_session_native_not_ready.
- **Воспроизведение:** вызвать wrapper с sessionId, harness=opencode, hostId=roomhacker-server-100, view=compact или view=messages.
- **Фактический результат:** тот же запрос через обычный Streamable HTTP MCP-клиент к установленному 127.0.0.1:18787/mcp успешно возвращает session.id с exact ses_; поиск по этому идентификатору также возвращает ту же сессию.
- **Контекст:** live Herder и installed artifact работают; проблема относится к wrapper-маршруту/его native-readiness preflight. До отдельного исправления не использовать ошибку wrapper как доказательство отсутствия сессии.

## 2026-11-20 — автономные Rust-фикстуры ChatGPT и Z.ai теряют контекст crate

На ревизии `ec29cc62` команды `cargo check --manifest-path acceptance/native/chatgpt/Cargo.toml` и `cargo check --manifest-path acceptance/native/z-ai/Cargo.toml` завершаются с `too many leading super keywords`. Оба манифеста используют модуль адаптера как корень отдельной библиотеки, хотя модуль импортирует `super::cdp` и зависимости основного crate. Сбой воспроизведён на исходной ревизии при проверке браузерных адаптеров. Их модульные тесты доступны через `cargo test --manifest-path crates/herder/Cargo.toml --lib`.

## 2026-11-20 — периодический отказ запуска фикстуры Codex при параллельных тестах

При запуске `cargo test --locked --offline --manifest-path crates/herder/Cargo.toml -j 5` на Linux тест `adapters::codex::create::tests::invalid_key_is_definitely_not_sent_by_both_ports` однажды завершился с `ExecutableFileBusy (ETXTBSY)`. Сбой возник в `fake_create_control` в `crates/herder/src/adapters/codex/create.rs` при запуске только что записанного `fake-codex`, до проверки пустого ключа. На том же рабочем дереве тест проходил и раньше. Детерминированного воспроизведения пока нет.
