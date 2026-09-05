# Agent Herder

**MCP-центр управления AI-агентами — и недостающий мессенджер между ними.**

Наблюдай, инспектируй, пиши и координируй сессии AI-агентов через один
MCP-сервер: OpenCode, Claude Code, Codex CLI, Qoder, ZCode и Fast Agent.
Сессии живут в своих харнесах — Agent Herder даёт им общий пульт управления,
общий реестр присутствия и общий почтовый ящик.

[English](README.md) · **Русский** · [简体中文](README.zh.md)

![Анимированная схема связей сессий Agent Herder](docs/assets/agent-herder-animated.svg)

## Запуск за 30 секунд

```bash
npx -y agent-herder
```

Подключение к любому MCP-клиенту:

```json
{
  "mcpServers": {
    "agent-herder": {
      "command": "npx",
      "args": ["-y", "agent-herder"]
    }
  }
}
```

## Три слоя возможностей

### 1. Наблюдение — все сессии всех харнесов в одном списке

- Running / idle / stopped / waiting по OpenCode, Claude Code, Codex CLI,
  Qoder, ZCode и Fast Agent.
- Достоверная живость: реестр жизненного цикла питается хуками (старт сессии,
  границы ходов, конец сессии) и честнее устаревшего статуса из индексов
  задач. Эвристика по свежести `updatedAt` — только фолбэк.
- Родственные связи сессий без угадывания id, экспорт сырых транскриптов с
  навигационной карточкой, аудит worktree, инвентарь моделей.

### 2. Переписка — агенты говорят друг с другом (и с тобой)

- `send_message` доставляет в целевую сессию с семантикой `queue` / `steer` /
  `sync` — и **будит** её: припаркованная ZCode-сессия сама бы никогда не
  исполнила сообщение из очереди, herder делает resume, и сообщение
  выполняется.
- `fromSessionId` / `fromHarness` оборачивают доставку шапкой: *кто прислал* и
  *точный вызов для ответа*. Никакого выслеживания id.
- Idle-интерактивные сессии, отклоняющие прямой промпт, автоматически
  возобновляются при доставке.
- `respond_permission` удалённо одобряет запросы прав — так headless-агенты
  выходят из затыка без человека.

Проверено живьём: два headless-агента в ZCode, созданные через herder,
обменялись несколькими сообщениями через `send_message` и завершились
`CHAT-DONE` — без единого действия человека после стартового пинка.

### 3. Координация — доски по репозиториям, инжект только нового

Каждый воркспейс получает координационную **доску**, привязанную к git-репо
правленных файлов. Сессия, правящая три репо, видна на трёх досках.

- **Авто-резерв по файловой активности**: хуки докладывают каждый правленный
  файл; доска помнит, кто что трогает. Конфликты путей с другим агентом
  возвращаются soft-lock предупреждением до того, как правка уедет.
- **Ростер пиров**: при правке файла хук может вложить блок «кто ещё работает
  в этом репо и как с ним связаться».
- **Декларация задачи**: сессия без собственной заметки получает директиву
  одной строкой — опубликуй `working`-ноту, чем занимаешься.
- **Зачистка по концу сессии**: Stop-хук завершившейся сессии снимает её лизы
  и присутствие со всех досок немедленно.
- **Дедуп инжектов**: все каналы (заметки на старте хода, ростеры по
  активности, доставленные сообщения) делят один сигнатурный слот на сессию
  и доску. Сессия получает блок только при реальном изменении ростера —
  обновления TTL и churn id невидимы — либо после окна устаревания
  (`AGENT_HERDER_INJECTION_RESHOW_MS`, 45 минут) на случай компакции
  контекста.

Ручные заметки тоже работают: `coordination_note_create` с TTL, автор может
обновлять и удалять, просроченные чистятся автоматически.

## Поддерживаемые харнесы

| Харнес | Подключение | Включение |
|---|---|---|
| OpenCode | HTTP API | По умолчанию; нужен `opencode serve` |
| Claude Code | SDK/CLI + нативный `/autopilot` и `Stop`-плагин | По умолчанию |
| Codex CLI | Нативный app-server + плагин-джадж на `Stop` | По умолчанию |
| Qoder CLI | Нативный ACP | `ENABLE_QODER=true` |
| ZCode | Локальный stdio ZCode Protocol app-server + нативные хуки жизненного цикла | По умолчанию |
| Fast Agent | Persisted session home + CLI resume/send | `ENABLE_FAST_AGENT=true` |

## Основные MCP-тулы

| Группа | Тулы |
|---|---|
| Обнаружение | `list_agents`, `agent_info`, `audit_worktrees` |
| Линидж и транскрипты | `find_parent`, `list_children`, `export_transcript` |
| Именованные сессии | `create_session`, `new_or_resume` (OpenCode, Codex, ZCode) |
| Управление | `send_message` (queue / steer / sync, шапка ответа через `fromSessionId`), `resume_agent`, `stop_agent` |
| Координация | `coordination_note_create/list/get/update/delete` |
| Права и модели | `respond_permission`, `set_permissions`, `list_models`, `change_model` |

## Заметки об архитектуре

- **Синглтон-демон.** Один процесс на хост держит состояние, web UI и MCP
  поверх HTTP (`AGENT_HERDER_WEB_PORT`, loopback `18787`). Процессы харнесов
  используют stdio-вход или `http-mcp-stdio.js`-шим, пересылающий вызовы
  демону.
- **ZCode-адаптер.** Говорит на нативном ZCode Protocol app-server
  (length-framed протокол, каналы `zcode-agent` / `zcode-task`) и привязывает
  каждый вызов к нужному воркспейсу (`workspaceKey`).
- **ZCode-плагин** (`integrations/zcode/agent-herder-autopilot`): нативные
  хуки `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `Stop`, `SessionEnd` — питают lifecycle и файловую активность; плюс
  autopilot-джадж на `Stop` (продолжить / спросить человека через durable
  choice registry / завершить и зачистить).
- **Codex-плагин** (`.codex-plugin`): нативный `Stop`-джадж с тем же
  контрактом «продолжить или уведомить».
- **Claude Code autopilot** — под `.claude-plugin/`: `/autopilot`, `Stop`-джадж,
  неоднозначные решения через NoticePlace/web-кнопки.
  См. [docs/autopilot.md](docs/autopilot.md).

## Требования

- Node.js 22+ и npm.
- Минимум один поддерживаемый харнес в `PATH`.
- `OPENAI_API_KEY` для Codex, если app-server его требует.

## Ключевые переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---:|---|
| `ENABLE_OPENCODE` / `ENABLE_CLAUDE` / `ENABLE_CODEX` | `true` | Адаптеры |
| `ENABLE_QODER` / `ENABLE_FAST_AGENT` | `false` | Доп. адаптеры |
| `ZCODE_SERVER_NODE` / `ZCODE_SERVER_ENTRY` | `~/.zcode/server/…` | Рантайм ZCode app-server |
| `ZCODE_TASKS_INDEX_DB` | `~/.zcode/v2/tasks-index.sqlite` | Кросс-воркспейс-дискавери сессий ZCode |
| `AGENT_HERDER_COORDINATION_NOTES` | `~/.local/state/agent-herder/coordination-notes.json` | Общее хранилище досок |
| `AGENT_HERDER_INJECTION_RESHOW_MS` | `2700000` | Повтор инжекта неизменившихся ростеров |
| `AGENT_HERDER_AUTO_TTL_SECONDS` | `60` | TTL авто-лиз файловой активности |
| `AGENT_HERDER_WEB_PORT` | — | Web UI + MCP поверх HTTP (режим демона) |
| `AGENT_HERDER_HTTP_TOKEN` | — | Обязателен для не-loopback хоста |

## Разработка

```bash
npm ci
npm test
npm run build
npm run inspect
```

Stdio-вход: `dist/index.js`; HTTP-шим для харнес-процессов:
`dist/http-mcp-stdio.js`.

## Лицензия

MIT
