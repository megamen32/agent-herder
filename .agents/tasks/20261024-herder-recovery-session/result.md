# Codex → Mavis C2: восстановлено

## Продолжение: связь доступна, Astra input остаётся UNKNOWN

**Новая отправка не выполнялась.** Первый live reverse SSH probe уже успешно прошёл без ремонта: `127.0.0.1:2222`, exact `MacBook-Pro-User.local / MacBook-Pro-User / MacBookPro18,2 / arm64`. Причина прежнего SSH255/banner timeout по имеющимся данным не установлена; самовосстановление доступности не означает исправленную доказанную причину.

Первым native действием прочитан exact C2 `mvs_f70ce650bbf94d789e4e4a2669f6743a`: metadata200, current controller200/state2 на 2026-10-23T23:51:42Z. Последние native messages относятся к новому turn `turn_8cddb244-b825-470f-a7d9-3a62964185c3`; прежний turn `1ee9a5b2-0dea-482d-b749-68c61b1e86c9` не принимался за текущий и не активировался. Три bounded native health reads на протяжении20s вернули200/state2,859/13/29ms. Эти измерения доказывают текущее окно здоровья, не бессрочную устойчивость reverseSSH.

### Точный readback неизвестной Astra отправки

Input `exmanager-c2-astra-narrow-release-20261024-r1`, архивный attempt23:44:38.055Z, **сохраняет UNKNOWN/retryablefalse и не повторяется**. Archived writer кодирует logicalinput буквально в содержимом (`inputId: ...`); отдельный native inputId/idempotency header не передавался. SHA256 сохранённого native payload: `95d076eea79c412160a529242a33a12a535c88a6e125e274f561eacc4ea66d25`. Native queueItemId не был записан в потерянной квитанции.

Проверены40 native-visible messages exact этой сессии; первый/последний row timestamps23:18:49.893→23:51:09.592Z пересекают попытку23:44:38, совпадения logicalinput в content/metadata нет. Порядок провайдера — rowid, не сортировка timestamp. Независимый последующий read40 имеет min/max22:29:15.194→23:54:46.297Z и тоже не содержит exactinput. Проверенная текущая очередь содержит один item `queue_42d98f15-7824-447a-8dcf-183795607498`, совпадения input нет. Старшие страницы существуют, но новейшая contiguous provider page уже пересекла timestamp попытки, поэтому дополнительную историю не сканировали. Это отсутствие в указанном наблюдаемом scope, **не NOT_SENT и не разрешение повторить UNKNOWN**. Native anchor, queue receipt или ответ C2, однозначно привязанный к этому Astra input, не найдены; его принятие/исполнение не заявляется.

### Рабочий существующий маршрут

Remote `agent_info({harness:"minimax-code",hostId:"MacBook-Pro-User.local",sessionId:"mvs_f70ce650bbf94d789e4e4a2669f6743a"})` вернул exactC2/running/native_active_turn/steer capability. Installed registered-peer exact route разрешился read-only за16.751s, writerCalls0, без500-session discovery. M1 ownerHTTP MCP `http://127.0.0.1:18789/mcp` предоставляет `fleet_session_view({harness:"minimax-code",sessionId:"mvs_f70ce650bbf94d789e4e4a2669f6743a"})`; данные лежат в `structuredContent`, text content — только label. Connected server100 `fleet_session_view` owner-local и не имеет hostId: его identity_mismatch не доказывает недоступность M1.

Supported send capability проверяется existing schema/adapter native queue-item steer и current native controller, **без фактической отправки**. Existing `mesh_route` с exact runtime host/native ID сохраняет native identity, model policy, HumanStop и ledger; accepted/UNKNOWN не replay. Ни Astra input, ни прежний owner-directive здесь не отправлялись.

В connection/readback фазе checkout/remote616312f и installed1001deb355/M1cbc4cc2 были предыдущими реализациями; source/runtime/config/SDK/GUI/jobs не менялись для восстановления связи. Последующее отдельное поручение про defaultsteer выполнено ниже как отдельный owned delta. Никаких новых сервисов, сессий, маршрутов, портов или deploy/sync не создавалось. Добавлены только bounded read receipts и этот append. Отчёт ниже относится к прежней успешно принятой owner-directive и не превращает новый Astra UNKNOWN в delivered.

Evidence: `evidence/connection-continuation-{native-first-read,input-mapping,input-coverage,health,route-capability,owner-view}.json`; independent continuation review отдельно.


## Дополнение пользователя: steer по умолчанию для обмена

Source `b8f8470a69aa46bc0f848b813a17a2b91ee35c18` опубликован в main. До изменения Zod `SendMessageSchema.mode` и legacy schema указывали `sync`; обычный automatic handler уже ограничивал delivery текущим активным turn и принудительно использовал steer. Теперь фактический schema default — **`steer`**, а описание рекомендует обычный обмен с явным `mode:"steer"`. `queue` описана только как намеренно отложенная работа после текущей: ожидание может длиться часами, это не немедленный обмен. Explicit `queue`/`sync`, HumanStop, active-turn-only, inactive/no-wake и humanRequested authorization guards не менялись. В `mesh_route` не добавлялся mode: описание честно поясняет native MiniMax active-turn steer и отсутствие этого параметра.

Owned production paths: `src/mcp-tools/definitions.ts`, `src/mcp/session-tools.ts`, `src/mesh/register-tools.ts`. SDK, native controller, C2 jobs, ExManager и LHC не изменялись. Focused `tests/send-message-default.test.ts` сначала дал RED2: omitted Zod mode и legacy default были sync, ожидался steer. После минимальной правки18/18 tests GREEN вместе с existing inactive/HumanStop admission tests; TypeScript noEmit GREEN. Tests используют isolated mocked adapters; реальных C2 POST/send нет.

Installed отдельно: server100 и M1 current/config **b8f8470**, surgical5hunks только трёх JS modules на собственных фактических baseline1deb355/cbc4cc2; protected settings сохранены, import smoke и CAS выполнены. Один controlled restart Herder на каждом owner, без restart GUI/native SDK и без изменения очередей. Старые immutable payload bytes сохранены rollback recipe; doc publication не вызывает повторный restart.

Actual fresh MCP `tools/list` readback: server100 `2026-10-24T00:01:53Z`, M1 `00:01:55Z`; оба публикуют `send_message.inputSchema.properties.mode.default = "steer"` и новые descriptions с explicitsteer/queuehours. `mesh_route` по-прежнему не имеет mode parameter. Это source/test/installed-schema proof; **новой фактической отправкой default не проверялся**, Astra UNKNOWN остаётся UNKNOWN и не replay. Evidence: `evidence/steer-default-schema-{owner100,m1}.json`, `evidence/steer-default-installed-{owner100,m1}.json` (actual changed-module set и settings hash comparison), delivery recipe `delivery/steer-default/`.

Ниже сохранён прежний результат принятой owner-directive; его DELIVERED не относится к Astra UNKNOWN.

Статус: **DELIVERED**, все 3 листа завершены. Source/tests, installed runtime и фактическое исполнение C2 подтверждены отдельно. Полные сообщения, команды C2, результаты инструментов и транскрипты не публикуются; ниже отдельно разрешены три коротких post-send фрагмента.

## Что C2 прямо подтвердил после отправки

Короткие дословные фрагменты существующих ответов, разрешённые владельцем отдельно для этого результата:

- Assistant `975e6145-b04c-4be4-b70f-852a013a662d`, 2026-10-23T22:20:17.170Z: «Принял прямое поручение.»
- Assistant `f5c70901-bbc7-4a70-843b-29d1b31d56b2`, 2026-10-23T22:21:24.581Z: «Handoff прочитан.»
- Тот же assistant: «Сверяю канонический generation14 с тем, что я опубликовал».

Оба ответа относятся к turn `1ee9a5b2-0dea-482d-b749-68c61b1e86c9` после нового input `exmanager-c2-owner-directive-20261024-herder-01a16987-r1`. **Отдельного явного подтверждения роли единственного владельца следующей установки/sync в этих фрагментах нет.** C2 прямо принял поручение в общем виде, подтвердил чтение handoff и назвал текущий шаг — сверку canonical generation14 с ранее опубликованным состоянием. Установка/sync ещё не объявлена выполненной; отдельный блокер не назван.

Фактические read receipts того же native assistant: `call_function_szyovdazzffn_1` — handoff, `call_function_szyovdazzffn_2` — существующий общий чат, оба exit0. Второй результат содержит ID существующей записи `lhc-1.4.0-release.json`. Это доказательства успешных чтений; они не подменяют отсутствующую отдельную install/sync-формулировку.

## Действующий общий канал и способ связи

Существующий общий межагентный канал — **server-100 `/home/roomhacker/.agents/shared-session/chat`**. С M1 он доступен через уже настроенный `server100-codex` SSH; SHA256 выбранного файла `lhc-1.4.0-release.json` на обеих сторонах совпал: `520357b98ce646000b4f18c14f716c6fe12adaf833a1594c034df0031fce8ee0`. Штатное чтение на server100: `lhc_chat.py --system read --reader <native-session-id> --limit 5` из установленного LHC1.5.44 `common/tools`. Новый чат на M1 не создаётся.

Для адресной связи восстановлен штатный Herder `mesh_route`: target `{hostId: "MacBook-Pro-User.local", harness: "minimax-code", nativeSessionId: "mvs_f70ce650bbf94d789e4e4a2669f6743a"}`, проверенный sender и уникальный stable `inputId` на одно новое логическое сообщение. Registered peer/schema/owner/exact native identity проверяются до writer; текущий native Running получает штатный queue-item steer, idle — queue. Accepted/UNKNOWN не повторяются и не отправляются другим fallback. Этот результат не требует новых сообщений C2 или finder.

## Source и проверки

- `8ba4233`: live exact-ID metadata/current-controller/messages и независимый native observer вместо legacy history scan. Offline disk fallback сохранён; тестовые offline stores имеют explicit missing manifest.
- `5212b9d`: regression quick details: нельзя предпочитать legacy inventory или сканировать чужие сессии. M1 получил уже существовавший canonical supervisor prerequisite, которого не было в его baseline9cff.
- `cbc4cc2`: active-aware supported steer по независимому CURRENT native Running; idle остаётся queue. RED1→GREEN, один writer без fallback/replay. HumanStop, policy, notes и durable ledger сохранены.
- `1deb355`: targeted registered-peer schema + owner identity + exact readSession вместо полного mesh snapshot для известного native адреса. Неправильный host/ID/harness не доходит до writer.
- Mandatory initial RED4; focused native25/25 и routing20/20 GREEN; TypeScript noEmit GREEN. Исходные проверки и дополнительные counterexamples описаны в independent-review.md.

## Publication receipt

Source commit `1deb35553bc0836a583ee19681b6a262932f287b` и его три предыдущих owned commits опубликованы в `origin/main`. Первичная публикация 30 sanitized task artifacts: `2201645`. Последующий разрешённый excerpt — только документационный delta; runtime не перезапускается из-за изменения отчёта. Source publication не подменяет installed и consumer receipts ниже.

## Installed

Server100: `1deb35553bc0836a583ee19681b6a262932f287b`, surgical router delta на фактическом baseline2a438e0. M1: `cbc4cc2fbbf0635258e550f760ecb8350568c9d2`, surgical exact-read/observer/steer и существующий supervisor prerequisite на фактическом baseline9cff. Settings и чужой payload сохранены; immutable copy unlink-before-write, import smoke и CAS current/config/ExecStart выполнены. Менялся только Herder; GUI/native Mavis, queued jobs, модели и ExManager source/deploy не менялись.

Независимые affected reads: agent_info exactC2/running/native_active_turn; M1 HTTP MCP fleet_session_view exactC2/exmanager/history available; installed exact-route preflight6.33s с writerCalls0 и без mesh_snapshot. `fleet_session_view` без hostId — owner-local tool; server100 local call не заменяет M1 owner read. GPTAdmin alternative transport не объявляется исправленным: проверен фактически выбранный FleetDirectTransport.

## ONE directive: native и consumer

Exact target: `MacBook-Pro-User.local / minimax-code / mvs_f70ce650bbf94d789e4e4a2669f6743a`.

New logical input: `exmanager-c2-owner-directive-20261024-herder-01a16987-r1`.

Первый bootstrap вернул NOT_ATTEMPTED/retryabletrue до writer. После ремонта тот же logical input прошёл один фактический mesh_route writer: ADMITTED/retryablefalse, current turn `1ee9a5b2-0dea-482d-b749-68c61b1e86c9`. UNKNOWN/admitted повторов и native fallback sends нет. Native queueItemId квитанция не экспортировала; его не выдумывали. Доказаны exact native user anchor и actual current turn.

- New user anchor: `msg-user-v1-L5RgDPWF7UgAZy-XJs0BG3E65toLTGmxaTWhfSnE1mk`, sourceapi, 2026-10-23T22:19:10.864Z; content SHA256 `4245a7206fc02eb864e44db0da38cc750f922a2296e12301a24c205e74f980a5`.
- Own C2 acceptance: assistant `975e6145-b04c-4be4-b70f-852a013a662d`, 22:20:17.170Z, same turn. Exact native resource calls `call_function_szyovdazzffn_1`/`_2` прочитали handoff и существующий общий system chat; оба exit0.
- Shared record actually read: `lhc-1.4.0-release.json`, existing `/home/roomhacker/.agents/shared-session/chat` через действующий `server100-codex` SSH. Mac/server100 same-file SHA ранее проверен. Новый chat/config/subscription не создавались и не заявляются.
- Own C2 next-step reply: assistant `f5c70901-bbc7-4a70-843b-29d1b31d56b2`, 22:21:24.581Z, same turn; подтверждены past handoff read и следующий шаг — сверка canonical generation14 с опубликованным состоянием. Отдельного final plain ACK/chatID не требовали и завершения ExManager deploy не ждали.

Это admission → exact anchor → own acceptance → два реальных успешных чтения → собственный следующий шаг, а не queue ACK. Independent consumer PASS, reviewer sends0.

## Сохранённые границы

Старый `exmanager-c2-native-deploy-handoff-20261024-r1` UNKNOWN не повторён. Три прежних queued item до/после сохранены, их payload не читался/не менялся. Людям сообщений/звонков ноль, дополнительных native content sends ноль. В каноническом main опубликованы только owned source/tests и этот task; чужой WIP/index сохранён. No branch/worktree created. Source and task publication do not imply whole checkout clean.

Evidence: evidence/one-authorized-*.json, evidence/directive-native-anchor.json, evidence/installed-*.json, evidence/native-{before-send,after-one-writer}.json, independent-review.md и independent-c2-*.json. Failure shield: root-cause-map.md.
