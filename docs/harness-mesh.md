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
- Обычный snapshot содержит capability и короткий reason без повторяемых
  repairPlan. Отсутствие harness в limited singleton-окне означает
  `not_observed/outside_snapshot_window`; подтверждённая native ошибка —
  `unavailable`. Incomplete read без limited даёт `native_discovery_incomplete`.
- Внешний peer: явные MeshSession fields и известные harness capabilities,
  ≤32 входных capability rows/9 разных harnesses. title≤160/model≤128,
  status≤32/lastActivity≤64/project.source≤64/reason≤96. Identity и cwd не
  обрезаются: неверный тип, control chars, identity>512/harness>64/cwd>4096 или
  относительный cwd отклоняются с `invalid_peer_session` и incomplete.
  Фильтрация unknown/duplicate capability, invalid enum и overflow тоже partial;
  peer rows сверх limit дают limited/incomplete даже при upstream complete:true.
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

Перед регистрацией проверить **точный executable** Node: на100 `/usr/bin/node`
оказался12.22.9 и не разбирал bundle, рабочий `/usr/local/bin/node` —22.22.2;
на88 `/usr/bin/node` —22.23.1. Для singleton HTTP-клиента под AS2GiB нужен
`--disable-wasm-trap-handler`, иначе Undici не может зарезервировать Wasm memory.
Остальные bounds: old-space256MiB, V8pool1/UV2, CPU60s, fd128, file16MiB.
Если supervisor запускает child через sudo, сохранить только явно перечисленные
несекретные owner/sender/UV env через `--preserve-env`; чужие services не менять.
Discovery `online` означает наличие route/config, а не successful tools/list;
при EOF сохранить startup stderr и исправить собственную child definition.

До controlled singleton reload использовать `singleton-peer.ts`: stdio leaf
инициализирует MCP Client к **существующему** `127.0.0.1:18787/mcp`, проверяет
реальную `tools/list` схему `list_agents`/`send_message(inputId)` и делегирует
их текущему native owner. Он не импортирует или создаёт adapter/controller,
не запускает inference при snapshot и не выкатывает старый `dist`.

Первый relay ограничен доказанным server-100: approved registration задаёт
`HARNESS_MESH_OWNER_HOST_ID`, `HARNESS_MESH_OWNER_PID`,
`HARNESS_MESH_OWNER_ENTRY`, `HARNESS_MESH_OWNER_START_TICKS`.
До MCP bootstrap/read/send проверяются реальный hostname/Linux и один
IPv4-listener строки `ss` на **том же loopback адресе/порту**, PID, entry и
время рождения процесса. Mac forward не проходит эту проверку. Legitimate
PID change требует новой owner pin; до него новый input — proven
`not_attempted`, а сохранённый admitted/UNKNOWN возвращается без повторного
native чтения/вызова.

`HARNESS_MESH_ALLOWED_SENDER` закрепляет один проверочный native actor88.
Без него mutable capability закрыта. Live старый owner не имеет отдельного
mesh budget/native-attribution seam: relay не посылает fake native ID,
не меняет human origin/harness и явно оставляет native attribution unavailable.
Старый unknown-sender bucket даёт более строгие **6 сообщений на цель/минуту**.
Правильный optional structured meshSender API отдельно разрешён в owning
definitions/handlers, source-only после первого slice; activate только при
следующем согласованном owner release. Interim не означает полную сеть.

### Structured sender API — source only

`send_message.meshSender` необязателен: `{hostId,harness,nativeSessionId}`.
Пределы512/64/512 символов, без ASCII control chars; это объявленная
атрибуция и ключ бюджета полного адреса, не authentication или native capability.
Отправитель, включая `minimax-code`, не ищется через local `getSession`.
Legacy `fromSessionId/fromHarness` сохраняют прежнюю проверку, когда meshSender
отсутствует; при meshSender объявленная атрибуция имеет явный приоритет.
Mesh-сообщение не может заявлять `humanRequested:true`; STOP и UNKNOWN/no replay
сохраняются. Local mesh больше не создаёт synthetic native sender ID.
Этот API активируется только следующим разрешённым owner release;
действующий thin relay продолжает ONEactor/sixTarget, его runtime не менялся.

Exact live preflight `rate_limited` JSON и `Session 'id' not found.` остаются
retryable `not_attempted`; явный matching-ID admitted:false без uncertain
flags также. `admissionUnknown`/`nonRetryable` mixed flags и lost/ambiguous
failure остаются UNKNOWN/no replay. Legacy textual HUMAN_STOP_MESSAGE пока
консервативно UNKNOWN: native-attributed structured seam — следующий release.

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

### Fleet cabinet slice (2026-10-10)

The cabinet reuses GPTAdmin's existing registry and child MCP relay, rather than a search API or another node registry. Expected hosts are display policy only: a configured route does not prove native ownership or availability. Each local Herder must answer `fleet_node_info` with its actual OS hostname/user before its sessions or creation capability are accepted. A forwarded Mac endpoint returning server100 is rejected.

Owned exports for the sole integration/runtime executor:

- `src/mesh/fleet-service.ts`: `FleetCabinetService({hosts,scope,transportFactory,journalPath})`. `scope` is immutable authenticated `{profileId,userId}` supplied by server code. The factory receives `{profileId,userId,hostId}` and must create a separate authenticated transport per context. Never share mutable MCP session headers or credentials across contexts.
- `src/mesh/fleet-api.ts`: `createFleetApiHandler(serviceOrAuthenticatedRequestResolver, localHostId?)`, called **after existing authentication**. It returns `Promise<boolean>` indicating whether it handled the request. GET `/api/fleet/hosts` returns `{hosts,complete,defaultHostId,scopeKey}`; `scopeKey` is an opaque browser storage partition, not a credential. GET `/api/fleet/sessions?hostId&limit` returns `FleetView` with a global window of 1..12. POST `/api/fleet/create` accepts only `{hostId,harness,name,cwd,model?,inputId}` and returns a `FleetCreateReceipt` (201 created, 202 unknown, 409 not attempted). The browser cannot choose profile/user. Responses are no-store.
- `src/mesh/fleet-node.ts`: `registerFleetNodeTools(server,{adapters})` attaches `fleet_node_info` to the existing controller without launching native processes. Existing `registerHarnessMeshTools` provides bounded `mesh_snapshot`; existing `create_session` owns native creation. The full node entrypoint remains freshly built published `dist/index.js`, not a private controller fork.
- `src/web-ui/fleet/FleetCabinet.tsx`: `FleetCabinet({defaultHostId?,onSelectSession?,client?})`. A selected remote session carries `key=JSON.stringify([hostId,harness,nativeSessionId])`; integration must not pass it into a local-only composer without routing to its host. With no selection callback, the component links to the registered host's individual UI and native session hash. Existing outbox, pins, STOP/cancel and delivery controls remain owned by their existing UI hooks.

Remote nodes use `AGENT_HERDER_WEB_HOST=127.0.0.1`, `AGENT_HERDER_WEB_PORT=18789`; preserve existing HTTP token guards. M1's loopback18787 is the existing SSH forward to100 and must remain untouched. The integrator owns runtime deployment, protected service credentials and four ingress aliases. This source slice does not claim deployed daemons or mutual transport coverage.

Discovery uses three read workers, per-read5s and overall30s, at most256 registry entries/five expected hosts. Missing/error peers retain prior fetched/expires timestamps, become explicitly stale and lose creation capability. Current project is authoritative `currentCwd` only; unverified remains null, launch directory is displayed separately. External session extras/transcripts are excluded.

Creation requires a configured durable journal. Before mutation it writes UNKNOWN; replay/restart returns existing receipt before any read or native call. A native success must provide the requested harness, native session ID and canonical absolute cwd. Lost/ambiguous responses remain UNKNOWN and never replay. The browser persists its pending intent in an opaque authenticated scope before POST; restoration is GET-only and blocks fresh submission while unresolved. It does not automatically retry failed creation. Initial host selection follows the local node; refreshing a remote filter preserves it.

Checks: focused integration `harness-mesh-fleet` and `harness-mesh-fleet-api` detect wrong forwarded owner, stale freshness, merged overflow, creation identity mismatch, durable UNKNOWN/no replay and real HTTP/MCP envelope behavior (expected3s, max30s each). Fast unit `harness-mesh-fleet-intent` detects browser reload replay and profile isolation (expected1s, max10s). Ordinary release total remains ≤180s; UI/native consumer acceptance is still required after the sole executor integrates hooks.

The concrete factory may use `FleetGptAdminTransport` from `src/mesh/fleet-gptadmin-transport.ts`: `{endpoint,headersProvider}` comes from the sole executor's existing protected ZCode GPTAdmin config, memory-only, bound to the verified SSO roomhacker identity. It calls the tenant facade's `discover`, `schema`, `execute` and bounded `job` reads; it never calls Hub admin tools directly, mints tokens, borrows GrepMesh keys or retries mutations. Node identities remain independently checked. Supply `credentialGeneration` to `FleetCabinetService` when making a factory context, recreating the service if the authenticated client/generation changes. It does not partition durable intent identity by rotating credentials. Scoped mutation digest is64chars, below facade idempotency200 limit. A cached GET window lasts15s; explicit refresh uses `/api/fleet/hosts?refresh=1`, and creation always performs a fresh preflight.

Actual tenant-facade read consumer exposed an undersized3s metadata budget: discovery2.284s succeeded but schema timed out. Retained failure receipt; a finite5s/read consumer completed discovery3.855s, schema2.792s and registered100 snapshot3.837s (10.487s total, actual host/native IDs, partial). Fleet defaults therefore use5s/read and30s overall discovery, three workers; creation remains30s and UNKNOWN never replays. This is registered metadata evidence, not a created-session/UI receipt.

For creation, a forced selected-host preflight inspects only the target, independent of unrelated pending global reads. Atomic publication marks expired earlier peer results stale without renewing timestamps. A monotonic private read revision assigned before any request prevents delayed global results from restoring an older owner generation or creation capability after a newer target proof.
