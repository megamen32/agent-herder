# Обнаруженные дефекты

## 2026-11-20 — запущенный планировщик расходится с манифестом релиза

- **Симптом.** У действующего `agent-herder.service` путь к `dist/index.js` в аргументах процесса отличается от пути в `AGENT_HERDER_TS_RUNTIME_MANIFEST`. Проверка парного релиза требует точного совпадения.
- **Воспроизведение.** Сравнить путь запуска из `/proc/<MainPID>/cmdline` с полями `root` и `entry` манифеста, указанного в окружении того же процесса.
- **Контекст.** Обнаружено при подготовке передачи восстановления нативному владельцу. Подключённый каталог GPTAdmin также вернул 502 при чтении схемы дочернего AgentHerder.

## 2026-11-20 — служебная ссылка Codex мешает обновить Git-репозиторий

- **Симптом.** `git fetch origin main` в основном checkout Agent Herder завершается с `fatal: bad object refs/codex/turn-diffs/captures/…/base`.
- **Воспроизведение.** Сравнить `git ls-remote --heads origin main` с `git fetch --no-tags origin main` в `/home/roomhacker/agents-projects/agent-herder`. Удалённый Git возвращает вершину ветки, а локальный fetch останавливается на ссылке снимка сессии.
- **Контекст.** Обнаружено при сверке исходников для автовосстановления Codex. Служебные ссылки относятся к общему checkout.

## 2026-11-20 — тестовый набор Agent Herder красный вне изменений лимита Codex

- **Симптом.** `npx vitest run --root . --config vitest.config.ts` в рабочем дереве `codex/native-autorecovery` падает во многих файлах, не связанных с лимитом Codex: `tests/planner-route-notice.test.ts` (5), `tests/codex-resume-receipt.test.ts` (9), `tests/autopilot-core.test.ts` (17), `tests/unfinished-session-launcher-title-idempotence.test.ts` (10), `tests/recovery-admission.test.ts` (9) и другие.
- **Воспроизведение.** Выполнить команду выше в `/home/roomhacker/.codex/worktrees/codex-autorecovery/agent-herder` без изменений в `src/` и `tests/codex-*.test.ts` (проверено через `git stash`): падает тот же набор файлов и то же число тестов (48 файлов, 239 тестов).
- **Контекст.** Обнаружено при проверке исправления лимита Codex: зелёными остаются только изменённые файлы, полный набор был красным до изменений. Не использовать полный прогон как критерий приёмки этого исправления; сравнивать состав падений до и после.

## 2026-11-20 — устаревшая фикстура теста отказа лимита не доходила до проверки отказа

- **Симптом.** `tests/codex-quota-guard.test.ts` («a refused resume is not submitted and must not be replayed») падал: `resumeSession` отказывал раньше проверки лимита с «Codex thread resume requires a saved model provider», потому что фикстура не отдавала сохранённый провайдер треда.
- **Воспроизведение.** Запустить `npx vitest run --root . --config vitest.config.ts tests/codex-quota-guard.test.ts` на вершине `2567f2fe` без правок: тест падает с ожиданием `notSubmitted:true`, а фактически приходит ошибка провайдера.
- **Контекст.** Обнаружено при исправлении области лимита для кастомного провайдера; поведение продукта (отказ без сохранённого провайдера) намеренное, исправлена фикстура теста.

## 2026-11-20 — пустые служебные ссылки Codex ломали `git fetch` общего репозитория

- **Симптом.** `git fetch origin main` в общем checkout Agent Herder завершался с `fatal: bad object refs/codex/turn-diffs/captures/…/base` и «не отправил все необходимые объекты», из-за чего проверка главной ветки релиза (`deploy/fleet/main_guard.py`) не могла обновить `origin/main` и отказывала в выкатке.
- **Воспроизведение.** Проверить размер файлов ссылок: `.git/refs/codex/turn-diffs/captures/1795141019370/51b4951b-d158-446b-b18d-24ed902d0229/base` и `.git/refs/codex/turn-diffs/captures/1795141275506/752c0047-1b11-474f-91b2-f09ca8219b99/base` были пустыми файлами нулевой длины, созданными 20.11 в 05:16 и 05:21.
- **Контекст.** Обнаружено при выкатке исправления лимита Codex. Пустые файлы ссылок удалены (данных в них не было), после этого `git fetch origin +refs/heads/main:refs/remotes/origin/main` проходит. Остальные 14 ссылок `refs/codex/turn-diffs/*` сохранены.

## 2026-11-16 — wrapper session_info не повторяет прямой MCP readback

- **Симптом:** подключённый wrapper-вызов mcp__agent_herder__session_info для существующей OpenCode-сессии ses_eac7ce778ffeFIOQrMsi8BFRzl возвращает fleet_session_native_not_ready.
- **Воспроизведение:** вызвать wrapper с sessionId, harness=opencode, hostId=roomhacker-server-100, view=compact или view=messages.
- **Фактический результат:** тот же запрос через обычный Streamable HTTP MCP-клиент к установленному 127.0.0.1:18787/mcp успешно возвращает session.id с exact ses_; поиск по этому идентификатору также возвращает ту же сессию.
- **Контекст:** live Herder и installed artifact работают; проблема относится к wrapper-маршруту/его native-readiness preflight. До отдельного исправления не использовать ошибку wrapper как доказательство отсутствия сессии.

## 2026-11-20 — незавершённая подготовка слота Broker удерживает окно выпуска

- После ошибки `pip check` в защищённом выпуске Account Broker контроллер оставил `occupancyState=unknown` и `reconcileRequired=true`. Кандидат green не запускался. Журнал переключения подтверждает, что текущий blue обслуживает запросы в состоянии `committed`.
- Это воспроизводится при ошибке подготовки до `switch` внутри `BrokerReleaseGuard`. После завершения процесса попытки закрыть ту же аренду контроллер отклоняет, пока нет подтверждения результата.
- После истечения аренды при свободной блокировке цели установленный Herder показал `stale_unknown`. Обычный `acquire` перенёс прежнюю запись в карантин и выдал новую аренду для выпуска Broker. Проверки перед продолжением описаны в [жизненном цикле выпуска](docs/canonical-release-cutover.md#effect-lifetime).
