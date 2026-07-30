# Agent Herder

**MCP-центр управления AI-агентами для разработки.**

Agent Herder объединяет OpenCode, Claude Code, Codex CLI и Qoder в один
интерфейс: показывает сессии, ищет контекст и помогает управлять агентами.

[English](README.md) · **Русский** · [简体中文](README.zh.md)

![Анимированная схема связей сессий Agent Herder](docs/assets/agent-herder-animated.svg)

## Запуск за 30 секунд

Без клонирования репозитория:

```bash
npx -y agent-herder
```

Для любого MCP-клиента используйте ту же команду:

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

Сначала запустите нужный harness. Для OpenCode:

```bash
opencode serve
```

## Что умеет Agent Herder

- показывает работающие, ожидающие и остановленные сессии;
- находит родителя и детей сессии по настоящей lineage-связи;
- читает последние сообщения или ищет нужный фрагмент транскрипта;
- отправляет сообщения, возобновляет, останавливает и восстанавливает агентов;
- управляет permissions, моделями, worktree и краткими резюме.

Пример запроса агенту:

> Найди родителя этой сессии, перечисли детей и покажи последние пять
> сообщений ребёнка, который сейчас чинит ошибку.

## Поддерживаемые harnesses

| Harness | Как подключается | Включение |
|---|---|---|
| OpenCode | HTTP API | Включён по умолчанию, нужен `opencode serve` |
| Claude Code | SDK/CLI и файлы сессий | Включён по умолчанию |
| Codex CLI | Native app-server и CLI fallback | Включён по умолчанию |
| Qoder CLI | Native ACP | `ENABLE_QODER=true` |

## Инструменты MCP

| Задача | Инструменты |
|---|---|
| Найти сессии | `list_agents`, `agent_info`, `audit_worktrees` |
| Родители и контекст | `find_parent`, `list_children`, `get_transcript`, `search_transcripts` |
| Управление | `send_message`, `resume_agent`, `stop_agent` |
| Permissions и модели | `respond_permission`, `set_permissions`, `list_models`, `change_model` |
| Резюме | `summarize_session` |

`get_transcript` принимает ID сессии, необязательное число последних сообщений
и необязательный `query` (либо сформулированную лидом `need`). Он ранжирует
совпадения, сохраняет соседний контекст и возвращает только ограниченный нужный
фрагмент, а не всю историю.

## Требования

- Node.js 22+ и npm;
- установлен хотя бы один поддерживаемый harness;
- `OPENAI_API_KEY` для Codex, если его app-server этого требует.

## Конфигурация

| Переменная | По умолчанию | Назначение |
|---|---:|---|
| `ENABLE_OPENCODE` | `true` | включить OpenCode |
| `ENABLE_CLAUDE` | `true` | включить Claude Code |
| `ENABLE_CODEX` | `true` | включить Codex |
| `ENABLE_QODER` | `false` | включить Qoder ACP |
| `OPENCODE_URL` | `http://127.0.0.1:4096` | URL OpenCode |
| `CODEX_TRANSPORT` | `app-server` | native transport или `cli` fallback |
| `QODER_CWD` | текущий каталог | рабочая папка Qoder |
| `SUMMARIZER_API_KEY` | — | включает `summarize_session` |
| `AGENT_HERDER_TRANSCRIPT_ARCHIVE_DIR` | `.agent-herder/transcripts` | относительный путь архива внутри CWD MCP-процесса |
| `AGENT_HERDER_TRANSCRIPT_ARCHIVE_MAX_BYTES` | `104857600` | лимит архива, 100 MiB |
| `AGENT_HERDER_TRANSCRIPT_ARCHIVE_RETENTION_DAYS` | `3` | удалить не менявшиеся bundles по времени изменения |
| `AGENT_HERDER_TRANSCRIPT_INLINE_TOKEN_BUDGET` | `8192` | приблизительный inline-бюджет до карточки навигации |

Пример для Qoder:

```bash
export ENABLE_QODER=true
export QODER_CWD=/path/to/project
npx -y agent-herder
```

## Разработка

```bash
npm ci
npm test
npm run build
npm run inspect
```

Локальная stdio-точка входа: `dist/index.js`.

## Частые вопросы

**Agent Herder заменяет моего coding-агента?** Нет. Он подключает MCP-клиент
к уже существующим сессиям OpenCode, Claude Code, Codex или Qoder.

**`get_transcript` читает всю историю?** Нет. Можно запросить последние N
сообщений или найти нужный фрагмент — результат ограничен по размеру.

**Можно оставить только один harness?** Да, отключите ненужные адаптеры через
переменные `ENABLE_*`.

## Архив транскриптов

Каждый успешный `get_transcript` атомарно копирует raw-источник адаптера под
CWD MCP-процесса и создаёт рядом manifest lineage. Display-текст никогда не
служит fallback для архива. Manifest содержит источник, формат, покрытие
timestamps и подтверждённую полноту; родители и дети за пределами CWD только
отмечаются как исключённые.

Если выбранный контекст больше inline-бюджета, Herder возвращает пути и готовые
примеры с `latestMessages`, `query`, `regex`, `after`/`before`. Архивы OpenCode
и ACP явно частичные, пока upstream не предоставляет проверенную полную историю.

## Лицензия

MIT
