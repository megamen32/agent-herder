# Agent Herder — самостоятельная Rust-first спецификация

Статус документа: нормативная спецификация продукта, 15 ноября 2026 года.

Этот документ определяет, что должен делать Agent Herder и как принимается готовый результат. Он не является планом LHC и не зависит от LHC runtime, публичной страницы LHC, plan.json или очереди LHC leaves.

Текущее устройство систем, разбор противоречий и целевые контракты собраны в [карте систем Agent Herder](system/README.md).

Исторические документы под .agents/tasks/20261107-herder-native-mcp-breaking/ сохраняются как источник происхождения решений и доказательств. Их оценки, волны и статусы не являются текущим планом исполнения. Текущий результат принимается по исходникам, тестам, immutable artifact, установленному runtime и независимому consumer readback.

## Цель

Agent Herder — единый MCP/application control plane для независимых harness instances и native sessions на нескольких нодах. Rust владеет доменными решениями, authority, durable intents, receipts, ACL, HumanStop, Tasks и recovery. Existing TypeScript adapters остаются временной compatibility границей, пока для конкретного harness не доказан Rust port.

Первый рабочий результат — один полностью доказанный OpenCode vertical slice с детерминированной loopback fake model. После него расширяется общий cross-host mesh и подключаются следующие adapters. Полный перенос всех adapters не должен задерживать первый работающий путь.

## Источник истины и границы

- Рабочая ветка — main, синхронизированная с origin/main.
- Product contract находится в этом документе и в проверяемом исходном коде.
- Receipts и evidence должны ссылаться на source SHA, artifact digest, installed runtime и consumer result.
- Старый LHC plan, его граф и leaves — архив решений и исторических обязательств. Они не назначают работу и не являются критерием текущего vertical slice.
- OpenCode V1 не поддерживается.
- Незавершённые Go adapters не входят в active registry.
- ChatGPT, Z.ai и browser lanes не считаются готовыми по наличию в каталоге. После закрытого общего Rust-контракта их реальные adapter lanes являются P0: каждый должен получить отдельный capability и consumer proof.
- Целевой browser runtime использует собственное расширение Agent Herder с прямой связью с Herder. Bezbrowser — необязательный инструмент разработки и отладки; UserIO сохраняется для legacy compatibility.

## Текущий приоритет исполнения

Этот порядок заменяет старые LHC waves, leaves и исторические acceptance-матрицы. Он выбирается по бизнес-результату: реальные Codex, ChatGPT и Z.ai должны видеть друг друга через Herder и обмениваться сообщениями между нодами и независимыми workspace.

Уже закрыто и не переоткрывается без новой причины: OpenCode fake-model slice VS01–VS07. Его ordinary-MCP receipts уже подтверждают exact native session, native messages, export, restart/readback без resend, same-key replay, changed-payload conflict, HumanStop и candidate cross-host stand на server-44. Этот slice теперь является regression gate, а не очередной волной разработки. Common export остаётся явно unsupported.

P0 состоит из двух параллельных результатов:

1. Реальная capability matrix и consumer proof для Codex, ChatGPT и Z.ai: readiness, list/discover, exact resolve, read messages, create если native harness это поддерживает, deliver/send, durable receipt, independent readback после restart без повторной отправки. Stop/permission фиксируются как available или explicit unsupported; наличие исходного модуля или tools/list не считается готовностью.
2. Настоящий cross-host обычный `deliver`: 100→44 и 44→100, точные host/harness/native session identities, sender attribution в durable receipt, отсутствие двойного эффекта, remote readback и peer visibility. Сессии в A и A/B — независимые сессии во вложенных workspace; они должны видеть и уведомлять друг друга в обе стороны. Это не parent/child lineage.

GPTAdmin modern stdio — отдельная consumer/infrastructure lane. Она нужна для одной проверки обычным потребителем, но не является причиной задерживать adapter readiness или Rust mesh. `automation` — один typed инструмент для будущих durable timer/schedule/autopilot/process waits; он не является механизмом общения между агентами.

После P0 идут resources/offline claims, cleanup после смерти owner, recovery receipts и проверяемая transcript/file projection. Затем закрывается modern automation control surface и выключаются/мигрируют старые cadence/resume-after записи. Незавершённые Go adapters остаются выключенными, а OpenCode V1 не поддерживается.

## Архитектура

    MCP / CLI / Web
          |
    application layer
          |
    pure domain decisions ---- durable SQLite store
          |                         |
    native adapter ports       intents / Tasks / receipts / holds / ACL
          |
    AHAP compatibility adapters -> OpenCode, Codex, ZCode, ChatGPT, Z.ai
          |
    native harness APIs on the owning node

Одна application boundary обслуживает MCP, CLI и Web. Один Herder process может содержать несколько HarnessInstance, у каждого свой profile, endpoint, authority и native connection. Session identity состоит из node_id + instance_id + native_session_id. session_ref — непрозрачный адрес durable записи.

Нода-владелец владеет session и её intents. Proxy маршрутизирует к owner и не создаёт вторую Task database или второй controller. Runtime cwd и Git worktree — разные поля.

Не добавляются distributed database, общий message bus, plugin framework, универсальный workflow DAG, автоматический NAT discovery или новый daemon только ради адаптера.

## Общий MCP catalog

Native catalog содержит четырнадцать типизированных инструментов. Схемы отдельных действий имеют discriminator и отвергают неизвестные поля.

| Инструмент | Контракт |
| --- | --- |
| discover | Ноды, instances, модели и проекты; capabilities, availability, permissions и freshness разделены. |
| sessions | Сессии, текущая работа, scopes, worktrees и полнота обхода. |
| session | Recent, context, messages, resolve, archive, register и workspace. |
| create | Создать сессию в точно указанном instance и вернуть native admission. |
| deliver | Доставить сообщение в exact session или reply_to, с явным режимом. |
| resume | Однократно продолжить exact session; HumanStop не снимается. |
| stop | Установить durable hold и запросить native interruption. |
| search | Поиск сообщений/сессий с cursor, source и coverage. |
| export | Native transcript export с полнотой и provenance; common export остаётся unsupported, пока отдельный нормализованный контракт не доказан. |
| automation | Typed schedule/autopilot rules через один executor. |
| resource | Global/project/node resource, descriptor, claim, renew, release, declaration. |
| configure | Ограниченный typed node/instance/session configuration с CAS. |
| permission | Exact native permission request и ответ на него. |
| human_request | Внешний вопрос с привязкой ответа к исходной session. |

Публичным универсальным путём доставки является обычный deliver. Внутренние mesh_deliver и mesh_route могут оставаться compatibility seams для старых peer-ов, но не требуются вызывающему агенту и не рекламируются как основной маршрут.

## Универсальный delivery contract

Целевой межхостовый envelope:

    {
      "target": {"hostId": "roomhacker-server-100", "harness": "opencode", "nativeSessionId": "..."},
      "sender": {"hostId": "server-44", "harness": "codex", "nativeSessionId": "..."},
      "inputId": "stable-id",
      "message": "bounded work delta"
    }

target.hostId выбирает ноду. Алиасы нормализуются до одной identity:

- 104.bezrabotnyi.com и remote-ssh-discovered:104.bezrabotnyi.com — roomhacker-server-100;
- 44.bezrabotnyi.com и remote-ssh-discovered:44.bezrabotnyi.com — server-44.

Поля sender являются attribution. Они не создают доверие. HTTP должен передавать проверенный owner-MCP auth metadata; owner-launched stdio имеет свою trusted boundary. Нода-назначение повторно проверяет exact host, instance, harness, native session и доступ caller.

Rust native endpoint обязан принять этот смысловой контракт либо дать проверяемый typed mapping к внутреннему session_ref/request_key. Простое переименование TypeScript tool без Rust-owned ingress не считается миграцией.

## Durable intent, receipt и UNKNOWN

До внешнего native вызова SQLite сохраняет principal, target, payload hash, inputId/request_key, intent и Task. Состояния:

    prepared -> dispatching -> admitted -> confirmed
                             |             |
                             +-> unknown   +-> rejected

Правила:

1. Один и тот же principal/target/key и тот же payload возвращает прежний receipt.
2. Тот же key с другим payload даёт idempotency_conflict до эффекта.
3. Потеря ответа после dispatching означает unknown, если точный native reconcile не доказал результат.
4. unknown остаётся техническим исходом продолжения. Herder передаёт следующее намерение в обычный контур доставки harness, а receipt, native history, audit и provider state остаются наблюдением и диагностикой.
5. TTL Task не удаляет dedup tombstone/receipt раньше безопасного срока.
6. accepted, Task terminal, MCP isError и ответ модели — разные факты и возвращаются раздельно.

Completion означает подтверждение admission native input/turn/queue, а не обязательно завершение ответа модели. Ответ модели доказывается отдельным readback.

## Fake-model vertical slice

Каноническая детерминированная модель находится в scripts/test-model-server.py. Она слушает только loopback, отвечает HERDER_TEST_MODEL_OK, поддерживает /v1/responses и /v1/chat/completions, streaming и non-streaming ответы, считает запросы через /_stats и не требует provider credentials или внешнего inference.

OpenCode fixture запускается через tests/native/ahap_opencode_stand.py и существующий AHAP OpenCode runner. Уже доказанные уровни нужно различать:

1. direct OpenCode + fake model;
2. AHAP TypeScript adapter + OpenCode + fake model;
3. Rust core + AHAP adapter + fake model;
4. обычный public MCP consumer;
5. установленный immutable artifact после restart;
6. независимый readback.

Уровень 1 не объявляет уровни 3–6. Текущий OpenCode stand уже даёт полезное
доказательство уровней 1–3 для основных сценариев, но vertical slice считается
закрытым только после уровней 3–6 и отдельных negative gates ниже.

Минимальный OpenCode acceptance:

1. создать или зарегистрировать одну disposable session;
2. выполнить две доставки с разными stable inputId;
3. получить native user/turn/assistant receipts;
4. прочитать обе роли по native IDs;
5. найти уникальный marker через search;
6. получить projects с явной provenance и partial/complete coverage;
7. выполнить native transcript export;
8. перезапустить Rust core и повторить readback без новой отправки;
9. подтвердить resend_count = 0;
10. проверить same-key replay: прежний receipt возвращается без нового native effect;
11. проверить changed-payload conflict до admission;
12. проверить HumanStop до admission и после restart;
13. повторить сценарий обычным MCP consumer против immutable installed artifact и
    сделать независимый readback;
14. common export должен вернуть явный unsupported до тех пор, пока common
    normalized contract не получит отдельное доказательство.

Существующий stand уже подтверждает пункты 1–9: create, две доставки, native
receipts, обе роли, marker search, projects provenance, native export, restart
readback и resend_count = 0. Это переиспользуемое evidence, но оно не закрывает
пункты 10–14 и не превращает source/stdio fixture в installed consumer proof.

## Functional adapter boundary

Domain functions получают immutable snapshots и clock values. Они решают decode, normalize, classify и dispatch plan без socket, SQLite, scheduler и глобального retry state. Stateful port владеет только native connection, stream cursor, process handle и сериализацией native writes.

Rust ports добавляются по одному adapter-у после доказанного общего contract. Existing TypeScript/AHAP adapter разрешён как compatibility port и не считается Rust adapter port.

## Resources and ownership

Один resource_ref может иметь scope global, project или node. Scope, attachment, authority и owner независимы. Claim/renew/release атомарны, проверяют claim_id, descriptor revision, expiry и owner. Один JSON owner descriptor и OS/file lock являются offline authority; второй owner store не создаётся.

Если MCP выключен, заранее установленный manifest позволяет свежему агенту проверить authority, увидеть отсутствие owner, выполнить atomic claim, сделать test release и прочитать receipt. Неизвестный или повреждённый manifest не означает свободный ресурс.

## Coordination and recovery

Коммуникация имеет три уровня: global projectless board, project/workspace board и direct session-to-session mail.

Для board используется один coordination-notes store. Global note не имеет hostId/cwd; workspace note имеет exact host/cwd. Вопрос имеет readBy и status. Если вопрос относится к текущей работе, агент после чтения отвечает и закрывает его по умолчанию. Чужой вопрос остаётся открытым.

Durable message хранит message_ref, sender, recipient, project/session identity, payload hash, input/receipt refs и timestamps. Transcript/file export является проверяемой projection: файл имеет path и digest, но не становится второй независимой очередью сообщений. После смерти Herder восстановление идёт по SQLite intent/receipt, authority manifest, owner descriptor и экспортированному transcript.

## Browser and external adapter boundaries

Маршрут ChatGPT и Z.ai через расширение использует уже авторизованный профиль Chrome. На server100 используется профиль сервера, а при доступном loopback расширение подключается к Rust по локальному WebSocket. Расширение Agent Herder само читает сайт и выполняет действия на нём. Bezbrowser используется при разработке и отладке. UserIO сохранён как совместимый маршрут для существующих профилей.

Единый Rust `SessionRecovery` решает, когда восстанавливать сессию, учитывает HumanStop и ожидающий запрос человека, сохраняет тот же чат и модель и не допускает fallback без явной capability. Расширение перед действием сверяет точный account, chat, failed turn и input. Любая техническая ошибка, включая unknown и потерянное подтверждение, передаётся в обычный контур доставки harness. Herder не вводит отдельный блокирующий gate для дублей.

CI для fake 429 должен проходить через собственное расширение и проверять HumanStop, pending request, устаревшую привязку, потерянное подтверждение и неудачный retry. Прямой CDP остаётся изолированным fixture. Это целевой контракт, а не подтверждение публикации; критерии выпуска описаны в [Browser chat adapters](browser-chat-adapters.md#production-route-through-the-extension).

Go adapters, незавершённые provider lanes и browser profiles без доказанного owner scope не входят в active registry. Capability без native evidence остаётся unsupported или unknown; имя harness само по себе capability не создаёт.

## Install, release and acceptance

Каждый release связывает source SHA, artifact manifest/digest, установленный runtime/PID, MCP revision и consumer receipt. Один reproducible build переиспользуется на нодах; старый runtime сохраняется для rollback.

Unit tests и source fixtures нужны для RED/GREEN, но не являются final acceptance. Final acceptance требует обычного MCP consumer, native IDs, readback после restart и независимого доказательства. HTTP 200, tools/list, healthy process или accepted request отдельно ничего не доказывают.

## Исполняемая последовательность

Текущий порядок работы, независимый от LHC:

1. Сохранять закрытый OpenCode VS01–VS07 как regression gate; не повторять его build/readback без нового source change или отдельного решения о promotion.
2. Параллельно закрыть реальные Codex, ChatGPT и Z.ai adapter lanes по capability matrix и Rust-owned cross-host ordinary `deliver` с remote readback и A↔A/B peer visibility.
3. Один раз проверить новый Rust child через GPTAdmin modern stdio как обычного MCP consumer; исправление GPTAdmin не смешивать с Herder adapter design.
4. Закрыть resources/offline claims, global/project/node coordination, owner cleanup, recovery receipts и transcript/file projection.
5. Довести typed `automation` list/get/delete и безопасно отключить или мигрировать старые cadence/resume-after authorities.
6. После consumer evidence расширять остальные Rust adapters, browser extension lanes и immutable install matrix; Go adapters держать выключенными, OpenCode V1 не поддерживать.

Не начинать с массового Rust rewrite, нового orchestrator, повторной сборки уже принятого candidate, GPTAdmin housekeeping или automation cleanup вместо P0. Каждый новый шаг сначала закрывает observable consumer path, затем расширяет поддержку.

## Источники извлечённой спецификации

Нормативная версия собрана из сохранённых проектных документов и текущего исходного кода:

- .agents/tasks/20261107-herder-native-mcp-breaking/RUST-DESIGN.md — границы Rust core, application layer, adapters, identity, MCP и receipts;
- .agents/tasks/20261107-herder-native-mcp-breaking/RESOURCES.md — resource scopes, authority, attachment, claim/renew/release и offline route;
- .agents/tasks/20261107-herder-native-mcp-breaking/COORDINATION.md и RECOVERY-STORAGE.md — correspondence, identity, recovery и file boundaries;
- .agents/tasks/20261107-herder-native-mcp-breaking/COMPATIBILITY.md — отдельный удаляемый legacy translator;
- crates/herder/src/mcp/catalog.rs — текущий typed native catalog;
- src/mcp/session-tools.ts и src/mesh/ — application/mesh compatibility boundary;
- scripts/test-model-server.py, tests/native/ahap_opencode_stand.py и acceptance/contracts/opencode.md — deterministic OpenCode fixture и consumer acceptance.

Документы WORKPLAN, FAST-PATH, plan.md и plan.json остаются историческими материалами. Они полезны для provenance и поиска старых receipts, но не могут переписать эту спецификацию или объявить runtime готовым без нового evidence.

