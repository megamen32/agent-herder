# HANDOFF — Agent Herder / Process Leases

> P0. Зафиксированный handoff пользователя от 15.11.2026 (около 04:30 МСК). Это исторический срез, **не** утверждение о текущем состоянии установленного Herder. Перед любыми действиями заново проверить live runtime, Git, claims и оригинальные квитанции.

## Цель

Объединить Agent Resume с Agent Herder в **одну authority**, используя существующие `resource` и `automation`: универсальные claims для устройств/build/workspace/deployment; supervised process tree; отдельный worker автопродления lease без LLM-polling; долговременную квитанцию завершения; продолжение **той же native-сессии**; fencing, idempotency, ACK-reconciliation и защиту от повторных spawn/wake. Самостоятельный effectful scheduler Agent Resume должен быть отключён.

## Базовое состояние на момент handoff (15.11.2026 ~04:30 МСК)

| Компонент | Зафиксированное состояние |
| --- | --- |
| server-100, TypeScript Herder | RUNNING; MainPID `2709214` |
| Установленный TS source | `7d5362bfcbb8e2cf6b73dc06a6d33d10f2e56456` |
| `.fleet-candidate/current` | Релиз `7d5362bf...` |
| HEAD основного репозитория при проверке | `1e959472d4d8728b51ec368d1ccc59c1c6023a2f` |
| Resource ledger | Canonical v2 |
| Миграция ресурсов | 27 descriptors / 28 project mappings |
| OpenCode full E2E | PASS (только подтверждённый протокол) |
| ZCode full E2E | Не подтверждён |
| Старые UNKNOWN | Не replay; сохранены |

Уже после этого среза исходники и установленная версия могли измениться. **Не считать названные PID/SHA актуальными и не откатывать сервис, пока не проверена фактическая установка.**

## Реализовано и подтверждено

- Rust ownership core, durable process supervisor, heartbeat worker и общий механизм ожиданий для process/timer/session.
- TypeScript scheduler переведён на canonical authority; прежний независимый Agent Resume не должен выполнять effectful scheduling.
- Шесть native authority получили snapshots миграции. Исходные записи Agent Resume сохранены без повторной отправки.
- Release leases переведены с v1 на v2. Три чужих неопределённых владельца остаются под точными holds: `vpn-panel` fence 9, `exmanager` fence 1, `macintel-webvnc` fence 1.
- **OpenCode E2E PASS:** реальная сборка 40,36 с, TTL claim 15 с, core отсутствовал 18 с, claim продлевался worker, exit=0, claim released, ровно один native wake/input/assistant turn и стабильный idle без дубликатов.

OpenCode acceptance: `/home/roomhacker/herder-artifacts/process-leases-20261113/canary-opencode-process-production-2c4c585d-v1/acceptance.json`

SHA256: `b6644b7f054ce848fdf056f18987e0e9d88dbc0586168121533b7924e95eb7c8`

## Основной блокер — ZCode native continuation

Процессный этап прошёл: сборка exit=0, дерево завершено, renewal работал при недоступном core, claim освобождён и receipt сохранён. **Полный native wake ещё не доказан.**

В native ZCode успешный turn хранится как `completed`, а прежняя проверка ожидала `success` (фикс `8b2eca2f`). Затем обнаружены нюансы cold session и V4 phase/end. В checkpoint следующим source отмечался `3e81c41d`; позднейшие версии дошли до `7d5362bf`. Нельзя автоматически считать, что дефекты устранены в установленной сборке.

Последняя записанная контрольная операция `a0ede4a0a45666d18b4d23353ade599d`: exit=0; 44 успешных renewal, 0 ошибок; claim released; `intent_count=0`, `native_delta=0`; `armed_deferred_before_native_handoff`. **Это не PASS.**

Сначала прочитать **исходную** durable task/receipt/checkpoint и реальную полную историю native-сессии. Повторно запускать старый build, READY prompt или wake **запрещено**. Новый тест допускается лишь после доказанного отсутствия эффектов исходного запроса, с новым ключом и в изолированном окружении.

## Пути и документация

- Репозиторий: `/home/roomhacker/agents-projects/agent-herder`
- Рабочий worktree: `/home/roomhacker/agents-projects/.worktrees/herder-process-leases-20261113`
- Evidence: `/home/roomhacker/herder-artifacts/process-leases-20261113`
- Durable checkpoint: `/home/roomhacker/herder-artifacts/process-leases-20261113/deployment-20261114/root-checkpoint.json`
- Подробный deployment report на сервере: `/home/roomhacker/agents-projects/.worktrees/herder-process-leases-20261113/docs/implementation/process-leases-deployment-20261114.md`
- Процедура: [`docs/supervised-jobs.md`](../supervised-jobs.md)
- Release runbook: [`docs/process-leases-runtime.md`](../process-leases-runtime.md), [`docs/canonical-release-cutover.md`](../canonical-release-cutover.md)
- Исходный архитектурный план: https://chatgpt.com/space/page_835ee164266081918e5e4297ac92a2a3

## Порядок следующего исполнителя

**P0 — Актуализация runtime.** Через GPTAdmin проверить live TS MainPID и source, git ancestry, native child PID/manifest, runtime selector, HTTP `operational` readiness, canonical ledger/quarantine, current release claim/fencing. Уточнить расхождения и новые изменения после 04:30.

**P1 — ZCode E2E.** Сверить исходную задачу `a0ede4a0a45666d18b4d23353ade599d`; выяснить фактическую причину deferred native wake. После reconcile выполнить один безопасный новый изолированный тест. PASS требует один process, один wake intent, один native input, один assistant turn и проверенный стабильный idle.

**P2 — Согласованная установка.** Если исправление не установлено, собрать из опубликованного source точные TS/native artifacts, получить **новый** canonical release claim, проверить origin/main ancestry и выполнить парное обновление; старый fence 122 повторно не использовать. Установленную версию и consumer proofs сверять с реальными процессами.

**P3 — Остальные harness.** Проверить Codex, поддерживаемые версии OpenCode, ChatGPT/browser, Hermes и ZCode по их реальному native admission contract. Автопродолжение разрешать только при доказанной поддержке; фиксировать ограничения отдельно.

**P4 — Завершение.** Проверить отсутствие второго scheduler, корректность quarantines/UNKNOWN и сохранность данных. Зафиксировать receipts, source SHA, CI, installed process hashes, commit/push, release-claim release и актуализировать runbook. Не удалять историю и не устранять holds одним TTL.

## Ограничения и DoD

- Отдельный worktree; не перезаписывать чужой WIP, включая незакоммиченные изменения документации.
- Не интерпретировать исчезнувший PID или истёкший TTL как успешное завершение.
- Потерянный ACK: только original-key reconciliation, без blind retry и двойных эффектов.
- Не менять credentials/model/quota ради теста; не обходить `server-44` writer admission при HTTP 503.
- Не запускать production только на основании unit-тестов; обязательно проверить native процесс, CI и user-facing фактическую версию.

**Definition of Done:** единый работающий Herder в production, одно владение ресурсами, native full E2E для ZCode и остальных реально поддерживаемых harness, корректный release claim cleanup, опубликованные изменения и сохранённые UNKNOWN без повторных эффектов. В финальном отчёте перечислить отдельно PASSED E2E и ограничения по harness.
