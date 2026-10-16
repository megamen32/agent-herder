# Инвентарь общего ядра: Agent Resume → Agent Herder

Монорепозиторий — это репозиторий **Agent Herder**, и он остаётся единственным
проектом, который нужно поддерживать. Agent Resume перестаёт быть отдельной
системой: его общие возможности переезжают в пакет `packages/agent-resume`
внутри монорепозитория, а Agent Herder собирается и работает против этого
пакета как против зависимости. Релиз монорепозитория выпускает оба артефакта из
одного исходника и одной версии.

Правило, которое делает рассинхрон невозможным: **у каждой capability ровно один
владелец.** Если capability описана в двух местах — это дефект, а не избыточность.

## 1. Capability и владелец

| Capability | Сейчас знают оба | Владелец после слияния |
|---|---|---|
| Протокол OpenCode (список сессий, адресация, доставка, статус, модель) | Resume: `agent_resume.py:388 opencode_sessions()` (legacy-таблица `session`), `agent_resume.py:695 build_resume_command()`; Herder: `src/adapters/opencode.ts` (1145 строк, нативный `/api`) | **Agent Resume (ядро)** |
| Протокол Codex (список/поиск, доставка) | Resume: `agent_resume.py:279 codex_sessions()`, `build_resume_command()` → `codex exec resume` (мёртвый путь: `src/resume-transport.ts` отклоняет codex для Resume); Herder: `src/adapters/codex-app-server.ts` | **Agent Resume (ядро)** |
| Протокол Claude (список/поиск, доставка) | Resume: `agent_resume.py:597 claude_sessions()`, `build_resume_command()` → `claude --print --resume`; Herder: `src/adapters/claude.ts`, `src/adapters/claude-sdk.ts` | **Agent Resume (ядро)** |
| Поиск сессии по маркеру | Resume: `validate_marker`/`match_score`/`find_sessions`; Herder: своих нет, но перечисление есть | **Agent Resume (ядро)** |
| Квитанции и идемпотентность | Resume: `_receipt_fingerprint:877`, `_locked_receipt_records:931`, `_validate_idempotency_key:865`, `query_resume_receipt:946`; Herder: `src/herder-jobs.ts`, `freezeRequest` в `src/resume-transport.ts` | **Agent Resume (ядро)** |
| Отсоединённый запуск и длинные задачи | Resume: `start_watcher:1267`, `watcher_main:1404`, `tool_wait_and_resume:1358`, `tool_wait_job_status:1383`, каталог `jobs/`; Herder: `src/herder-jobs.ts`, `src/workload-launcher.ts` | **Agent Resume (ядро)** |
| Интеграция с Hermes | Resume: `hermes_gateway.py` (600+ строк) + `scripts/install-hermes-plugin.py`; Herder: `src/adapters/hermes/adapter.ts`, `integrations/hermes/agent-herder-autopilot` | **Agent Resume (ядро)** |
| Борд координации, lifecycle, активность путей | Herder: `src/coordination-notes.ts`, `src/session-supervisor.ts`, `POST /api/coordination/*` | **Agent Herder** |
| Политика и судья автопилота, выбор варианта, вопросы человеку | Herder: `src/autopilot/*`, `src/autopilot/choice-registry.ts`, `src/human-request/*` | **Agent Herder** |
| Fleet/mesh, веб-интерфейс, MCP-поверхности | Herder: `src/mesh/*`, `src/web/*`, `src/mcp/*` | **Agent Herder** |

## 2. Статус переноса

| Capability | Статус | Где живёт сейчас |
|---|---|---|
| Протокол OpenCode | **перенесено** | `packages/agent-resume/src/harness/opencode/client.ts`; `src/adapters/opencode.ts` — оркестрация поверх ядра |
| Зависимость Herder → ядро | **сделано** | npm workspaces + `coreContractHash()`; контракт запинен в `src/resume/core-contract-pin.ts` |
| Артефакты из одного исходника | **частично** | версии связаны и проверяются тестом; релизный пайплайн ещё не собран |
| Протоколы Codex и Claude | не начато | herder-адаптеры + legacy-пути Resume |
| Квитанции и идемпотентность | не начато | Resume `_receipt_*`, herder `herder-jobs.ts` |
| Отсоединённые длинные задачи | не начато | Resume `start_watcher`, herder `workload-launcher.ts` |
| Hermes | не начато | Resume `hermes_gateway.py`, herder `adapters/hermes` |
| Поиск по маркеру | не начато | Resume `find_sessions`/`match_score` |

Перенос OpenCode сохранил поведение: v2 и legacy протоколы, порядок сообщений,
форму ответов доставки (`prompt_async`/`message` против инбокса), сигналы
подключения и отключения потока событий, идентичность активного хода. Herder
сохранил только оркестрацию: запись в очередь активного хода с квитанцией,
запрет доставки при явной остановке, форму собственных событий.

## 3. Где сегодня ломается синхронизация

1. **OpenCode 2 не виден Resume.** Живая сессия есть в `session_v2` и отсутствует
   в legacy `session`/`message`/`part`, которые читает `opencode_sessions()`
   (проверено на живой сессии: 0 строк в legacy, 295 в `session_message`).
2. **Доставка в OpenCode 2 ломается.** `build_resume_command()` даёт
   `opencode --session … --prompt …`, CLI отвечает `Session not found`. Herder
   обошёл это нативным инбоксом (`src/autopilot/continuation-delivery.ts`).
3. **Codex у Resume мёртвый.** `src/resume-transport.ts` намеренно не пускает
   codex через Resume; код в Resume остаётся вторым, мёртвым знанием.
4. **Нет общего контракта.** В `agent_resume.py` нет ни одного упоминания herder;
   herder проверяет только свой клиент (`tests/resume-transport.test.ts`), серверная
   сторона контракта не покрыта тестами.
5. **Нет тестов на OpenCode в Resume.** `tests/` в Resume не содержит ни одного
   теста на opencode.

## 4. Кто сейчас зависит от отдельного Agent Resume

- **Herder:** `AgentResumeClient` (`src/resume-transport.ts`) запускает
  `python3 agent_resume.py resume_bound_target` на каждый вызов. Точки вызова:
  продолжение автопилота (фолбэк), ответ человека, выбор варианта, веб-восстановление.
- **Живые фоновые продолжения:** ~25 активных transient-scope
  `agent-herder-agent-resume-*.scope` с `result_ref: agent-herder://autopilot/stop/…`.
- **MCP-регистрации:** `~/.config/opencode/opencode.jsonc` и `~/.codex/config.toml`
  (`npx -y github:megamen32/agent-resume`).
- **Установщики:** `scripts/install-client-configs.py`, `install-hermes-plugin.py`,
  `install-long-task-retrospective.py`.
- **Форма standalone-артефакта уже npm:** пакет `agent-resume-mcp` с bin,
  который поднимает Python (`npm/agent-resume-mcp.js`).

## 5. Обнаруженный чужой WIP (не трогаем)

В `/home/roomhacker/agents-projects/agent-resume` на момент инвентаризации есть
незакоммиченная работа, сделанная не мной: новый `opencode_transport.py`
(Python-порт v2-транспорта из herder) и правки `agent_resume.py` (чтение
`session_v2` с дедупликацией, команда `opencode run --session … -- <prompt>`).
Живой сессии-автора среди наблюдаемых не найдено.

Решение: файлы не изменяются и не удаляются; их идеи (безопасная работа с
редиректами, запрет неоднозначного повторного POST, дедлайн на скан БД) учитываются
при переносе в ядро. Автору нужно сообщить, что путь закрыт и работа переносится
в `packages/agent-resume`.

## 6. Как рассинхрон станет невозможен

- npm workspaces: `packages/agent-resume` — источник общей части, `agent-herder`
  зависит от него и собирается против него.
- Контракт генерируется из ядра; herder хранит его версию/хэш. Изменение ядра без
  перегенерации контракта и пересборки herder роняет CI.
- Проверка владения: протокол харнессов (чтение БД, флаги CLI, адресация сессий)
  не должен появляться вне `packages/agent-resume`.
- Релиз одной командой публикует оба пакета с одной версией.

## 7. Порядок переноса и правила безопасности

1. Инвентарь (этот документ) — зафиксирован.
2. Скелет монорепо: workspaces, пакет ядра, контракт v1. Поведение не меняется.
3. Перенос capability-by-capability с тестами; herder на каждом шаге работает
   как раньше (старый путь не выключается до живой проверки).
4. Переключение herder на ядро по одной capability, начиная с OpenCode
   (протокол уже нативный — ядро становится его единственным владельцем).
5. Релизный пайплайн: два артефакта, одна версия; MCP-регистрации переводятся на
   новый пакет.
6. Живая проверка каждого потребителя из раздела 3; только после этого —
   предложение владельцу о выключении старого сервиса.

Правило безопасности: Agent Herder в каждый момент остаётся работоспособным;
идущие фоновые продолжения не обрываются; capability, которую нельзя перенести
без потери, не выбрасывается молча — она либо переезжает, либо выносится как
решение владельца.

## 8. Вне объёма

Семантика судьи и политики автопилота, БД OpenCode и её разросшийся файл,
портирование v1-плагина на effect-контракт OpenCode 2, поведение fleet/mesh.