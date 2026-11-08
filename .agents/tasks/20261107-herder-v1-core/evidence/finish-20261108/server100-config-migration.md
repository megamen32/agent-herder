# Server100: прямые MCP consumers после отключения old Herder

**Исторический первый этап.** Последующее разрешение владельца выполнено: Hermes включён с существующим owner credential, legacy hooks удалены, оба plugin MCP manifests и regression tests согласованы. Актуальный итог: `server100-cutover-complete.md`, receipts `server100-cutover-complete.json` и `server100-cutover-verification.json`. Ограничения первого этапа ниже сохранены как история, не текущие blockers.

Прямое поручение владельца, 08.11.2026. Endpoint:
`https://mcp.bezrabotnyi.com/server/shell-roomhacker-server-100-agentherder/mcp`.

Выполнено:

- Codex `~/.codex/config.toml`: `mcp_servers.agent-herder` использует новый remote URL и собственные GPTAdmin http_headers; локальный `agent-herder-v1` удалён с backup. `codex mcp get agent-herder --json` проверен без вывода credentials; redundant key отсутствует.
- OpenCode `~/.config/opencode/opencode.jsonc`: изменён только `mcp.agent-herder`; headers взяты из существующего `mcp.servers.gptadmin`. Ссылка на `~/.local/share/opencode-private/settings.jsonc` сохранена, запись атомарно заменена по реальному target; target chmod0600.
- Claude `~/.claude.json`: изменён только `mcpServers.agent-herder`; headers из собственного `mcpServers.gptadmin`.
- Для каждого из этих трёх собственных auth credentials выполнены только initialize/notifications-initialized/tools-list к новому endpoint: HTTP200, 15 tools, `discover` присутствует. Это transport/catalog proof, не повтор native send или проверка всех методов. Заголовки и response bodies не сохранены в отчёте.
- Plugin `.mcp.json` в текущем source worktree, native-release0.2.5 и cache0.2.5 содержит одинаковый `mcpServers: {}`: MCP предоставляется основной защищённой Codex registration, токен в plugin source не записывается. Skills и plugin activation оставлены. Это намеренное устранение дублирующего plugin MCP, а не plugin-local authenticated connection.
- Hermes global и profile lhc: существующий `mcp_servers.agent-herder.enabled=false`; остальные поля сохранены для recovery. Ни в этих config, ни в проверенном global `.env` нет собственной GPTAdmin registration/credential. Чужой client token не подставлялся. Profile luna уже имел `enabled:false` и не менялся. Hermes **не объявлен migrated/PASS**; следующий шаг — предоставить штатную GPTAdmin авторизацию именно Hermes, затем включить точный connector. Указанный владельцем неработающий `mcp-relay.token` не использовался.

Каждый из восьми изменённых файлов имеет отдельный backup0600 в защищённой директории, указанной в `server100-config-migration.json`. Перед изменениями проверены исходные bytes и resolved paths (CAS); перед каждым rename повторная проверка. Все установленные changed files0600. Независимая проверка сравнила parsed config после исключения только разрешённых ключей с backup: **все прочие entries совпадают**. OpenCode symlink сохранён. Receipts: `server100-config-migration.json`, `server100-config-migration-verification.json`.

Hooks сначала обследованы и **не изменены**: plugin Stop → `codex-stop-hook.mjs`, lifecycle/tool hooks → `coordination-hook.mjs` обращаются к прежним `/api/coordination/*` и `/api/human-stop/generated-prompt`. Global `~/.codex/hooks.json` также содержит Herder coordination/autopilot команды. После отключения oldservice эти функции недоступны; их оставление не является доказательством работоспособности. Пользователь просил сначала inspect/report, поэтому отключение hooks не выполнялось. LHC и остальные global hooks не тронуты; hashes проверены до/после.

Source compatibility caveat для интегратора: `tests/codex-plugin-manifest-compat.test.ts:8` требует прежний URL18787 в `.mcp.json` и `mcp.json`; после намеренного удаления plugin MCP это старое ожидание больше не соответствует принятому cutover. Тест/source вне текущих config paths не редактировался, suite GREEN не заявляется. Корневой `mcp.json` (отдельный generic manifest) в этом slice не изменён; данный receipt относится к явно указанному Codex native plugin `.mcp.json` и прямым registrations server100.

Runtime services, GPTAdmin child config, browser, live create/send/archive, commit/push не затронуты. Уже открытым harness sessions может потребоваться штатное переподключение MCP/новый запуск; их процессы не перезапускались. Предыдущий dependency gap report сохранён в `fleet-v1-dependency-gap.md`; принятую владельцем потерю legacy функций он не отменяет.
