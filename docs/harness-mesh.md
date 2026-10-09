# Harness Mesh через GPTAdmin

Агент может читать настоящие native ID и подтверждённые текущие проекты на
других управляемых компьютерах, а затем адресно передать короткую дельту работы.
GPTAdmin остаётся единственным маршрутом доступа: `discover → schema →
mcp_tools → mcp_call`. Mesh не создаёт новый Hub и не меняет runtime-core.

Адрес — `{hostId, harness, nativeSessionId}`. Каталог проекта — состояние,
а не часть идентификатора. `project.launchCwd` показывается отдельно от
`project.currentCwd`; `currentCwd: null, source: unverified` означает, что
текущий рабочий каталог не подтверждён. На singleton server-100 используется
существующий `coordinationNotes.activeWorkspaceForSession` и native actor.
Сам по себе Codex `turn_context.cwd` не подтверждает рабочий каталог tool call.

## Использование из любого подключённого харнеса

1. GPTAdmin `discover`: выбрать **полученные** child MCP target IDs, затем
   запросить `schema` / родительский `mcp_tools` для их реальной схемы.
2. `mesh_snapshot({limit:12})`: host proof, native session IDs, project proof,
   по каждой среде явная capability/причина недоступности/repair plan.
   Пустой список сессий и отсутствие транспорта — разные состояния.
3. `mesh_deliver({target,sender,inputId,message})`: exact native адрес;
   `inputId` стабилен для одной операции; `message` — новая дельта ≤4000 знаков.
4. Подтверждённая квитанция содержит `state: admitted`, native `turnId` и
   тот же `inputId`. `unknown` запрещает повторную отправку. Только доказанное
   `not_attempted` с `retryable:true` допускает ограниченный повтор.

`sender` — объявленная атрибуция, а не удостоверение отправителя. Для реальной
межхостовой приёмки вызов выполняется непосредственно на исходном хосте через
его authenticated GPTAdmin consumer; сохраняются host/actor proof и native
квитанция цели. Объявить `sender.hostId=88` на server-100 недостаточно.

`GptAdminMesh` принимает authenticated `GptAdminTransport` от существующего
consumer. Он не читает/выдаёт/подменяет токены. Если consumer передан в
`registerHarnessMeshTools`, дополнительно доступны `mesh_discover` и
`mesh_route`; без него GPTAdmin consumer сам использует snapshot/delivery
через стандартную relay-поверхность.

## Ограничения и защита от повторов

- Global merged discovery ≤12 sessions; одновременно ≤3 reads, local deadline
  2s, remote read deadline 5s; недоступность/timeout возвращается как partial.
  Поздний результат чтения не меняет уже возвращённое состояние mesh.
- Snapshot не запускает LLM, ленивый native writer или экспорт транскрипта.
- Автоматические сообщения: максимум 6 на пару и 12 на цель за минуту.
  Receiver ledger сохраняет эти границы между MCP client reconnects.
- `harness-mesh-receipts.json`: максимум 2048 сохранённых intent/receipts;
  admitted/UNKNOWN не вытесняются. Intent записывается до native RPC, receipt
  возвращается до повторного чтения target, включая исчезнувший/stopped target.
- Используются существующие STOP semantics и бюджет native owner. Нельзя
  объявить успешно доставленным textual ACK без native admission receipt.

## Удалённый leaf

`src/mesh/native-peer.ts` — stdio MCP leaf, управляемый существующим GPTAdmin
ShellMCP supervisor, без HTTP listener, watcher, нового Hub или private writer.
Он читает Codex SQLite в read-only режиме и не более 128 KiB хвоста native
rollout для metadata. Остальные харнесы явно unavailable до проверки их
зарегистрированного native транспорта.

Control подключается только к существующему documented Unix-WebSocket
`CODEX_APP_SERVER_SOCKET`; никогда не запускает, перемещает или убивает writer.
Нужны independent native identity, fresh loaded membership/runtime status
на существующем shared owner, bounded latest-turn metadata и
`turn/steer(expectedTurnId)`. Idle/unknown ownership закрывается отказом.
Настроенный путь без business proof не объявляется поддержанной capability.

Сборка **только leaf**, без старого `dist`:

```sh
NODE_OPTIONS=--max-old-space-size=768 node src/mesh/build-peer.mjs
NODE_OPTIONS=--max-old-space-size=768 node src/mesh/build-peer.mjs .tmp/harness-mesh/singleton-peer.mjs singleton
```

Bundle и manifest содержат revision и SHA-256 своих source inputs. Регистрация
child — через supported `mcp_manage upsert` на точном target host, затем
`status → mcp_tools → mcp_call mesh_snapshot`. Публиковать только проверенный
main candidate после owner integration. Existing singleton server-100
подключает Root-owned `registerHarnessMeshTools(server,{adapters})`.

До controlled singleton reload использовать `singleton-peer.ts`: stdio leaf
инициализирует MCP Client к **существующему** `127.0.0.1:18787/mcp`, проверяет
реальную `tools/list` схему `list_agents`/`send_message(inputId)` и делегирует
их текущему native owner. Он не импортирует или создаёт adapter/controller,
не запускает inference при snapshot и не выкатывает старый `dist`.

## Первая приёмка и продолжение

Первый slice: настоящие IDs server-100/server-88 и положительная доставка
**88 → 100** через existing shared native owner100. Это ещё не полная взаимная
сеть. На88 отсутствие verified shared control остаётся явным ограничением;
ремонт — inventory → existing Fleet/native owner → documented shared-control
configuration → same-ID business proof, без private writer/fork/core drift.

Mac `127.0.0.1:18787` — SSH-forward к server-100 (PID36261, проверено09.10);
он не является Mac native peer. Перед регистрацией нужны местные host proof
и native IDs. MiniMax Code поддерживает официальную ACP точку `mcode acp`
([официальный README](https://github.com/MiniMax-AI/minimax-code/blob/main/README.md));
установленный Desktop/сломанные старые symlink/пустые connector session tools
не доказывают доступность ACP к текущему `mvs_*` ID. Repair plan: официальный
launcher → initialize/capabilities → session/list/load с тем же Desktop ID →
native receipt/no replay; unsupported RPC не использовать.

Native shared-control contract:
[Codex App Server](https://learn.chatgpt.com/docs/app-server).

Проверки: fast unit и focused integration в `tests/harness-mesh*.test.ts`,
ordinary общий deadline180s, Vitest1worker/Node old-space768MiB. Long host
matrix — slow nightly через существующие finite per-host queues;
реальный consumer обязателен отдельно от unit GREEN.
