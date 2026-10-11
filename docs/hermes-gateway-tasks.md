# Настоящий диалог Hermes через домашний топик

Явно выбранные Hermes tasks используют existing authenticated agent-resume
ingress `127.0.0.1:18791/v1/agent-resume/task`. Default incident repair route
OpenCode/MiniMax не меняется. `AGENT_RESUME_HERMES_TOKEN` берётся из existing
protected process environment; новый secret store не создаётся. Отсутствие
verified auth/config отказывает до named binding, не запускает CLI fallback.

`HermesAdapter.createSession` создаёт логическую named binding, а не новый native
chat: session ID Herder — настоящий Gateway **session key**, metadata содержит
`nativeSessionId`/`sessionId`, `origin` (с thread_id) и actual selected model.
Native SID в display URL также читается как exact alias **этого** home key;
доставка и query после lookup используют canonical key. Чужой SID отклоняется.
`findNamedSessions/getSession` восстанавливают binding через plugin ledger
после перезапуска Herder. Public MCP остаётся способом наблюдения.

Production named runner передаёт `expectedTaskBinding:{name,cwd,generation}`
из именно выбранного target receipt, включая cached target. Adapter не заменяет
его текущим именем другой задачи того же home key. Plugin атомарно сверяет
контекст с persisted binding до input reservation/native call. Mismatch —
`notSubmitted:true`; A→B→cached A/resolve A и ABA не меняют чужую CWD.
Для обычного home follow-up adapter явно получает fresh current binding; её
поколение проверяется тем же gate. Cache invalidation не используется как fence.

`sendMessage` использует stable inputId и поддерживаемый
`PluginContext.inject_message(content, session_key=...)`; отправка через
`messages_send` не используется для Gateway tasks. Existing source plugin
`agent-resume/hermes_gateway.py` резервирует input до native call, а registered
`pre_llm_call` подтверждает exact SID/marker/turn/model и задаёт task CWD через
поддерживаемый terminal override. Вызов не использует `/resume`, не вводит
сообщение в active CLI и отказывает при active writer/unconfirmed input.

Scheduling True не считается native ACK. HTTP ждёт actual prologue до 2 секунд,
Herder client ограничен 3 секундами. ACK возвращает `admitted:true,pending:true,
completed:false`: production named runner возвращает `accepted_unconfirmed`,
даже для sync mode, не выдаёт долгий LLM turn за завершённый. После неизвестного
приёма сохраняются `admissionUnknown/nonRetryable`; разрешён только query
`getMessageAdmission` того же input ID. Plugin restart не снимает fence.
Повтор совпадающего input/payload читает receipt, конфликт сохраняет оригинальные
admission flags. Native model не переключается молча; несовпадение explicit
request model с actual Gateway model отказывает до отправки.

Legacy bounded CLI transport доступен только при explicit adapter option
`gatewayTasks:false`. Home dialogue не выдаётся за dedicated
`healthRecovery` worker. Cancel/terminate/model-switch capabilities Gateway
отражают действительную поддерживаемую поверхность.

Root устанавливает **точный опубликованный** agent-resume source по
`agent-resume/docs/hermes-gateway-tasks.md`; scoped installer включает supported
`allow_gateway_injection` и exact home key. Canonical hermes-config source
содержит тот же grant. Live config не совпадает с историческим canonical
snapshot: installer сохраняет остальные live значения вместо замены файла.
Read-only binding 12.10.2026: `agent:main:telegram:group:-1004360838692:9` →
`20260909_220106_70ff6a6b`, persisted model `glm-5.3-flash`/`zai`; его нельзя
показывать как profile default MiniMax-M3. Root повторяет эту проверку перед
actual consumer canary. Source owner не устанавливает/restart сервисы.

## Notice display и original incident

Generic done/human/choice events содержат отдельный optional typed
`execution_identity:{harness,session_id,model?,cwd?,session_url?}`. Native URL
строго `https://agent.bezrabotnyi.com/#/session/` +
`encodeURIComponent(harness+":"+nativeID)`. Metadata сохраняется в existing
notification receipt и replay; длинный body её не обрезает. Технический
project `hermes` остаётся auth scope и не становится названием исполнителя.
Generic done имеет явный `event_type:agent.done`, кроме intentional override;
Notice не выводит завершение из title/body. Bound original health progress не меняется.
Invalid optional model/CWD опускаются; model/provider не угадываются.

Это display-only field, не launch/binding/auth authority. Sessions с явным
`noticeIncident` по прежнему обновляют original incident через existing durable
progress/question outbox. Generic done для них не создаётся; DELETE/reset
сохраняет binding (23c2fe4). Telegram transport реализуется Notice/нативным
Hermes adapter, новых Telegram API calls в Herder нет.

## Focused acceptance evidence

| Проверка | Назначение/дефект | Категория | Ожидаемые/max секунды |
|---|---|---|---|
| Existing Hermes CLI adapter | Сохранение явно выбранного legacy bounded worker | fast unit | 1/5 |
| Herder HTTP adapter + production named runner | Real key/SID, persisted lookup, ACK не completed, no CLI/model hijack | focused integration | 2/10 |
| Actual supported PluginContext + Gateway dispatch | Stored topic9/origin и strict native SID без core patch | focused integration | 3/15 |
| Authenticated existing aiohttp ingress | Native ACK менее1s при ещё работающем LLM, repeat один turn | focused integration | 1/5 |
| Plugin input reservation/restart/unknown/conflict | Unknown не replay; чужой payload не отменяет original admission | fast unit | 1/5 |
| Scoped installer | Exact source symlink, supported grants, прочие config values сохранены | fast unit | 1/5 |
| Herder → Notice08ed HTTP/DB/card worker | Long generic summary, executor/link отдельно, lost ACK/restart одна card | focused integration | 3/12 |
| Original bound card + DELETE/reset | Original binding/outbox, generic notify.send==0 | focused integration | 3/12 |

Final source run: production build, **24/24 Vitest + 11/11 Python checks**,
50.387s executable. Evidence `.tmp/hermes-topic-final/`; prior source run
`.tmp/hermes-topic-release/` 49.353s +23/11 checks, initial Python-only source
check `.tmp/hermes-task-check/` 10 checks. Initial missing-pytest setup failure
retained under `.tmp/hermes-task-red/`, not reported as RED/GREEN proof. Tests
use installed Hermes interpreter + stdlib fixture executor; no dependency
installation. CPU1, RAM max2GiB/tasks128/swap0, Vitest worker1; peak final
592719872 bytes, OOM0, generation-specific cleanup PASS. No broad/nightly suite.

После опубликованного main dfe79a9 выполнен полный build35.794s; evidence
`.tmp/hermes-topic-main-release/`. Дополнительный native-SID alias delta
скомпилирован/imported тем же TypeScript compiler, проверен одним targeted
Vitest и одним Python scenario. Failed CJS-format setup сохранён отдельно;
четыре filtered-out сценария не объявлены прошедшими заново. Первая ordinary
фаза: bounded windows с setup178.390s, начальный source-pin отказ0.954s;
deadline180s соблюдён, broad suite не запускался.

Независимый последующий review выявил CWD race в общем topic key. В отдельной
bounded correction phase включён опубликованный main976444c, выполнены полный
build и7/7 focused Vitest +12/12 Python за45.131s; real production named
runner→original plugin HTTP→atomic gate→terminal override доказывает, что stale A
не создаёт input/provider turn, а fresh follow-up сохраняет B. Evidence
`.tmp/hermes-binding-review-release/`. Финальный typed-done/coupled Notice226
проход и source/dist manifest — `.tmp/hermes-binding-typed-final/`.
Финальный проход: полный production build,17/17 Vitest +12/12 Python,
48.622s executable; обе correction runs вместе с setup103.983s, ниже180s.
Peak589008896 bytes/swap0/OOM0; generation-specific cleanup PASS. После
совместимого merge latest published main9749a68 runtime `src` pins целиком
совпадают с проверенными входами; дополнительные изменения только в owned
Root Mac watchdog/docs/tests. Повтор build не требовался.
Unused старые copied UI bundles перенесены из **owned** dist в private evidence,
сохранены побайтно; canonical/runtime dist не тронут. Source manifest содержит
318 текущих compiled/backend/declaration/UI files и SHA256 каждого.

Точные frozen SHAs после публикации передаются Root. Это готовность source/plugin;
services, совместная установка и настоящий Telegram task dialogue/recipient
acceptance принадлежат Root. Canonical runtime100 не собирался/не перезапускался
этим владельцем; все builds выполнены только в owned Herder worktree.
