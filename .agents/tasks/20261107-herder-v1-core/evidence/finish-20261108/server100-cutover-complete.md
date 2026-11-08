# Cutover server100 завершён в разрешённом config/source scope

08.11.2026. Прямое уточнение владельца: выключить old Herder с принятой потерей legacy функций, без ожидания parity. Дополняет и supersedes ограничения первого этапа `server100-config-migration.md`.

Обычные Codex/OpenCode/Claude registrations продолжают использовать один central GPTAdmin child по `https://mcp.bezrabotnyi.com/server/shell-roomhacker-server-100-agentherder/mcp`; локальная Codex `agent-herder-v1` отсутствует. Их headers/config в этом этапе не менялись. В первом этапе каждая собственная авторизация прошла initialize/tools-list HTTP200, 15tools; `codex mcp get` подтвердил effective remote entry.

Hermes global `~/.hermes/config.yaml` и `~/.hermes/profiles/lhc/config.yaml` теперь содержат enabled remote `agent-herder` на этом же endpoint, без старого command/args/env. Использован штатный supported Hermes config contract `url` + `headers.Authorization` (`gptadmin/cli.py:_configure_hermes_mcp`). Credential взят из защищённой существующей owner GPTAdmin registration Codex, как прямо разрешено владельцем; серверная identity остаётся identity этого credential, новая identity Hermes не заявляется. Read-only initialize/tools-list из установленного Hermes config: HTTP200, 15 tools, discover присутствует. Отдельный сохранённый `GPTADMIN_HERMES_MCP_BEARER` в config storage был проверен и вернул401; не использован, не заменён и не ротирован. Общий `configure_ai_mcp_clients` не запускался: он способен создать отсутствующие tokens и переписать env storage. Новых grants/tokens нет, credential store bytes неизменны. Luna profile уже disabled и не менялся.

Удалены только распознанные oldHerder HTTP hooks:

- `~/.codex/hooks.json`: три coordination hooks и один autopilot Stop hook (всего4). AgentMemory, shared-session registration, прочие commands и metadata сохранены. Claude global settings, LHC и другие global hooks не менялись.
- Source worktree: `.codex-plugin/hooks.json`, `com.openai/hooks/hooks.json`, `hooks/hooks.json` — legacy hooks отключены.
- Installed Codex native-release0.2.5 и cache0.2.5: `com.openai/hooks/hooks.json` — legacy hooks отключены.
- Installed Claude Herder cache0.2.0, найденный через `~/.claude/plugins/installed_plugins.json`: те же три hook manifests — legacy hooks отключены. Это была реальная оставшаяся activation, а не исторический произвольный cache.

Всего удалены32 команды: 4 global +28 plugin. Mixed-group preservation проверен отдельным offline fixture: удаляется Herder command, LHC и AgentMemory commands/metadata в той же группе сохраняются; операция idempotent. При изменении actual global input ожидаемые четыре команды проверены до записи. Никакие pending/UNKNOWN mutations не повторялись.

Source `.mcp.json` и `mcp.json` теперь согласованно имеют пустой `mcpServers`: защищённой общей MCP registration владеет host config, plugin сохраняет skills/entrypoints и не встраивает auth. Installed Codex native-release/cache `.mcp.json` совпадают с source. Оба MCP manifests actual installed Claude cache тоже очищены от дублирующего `agent-herder`. Отсутствующие в projection файлы не создавались.

`tests/codex-plugin-manifest-compat.test.ts` обновлён под этот контракт: отсутствие plugin-local credential/core/oldURL, согласованность обоих MCP manifests, сохранение skill/native/portable entrypoints, отключение трёх source hook surfaces. **RED: 2 failed**, до изменения legacy manifests; **GREEN: 2 passed**, после. Logs: `cutover-plugin-red.log`, `cutover-plugin-green.log`. `git diff --check` для owned source/tests PASS. Общая suite/legacy functional parity не заявляется.

Все14 изменённых на этом этапе config/manifest файлов имеют backup0600, CAS исходных bytes/resolved paths, atomic replace, parsed readback. Отдельная verification сравнила backup с installed output: только разрешённые hook removals, exact Herder MCP keys и Hermes connector; unrelated entries совпадают. Новые/изменённые config files0600. Test source также backed up0600 перед правкой. Sanitized receipts без token/header/response bodies: `server100-cutover-complete.json`, `server100-cutover-verification.json`. Старые receipts сохранены как история. Evidence scripts one-shot: от повторного применения после receipt защищены до любых операций.

Не выполнялись: runtime/service mutations, native create/send/read/archive, браузер, новый core process, commit/push или переключение других hosts. Проверки HTTP касались только existing GPTAdmin MCP handshake/catalog. Уже запущенные harness sessions могут держать прежний snapshot config/hooks до штатного reload/нового запуска; принудительный runtime restart не выполнялся. Старые autopilot/coordination функции сознательно сняты по разрешению владельца, их parity не блокирует этот cutover.


Финальный regression delta по integration review (08.11.2026): изменены только противоречащие disabled-legacy контракту ожидания в `tests/autopilot-plugin-surfaces.test.ts` (Claude hooks map пуст) и `tests/hooks-plugin-package.test.ts` (собранный package сохраняет пустой hooks map). Проверки наличия legacy scripts, skill/launcher packaging и безопасности сохранены; source/hooks/config не менялись. `hooks-script-safety` и `codex-plugin-manifest-compat` не редактировались в этом delta.

Точная команда:

```sh
./node_modules/.bin/vitest run --config vitest.config.ts tests/autopilot-plugin-surfaces.test.ts tests/hooks-script-safety.test.ts tests/hooks-plugin-package.test.ts tests/codex-plugin-manifest-compat.test.ts
```

До правки: **2 failed, 16 passed**, 4 suite. После: **4 files PASS, 18 tests PASS**, exit0. Logs: `cutover-regression-delta-red.log`, `cutover-regression-delta-green.log`. `git diff --check` PASS. Protected backups и SHA inputs: `cutover-regression-delta-inputs.json`; точная команда/results также добавлены в JSON complete/verification receipts. Native/live calls, runtime/config edits, commit/push в этом delta отсутствуют.
