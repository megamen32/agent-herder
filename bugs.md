# Обнаруженные дефекты

## 2026-11-16 — wrapper session_info не повторяет прямой MCP readback

- **Симптом:** подключённый wrapper-вызов mcp__agent_herder__session_info для существующей OpenCode-сессии ses_eac7ce778ffeFIOQrMsi8BFRzl возвращает fleet_session_native_not_ready.
- **Воспроизведение:** вызвать wrapper с sessionId, harness=opencode, hostId=roomhacker-server-100, view=compact или view=messages.
- **Фактический результат:** тот же запрос через обычный Streamable HTTP MCP-клиент к установленному 127.0.0.1:18787/mcp успешно возвращает session.id с exact ses_; поиск по этому идентификатору также возвращает ту же сессию.
- **Контекст:** live Herder и installed artifact работают; проблема относится к wrapper-маршруту/его native-readiness preflight. До отдельного исправления не использовать ошибку wrapper как доказательство отсутствия сессии.

## 2026-11-20 — незавершённая подготовка слота Broker удерживает окно выпуска

- После ошибки `pip check` в защищённом выпуске Account Broker контроллер оставил `occupancyState=unknown` и `reconcileRequired=true`. Кандидат green не запускался. Журнал переключения подтверждает, что текущий blue обслуживает запросы в состоянии `committed`.
- Это воспроизводится при ошибке подготовки до `switch` внутри `BrokerReleaseGuard`. После завершения процесса попытки закрыть ту же аренду контроллер отклоняет, пока нет подтверждения результата.
- После истечения аренды при свободной блокировке цели установленный Herder показал `stale_unknown`. Обычный `acquire` перенёс прежнюю запись в карантин и выдал новую аренду для выпуска Broker. Проверки перед продолжением описаны в [жизненном цикле выпуска](docs/canonical-release-cutover.md#effect-lifetime).
