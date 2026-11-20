# Обнаруженные дефекты

## 2026-11-20 — запущенный планировщик расходится с манифестом релиза

- **Симптом.** У действующего `agent-herder.service` путь к `dist/index.js` в аргументах процесса отличается от пути в `AGENT_HERDER_TS_RUNTIME_MANIFEST`. Проверка парного релиза требует точного совпадения.
- **Воспроизведение.** Сравнить путь запуска из `/proc/<MainPID>/cmdline` с полями `root` и `entry` манифеста, указанного в окружении того же процесса.
- **Контекст.** Обнаружено при подготовке передачи восстановления нативному владельцу. Подключённый каталог GPTAdmin также вернул 502 при чтении схемы дочернего AgentHerder.

## 2026-11-20 — служебная ссылка Codex мешает обновить Git-репозиторий

- **Симптом.** `git fetch origin main` в основном checkout Agent Herder завершается с `fatal: bad object refs/codex/turn-diffs/captures/…/base`.
- **Воспроизведение.** Сравнить `git ls-remote --heads origin main` с `git fetch --no-tags origin main` в `/home/roomhacker/agents-projects/agent-herder`. Удалённый Git возвращает вершину ветки, а локальный fetch останавливается на ссылке снимка сессии.
- **Контекст.** Обнаружено при сверке исходников для автовосстановления Codex. Служебные ссылки относятся к общему checkout.

## 2026-11-16 — wrapper session_info не повторяет прямой MCP readback

- **Симптом:** подключённый wrapper-вызов mcp__agent_herder__session_info для существующей OpenCode-сессии ses_eac7ce778ffeFIOQrMsi8BFRzl возвращает fleet_session_native_not_ready.
- **Воспроизведение:** вызвать wrapper с sessionId, harness=opencode, hostId=roomhacker-server-100, view=compact или view=messages.
- **Фактический результат:** тот же запрос через обычный Streamable HTTP MCP-клиент к установленному 127.0.0.1:18787/mcp успешно возвращает session.id с exact ses_; поиск по этому идентификатору также возвращает ту же сессию.
- **Контекст:** live Herder и installed artifact работают; проблема относится к wrapper-маршруту/его native-readiness preflight. До отдельного исправления не использовать ошибку wrapper как доказательство отсутствия сессии.
