# Agent Herder

[English](README.md) | **Русский** | [中文](README.zh.md)

MCP-сервер для мониторинга и управления сессиями OpenCode, Claude Code, Codex CLI и Qoder через единый интерфейс.

![Рабочее место Agent Herder](docs/assets/readme-hero.png)

![Анимированная схема связей сессий Agent Herder](docs/assets/agent-herder-animated.svg)

## Быстрый старт

Запустить опубликованный MCP-сервер одной строкой, без клонирования репозитория:

```bash
npx -y agent-herder
```

В конфигурации MCP-клиента укажите команду `npx` и аргументы `-y agent-herder`.

Из локального checkout установите зависимости и соберите сервер одной командой:

```bash
npm ci && npm run build
```

Готовая stdio-точка входа: `dist/index.js`. Для Claude Code зарегистрируйте локальную копию:

```bash
claude mcp add agent-herder -- node "$PWD/dist/index.js"
```

Для Cursor, OpenCode и других MCP-клиентов укажите тот же абсолютный путь к `dist/index.js` в конфигурации. Если включён OpenCode, сначала запустите `opencode serve`.

## Что умеет сервер

- показывает все сессии, их состояние, модель, стоимость и последнюю активность;
- отправляет сообщения, возобновляет и останавливает агентов;
- отвечает на запросы разрешений и меняет настройки permissions;
- меняет модель и создаёт краткое резюме сессии.

## Требования и конфигурация

Нужен Node.js с npm и хотя бы один поддерживаемый CLI: `opencode`, `claude`, `codex` или `qodercli`. Для Codex задайте `OPENAI_API_KEY`.

Основные переменные окружения:

| Переменная | Назначение |
|---|---|
| `ENABLE_OPENCODE`, `ENABLE_CLAUDE`, `ENABLE_CODEX` | включение адаптеров; по умолчанию `true` |
| `ENABLE_QODER` | включение нативного Qoder ACP; по умолчанию `false` |
| `OPENCODE_URL` | URL OpenCode, по умолчанию `http://127.0.0.1:4096` |
| `CLAUDE_BIN`, `CODEX_BIN` | путь к CLI |
| `CODEX_TRANSPORT` | `app-server` для native pause/resume/fork/recovery; `cli` — старый fallback |
| `CODEX_CWD`, `CODEX_MODELS` | рабочий каталог и список моделей Codex app-server |
| `CODEX_DATA_DIR` | каталог данных Codex, по умолчанию `~/.codex` |
| `QODER_BIN`, `QODER_CWD`, `QODER_ARGS` | путь, рабочий каталог и JSON-массив аргументов `qodercli` |
| `QODER_MODEL`, `QODER_MODELS` | начальная модель и список моделей для переключателя |
| `SUMMARIZER_API_KEY` | ключ для инструмента `summarize_session` |

Полная таблица переменных, конфигурации клиентов, архитектура и заметки по каждому harness находятся в [английском README](README.md).

Для подключения Qoder к Agent Herder:

```bash
export ENABLE_QODER=true
export QODER_BIN=/home/roomhacker/.npm-global/bin/qodercli
export QODER_CWD=/home/roomhacker/PycharmProjects/video_watching
npm start
```

Используется нативный `qodercli --acp`: Agent Herder видит существующие сессии,
может отправлять сообщения, ставить turn на паузу, возобновлять, восстанавливать
после ошибки и создавать дочернюю сессию. `change_model`
использует ACP-переключение модели, если его поддерживает версия Qoder.

## Инструменты MCP

`list_agents`, `agent_info`, `find_parent`, `list_children`, `get_transcript`, `send_message`, `resume_agent`, `stop_agent`, `respond_permission`, `set_permissions`, `summarize_session`, `change_model` и `list_models`.

## Разработка

```bash
npm run dev      # TypeScript watch mode
npm run build    # компиляция
npm run inspect  # MCP Inspector
```

## Лицензия

MIT
