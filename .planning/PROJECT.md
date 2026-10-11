# Agent Herder

## What This Is

Единый кабинет нативных AI-сессий на нескольких машинах. Пользователь управляет моделями, сообщениями, автопилотом, восстановлением остановившихся сессий и сжатием контекста.

## Core Value

Доводить порученную работу до реального результата в исходной сессии через доступный пользователю кабинет.

## Requirements

### Validated

- ✓ Независимые страницы автопилота и автопродолжения с настройками поддерживаемых сред — существующая реализация.
- ✓ Автокомпакт ZCode с порогами 35% контекста и пять человеческих сообщений — реальная тестовая сессия, сохранены ID и история.
- ✓ Выбор модели, изображение, очередь и отправка queued сообщения как steer — реальные нативные проверки.
- ✓ Общая навигация слева и сохранение выбранной машины при создании — браузерная проверка настольного и мобильного интерфейса.

### Active

- [ ] Устойчивое подключение Mac через публичный кабинет с настоящей пользовательской SSO-авторизацией.
- [ ] Финальная независимая проверка компоновки новой сессии после последних изменений.
- [ ] Проверка результата обработки незавершённых сессий за последние 48 часов; исторический список не означает завершение всех задач.

### Out of Scope

- Перезапуск нативного Codex или замена контроллера — для восстановления наблюдателя не требуется.
- Ослабление авторизации или подмена cookies — проверяется существующий пользовательский вход.
- Параллельная установка серверного runtime — им управляет отдельный зарегистрированный владелец интеграции.

## Context

Brownfield recovery of planning state on 2026-10-12; existing source, commits and delivery evidence remain authoritative. Published UI is retained by the incident/Hermes integration. Mac watchdog kernel identity probes are installed, but artifact accounting has intermittently exceeded its finite deadline. An existing infrastructure healer starts the stopped node; reverse SSH and public upstream also intermittently fail. A successful public READY sample is not stable acceptance.

## Constraints

- **History**: preserve native SID, foreign WIP and previous evidence.
- **Delivery**: canonical checkout and scoped commits on main; no new worktrees.
- **Resources**: finite measured budgets; ordinary checks including setup at most 180 seconds.
- **Ownership**: UI/Mac observer and transport belong to this delivery; incident/Hermes and server100 runtime have another owner.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Separate autopilot and no-LLM recovery | Different responsibilities | Good |
| 35% and five human messages required together | Avoid compressing small/test sessions | Good |
| Provider cache TTL remains an estimate unless documented | No confirmed fixed five-minute TTL | Good |
| Public authenticated browser is final Mac acceptance | Local CLI READY does not prove the user's route | Pending |
| Kernel PID/FD checks each tick; global exclusivity at JOIN | Retain ownership checks without expensive global polling | Pending steady runtime |

## Evolution

After a phase, move requirements only when its real consumer proof exists. Preserve accepted decisions and record unresolved defects; do not reset historical progress.

---
*Last updated: 2026-10-12 after recovery from accepted task context*
