# Обнаруженные дефекты

## 2026-11-16 — wrapper session_info не повторяет прямой MCP readback

- **Симптом:** подключённый wrapper-вызов mcp__agent_herder__session_info для существующей OpenCode-сессии ses_eac7ce778ffeFIOQrMsi8BFRzl возвращает fleet_session_native_not_ready.
- **Воспроизведение:** вызвать wrapper с sessionId, harness=opencode, hostId=roomhacker-server-100, view=compact или view=messages.
- **Фактический результат:** тот же запрос через обычный Streamable HTTP MCP-клиент к установленному 127.0.0.1:18787/mcp успешно возвращает session.id с exact ses_; поиск по этому идентификатору также возвращает ту же сессию.
- **Контекст:** live Herder и installed artifact работают; проблема относится к wrapper-маршруту/его native-readiness preflight. До отдельного исправления не использовать ошибку wrapper как доказательство отсутствия сессии.
