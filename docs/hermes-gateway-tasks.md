# Настоящий диалог Hermes через домашний топик

Явно выбранные Hermes tasks используют existing authenticated agent-resume
ingress `127.0.0.1:18791/v1/agent-resume/task`. Default incident repair route
OpenCode/MiniMax не меняется. `AGENT_RESUME_HERMES_TOKEN` берётся из existing
protected process environment; новый secret store не создаётся. Отсутствие
verified auth/config отказывает до named binding, не запускает CLI fallback.

`HermesAdapter.createSession` создаёт логическую named binding, а не новый native
chat: session ID Herder — настоящий Gateway **session key**, metadata содержит
`nativeSessionId`/`sessionId`, `origin` (с thread_id) и отдельно selected/effective model.
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
`pre_llm_call` подтверждает exact SID/marker/turn и modelAtAdmission и задаёт task CWD через
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
request model с selected Gateway intent отказывает до отправки.

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
`20260909_220106_70ff6a6b`, selected override `glm-5.3-flash`/`zai`; actual consumer затем подтвердил
fallback `MiniMax-M3`/`minimax`. Selected не выдаётся за actual execution. Root повторяет эту проверку перед
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
Peak589008896 bytes/swap0/OOM0; generation-specific cleanup PASS.
Предыдущий f93 manifest ошибочно называл обновившийся remote ref9749a68
включённым ancestor; фактически тогда был включён только6d494c8. Ошибка
ancestry найдена независимым review и исправлена настоящим merge9749a68.
`git merge-base --is-ancestor 9749a68 HEAD` теперь0, UI diff к9749a68 пуст.
Полная итоговая closure после этого merge пересобрана за34.695s; evidence и
актуальный source/dist manifest: `.tmp/hermes-home-ready-merged/`.
Старый manifest помечен superseded; он не является final installation input.
Все correction checks/builds с setup укладываются в отдельный180s deadline.
Unused старые copied UI bundles перенесены из **owned** dist в private evidence,
сохранены побайтно; canonical/runtime dist не тронут. Source manifest содержит
318 текущих compiled/backend/declaration/UI files и SHA256 каждого.

Точные frozen SHAs после публикации передаются Root. Это готовность source/plugin;
services, совместная установка и настоящий Telegram task dialogue/recipient
acceptance принадлежат Root. Canonical runtime100 не собирался/не перезапускался
этим владельцем; все builds выполнены только в owned Herder worktree.

## Исправление actual model после native fallback

Gateway session.model показывает только persisted effective runtime core; выбранная
модель отдельно в meta.selectedModel/selectedProvider. Runtime имеет явный scope
last-session-runtime. Named runner и changeModel проверяют selected intent,
не переключают provider из-за effective fallback.
Receipt.modelAtAdmission — модель prologue, receipt.model неизвестен до exact
successful native post_api_request. Наблюдение session_id+turn_id сохраняет
actual model/provider в durable effectiveModel; human follow-up не меняет старую
receipt. Legacy receipt без такого evidence не backfill из последней сессии.
Admission-only pending/completed flags не изменены; original accepted native
input и bootstrap не повторяются. Installer добавляет supported post_api_request
hook. Root проверяет совместимость после official update, затем устанавливает
plugin/reloads самостоятельно; source owner runtime не меняет.

| Проверка | Назначение/дефект | Категория | Ожидаемые/max секунды |
|---|---|---|---|
| Official post-response producer → original HTTP/DB receipt | Selected GLM vs actual MiniMax fallback, exact turn, restart/legacy/no replay | focused integration | 1/5 |
| Production named runner → adapter HTTP | Selected intent принимается при другом effective model без provider switch | focused integration | 1/5 |

Model delta evidence (12.10.2026): `.tmp/hermes-effective-model-final/` содержит
полный production build и8/8 Vitest +12 Python scenario PASS. Aggregate runner
завершился FAIL на import PyYAML для installer: параллельный официальный updater
менял Hermes venv. Этот исторический FAIL сохранён. Installer и migration старой
admitted SQLite row затем отдельно2/2 PASS системным Python с existing PyYAML,
evidence `.tmp/hermes-effective-installer-delta/`; зависимости не устанавливались.
Итого проверены8 Vitest +14 Python scenarios,54.714s bounded windows включая setup
(+0.1s initial registered-budget refusal; затем применён прежний budget).
CPU1/RAM2GiB/tasks128/swap0/OOM0; peak579252224bytes, cleanup PASS. Broad suite
не повторялась. Exact producer hook / core metadata sources на c573316 остались
побайтно неизменны во время checks; официальный updater остаётся runtime owner.
Published main774eebf действительно merge ancestor, foreign UI diff пуст.
Final source/dist manifest: `.tmp/hermes-effective-model-final/build-source-manifest.json`.

Final model-schema delta: unknown plugin model:null нормализуется adapter в
отсутствующее optional AgentSession.model; MCP z.string().optional не получает
null и selected не подставляется. Адресный regression1/1 PASS (7 других tests
отфильтрованы, не заявлены заново) + полный production build39.450s executable,
43.225s с setup. Evidence `.tmp/hermes-effective-schema-delta/`.
Final cumulative checked coverage9 Vitest +14 Python scenarios; bounded windows
97.939s +0.1s initial budget refusal, max180s. Peak693080064bytes/swap0/OOM0.
Final manifest указывает именно последнюю schema-delta compiled closure и
сохраняет ссылку на исходный failed aggregate. Только own branch dist построен.

## Существующий launch result contract

`NamedSessionResult.model` в `createNamedSession/newOrResumeNamedSession` и JSON
MCP `create_session/new_or_resume` исторически означает model из launch request.
Это requested selection, **не actual execution evidence**. Для всех harnesses
это поле сохраняет прежнюю семантику; новые поля и переименование не добавлены.
Даже accepted_unconfirmed с model=GLM не доказывает ответ GLM после fallback.
Для Hermes actual per-turn evidence — только protected delivery receipt
`model/effectiveModel` от exact native post_api_request; `modelAtAdmission`
показывает prologue отдельно. Session.model относится к last-session-runtime,
а meta.selectedModel — к выбранной настройке. Unknown actual не подменяется
launch result.model или выбранной моделью. Поля execution_identity нельзя
заполнять requested model под видом actual executor model.
Последующий reviewer снял named-result blocker после проверки исторического
контракта; runtime/API fix для этого seam не выполнялся. Это docs-only delta
поверх0fc8b5a, уже проверенные source/dist остаются побайтно теми же.
