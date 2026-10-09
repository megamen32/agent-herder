# Координация без повторных вводов и лишнего контекста

Для доставки используйте полный `sessionId`, `harness` и стабильный `inputId`.
По имени: `deliver(harness,name,cwd,create="never")` выполняет точный native lookup.
`queue` активного Codex направляет сообщение в текущий ход; ожидание завершения
не входит в подтверждение admission. Ответ содержит native admission и IDs.
`admission_unknown/nonRetryable` запрещает автоматическую повторную мутацию.

Обычный `list_agents` возвращает максимум20 недавних сессий; preview только
по запросу, максимум5×160символов. Harness discovery выполняется параллельно
с3секундным ограничением. `complete=false` обозначает неполный охват,
`unavailable` сохраняет ошибки независимо от folder/status-фильтров.
Для точной цели используйте ID; `limit` увеличивает интерактивный охват.

Инструменты сообщают фактический `workdir/cwd`, абсолютные пути за пределами
каталога запуска сохраняются. `coordination_note_create(kind="working",cwd=...)`
позволяет явно обозначить новый проект. В списке `cwd` отражает свежую активность,
а `meta.launchCwd` сохраняет каталог запуска. Activity истекает через5минут;
смена реплики не возвращает launch cwd поверх текущего проекта. Владение файлами
в изолированном worktree не распространяется на соседние репозитории.

Автоматическая координация: до6 сообщений на пару агентов и12 входящих на
сессию за60секунд. Отклонённые сообщения не создают очередь. Повтор одного
inputId coalesces; различные явные IDs допускают намеренно одинаковый текст.
Человеческое explicit продолжение сохраняет прежний путь. Native durable
receipts отдельно защищают admission после перезапуска.

Инъекция до4000символов содержит изменения, а не полную повторную доску.
При неполноте показана ссылка на полные сведения и инструкция проверить
непоказанное владение перед правкой. TTL heartbeat не меняет fingerprint.
Ответ требуется только для решения, ошибки или результата; routine ACK
не нужен. MCP подтверждение не повторяет весь отправленный prompt.

Inbox остаётся на сервере после GET. Hook подтверждает полученные IDs после
получения/выдачи контекста через `POST /api/coordination/inbox-ack`.
Стабильные inbox IDs позволяют распознать повтор; внешнее действие, уже
подтверждённое business receipt, не запускается повторно.

Проверки: fast unit (контекст, IDs, ограничения, exact observation: ожидаемо
<1секунды наcase, max5секунд); focused integration (настоящие HTTP/MCP/Unix
fixtures, native admission, stop/unknown и crossprocess lock: ожидаемо≤40секунд
на весь выбранный набор, max120секунд runner); slow nightly не требуется для
этой delta. Обычный выпуск: релевантные сохранённые результаты + изменённые
checks + backend build в совокупном180секундном окне. Исходный red/failed
результат сохранён и не называется GREEN.

Plugin MCP clients use `dist/http-mcp-stdio.js` and connect to the singleton
HTTP service (`AGENT_HERDER_HTTP_URL`, default loopback18787/mcp). Running
`dist/index.js` per client creates a private controller and splits live state.

Frontend-only releases must preserve the currently deployed backend. Replacing
all of `dist` from an older source commit rolls back delivery fixes. Copy only
`web/index.html` and `web/assets`; compiled `web/*.js` are backend modules.
Verify the live backend manifest immediately before promotion and preserve it.
