# Архитектура Agent Herder — v1, нулевая ревизия, независимый пересмотр Astra

7 ноября 2026. Это проект решения, не описание установленного продукта. [Критика](ASTRA-REVIEW.md), [полный план](WORKPLAN.md), [официальные основания](MCP-EVIDENCE.md).

## Решение и границы

Переписать daemon и адаптеры на Rust, сохранив намерение владельца, а не прежний API. Один daemon на Node, несколько HarnessInstance в нём, отдельный профиль/соединение у каждого instance, много Session. Один application layer обслуживает MCP, CLI и Web UI. SQLite на ноде хранит предметные данные и стандартные Tasks; маленькая файловая библиотека владеет release/checkout. Ни второго controller, ни собственного публичного jobs API, ни постоянных aliases. Frontend может оставаться TypeScript; он не является старым daemon.

Rust/rmcp 3.9.0 — обоснованный **проектный выбор**, а не доказательство готовой интеграции. Тег официального SDK существует, содержит Tasks и Skills; MSRV 1.88, edition 2024. Cargo.lock и toolchain закрепляются после первого compile/interoperability gate. SDK TaskManager использует HashMap: его нельзя обернуть SQLite-копией и объявить crash durable. Использовать SDK wire types/handlers и один SQLite backend стандартных Tasks с явными переходами. Никаких параллельных in-memory/DB владельцев состояния.

Go проще для сопровождения сервиса; v1.8.0 поддерживает выбранную wire revision. Однако просмотр README и ограниченного набора файлов не доказывает отсутствие расширений во всём Go SDK. Без проверенной реализации extensions перенос на Go добавляет риск собственного протокольного кода. TypeScript быстрее для команды существующего проекта, но сохраняет runtime и не устраняет delivery defects автоматически. Сейчас не менять язык ради эстетики. Если маленький Rust gate покажет необходимость fork SDK или неподдерживаемый клиент, сначала зафиксировать конкретный разрыв; сравнить стоимость устранения с официальным Go/TS SDK, затем изменить решение до написания адаптеров. SDK version, wire revision и native harness version — разные величины.

## Модули и владение

```text
mcp / cli / web  -> application -> pure domain decisions
                              -> adapters/<product> -> native API
                              -> store (SQLite Tasks, messages, holds, settings)
                              -> ownership (JSON + local OS lock)
peer MCP -> та же application boundary на целевой Node
```

Нода назначения владеет сессией и её intents. Прокси не создаёт второй Task/controller: возвращает адресуемую ссылку на Task origin и маршрутизирует стандартные методы к нему с проверкой полномочий. Реестр route не является зеркалом состояний. Task ID должен быть однозначен вместе с origin; непрозрачный proxy token связывает origin/task/principal. Потеря маршрута не означает разрешение выполнить действие локально.

Не вводить plugin framework, распределённую БД, общий message bus, автоматический NAT discovery или универсальный workflow DAG. Конфигурация задаёт nodes, endpoints, authority, instances и secret references. Runtime cwd и место Git worktree — разные поля. Linux/macOS, amd64/arm64 — целевые артефакты; наличие каждой сборки и native проверки отмечается отдельно. Неизвестный target не становится поддерживаемым автоматически.

Identity = node_id + instance_id + native_session_id; session_ref — непрозрачный адрес. Instance ID переживает рестарт, новый профиль получает новый ID. Capabilities описывают возможности конкретной версии адаптера, availability — текущую доступность, permissions — право вызывающего. Ничего из этого не выводится из имени harness.

## Четырнадцать общих инструментов

Число — следствие границ, не KPI. Каждая разновидность запроса имеет отдельную JSON Schema ветвь с discriminator; неизвестные поля отвергаются. Не делать один `execute(action, kwargs)`.

| Инструмент | Описание на русском и граница |
|---|---|
| `discover` | Показать ноды и экземпляры либо модели выбранного экземпляра. Возможности, доступность, права, версия и давность указаны отдельно; неизвестная квота остаётся неизвестной. |
| `sessions` | Найти участников проекта и сессии; показать текущую задачу, worktrees, scopes и полноту обхода. |
| `session` | Прочитать recent user+assistant, context своего агента или журнал сообщений. Только чтение; `context` работает без аргумента self при проверенной привязке. |
| `create` | Создать сессию в точно указанном экземпляре. Возвращает созданный адрес и доказательство native admission. |
| `deliver` | Доставить сообщение в точную сессию или ответить отправителю `reply_to`. Режим current/queue/start явно задан и не подменяется. |
| `resume` | Продолжить выбранную сессию один раз; HumanStop не снимает. Не планировщик зависимостей между задачами. |
| `stop` | Сохранить запрет автоматического продолжения и запросить нативное прерывание. Оба результата видны отдельно. |
| `search` | Искать сохранённые сообщения/сессии с курсором, источниками и coverage. Чтение не вызывает модель. |
| `export` | Получить снимок transcript в общем или исходном формате через доступный ресурс; долгий экспорт — стандартный Task. |
| `automation` | Настроить расписание или автопилот точной сессии, посмотреть/приостановить/удалить правило. Два типизированных вида правил используют один executor. |
| `resource` | Найти и зарегистрировать ресурс global/project/node, прочитать доступность и владельца; изменить descriptor, атомарно занять/продлить/освободить; записать рабочее намерение или заметку. Подключение, принадлежность и владение независимы. |
| `configure` | Прочитать/изменить поддерживаемую настройку node/instance/session по CAS; desired/applied и ограничения доступа явные. |
| `permission` | Прочитать или ответить на конкретный нативный запрос разрешения; без превращения текста модели в полномочия человека. |
| `human_request` | Создать внешний вопрос через Notice Place и связать ответ с исходной сессией. Внутренний запрос MCP использует MRTR/Tasks. |

Удалены дубли: отдельный `models` включён в discovery, notes — в resource(action=declare), cron/autopilot — в automation. Из deliver удалены implicit create и разовая отложенная отправка: create и one-shot schedule уже выражают это без второго маршрута побочного эффекта. Для workflow «продолжить после Task» внешний workflow читает стандартный Task и вызывает resume с постоянным ключом; Herder не строит DAG scheduler. Секретарь держит свой шаблон у себя.

Общий контракт ресурсов: [RESOURCES.md](RESOURCES.md). Один JSON owner на resource_ref; identity устройства не меняется при смене подключения. LHC хранит содержимое плана; Herder хранит ссылку и владение. Первые native create/deliver/read — E001/E002 до полного адаптера.

## MCP, результат и ошибки

Wire baseline — MCP 2026-07-28. Core: server/discover, request metadata/capabilities, tools/resources, subscriptions/listen, MRTR. Tasks и Skills — объявленные opt-in extensions. Tasks: get/update/cancel, без tasks/list/result. Skill читается через resources/read; чтение не доказывает активацию в модели. Клиент без Tasks может выполнять быстрые чтения, но запрос, которому нужен Task, отклоняется **до эффекта** с конкретным способом обновления клиента. Нет downgrade старого wire и нет emulation jobs. Совместимость каждого обязательного потребителя проверяется до массовой реализации.

Для `deliver` completion означает подтверждённое присутствие входящего сообщения в целевом native turn/queue, а не ответ модели. `create` завершён после точного native session readback; `resume` — после подтверждённого запуска нужного хода; `export` — после доступности полного заявленного snapshot. Ожидание ответа модели — чтение отдельного turn/session resource. MCP `completed` может содержать tool `isError`; это не бизнес-успех.

SQLite transaction до внешнего вызова сохраняет principal, target, payload hash, request_key, intent и Task. State: prepared -> dispatching -> admitted -> confirmed, либо rejected/unknown. Нужна атомарная борьба двух обработчиков за один intent. Повтор того же principal/target/key возвращает прежний результат; другой payload конфликтует. При падении в dispatching нельзя угадать, был ли native вызов: reconcile по точному native receipt/idempotency key; без такого API статус unknown остаётся. Нового send нет. TTL Task не удаляет дедупликацию: tombstone/receipt живёт дольше потенциального retry, срок задаётся контрактом и проверяется при миграции.

Stop фиксирует hold до interruption. Dispatch повторно проверяет hold на admission boundary; если native уже принял действие, stop сообщает это и результат попытки interruption. Нельзя обещать отзыв уже принятого эффекта. Cancellation Task — запрос, а не доказательство остановки native; UNKNOWN не переводится в безопасный retry. Подписки — уведомления об изменении: потеря потока восстанавливается snapshot/domain cursor, без выдуманного SSE replay. Cache для персональных ресурсов private; срок и ACL проверяются также при polling, subscription и proxy.

Ошибка содержит `code`, `field`, безопасное `received`, `expected`, `fix`, `effect = none|confirmed|unknown`, `retry = safe_same_key|read_receipt|forbidden`, `receipt_ref`, `diagnostic_ref`. Невалидный JSON/метод — protocol error, валидный вызов с предметным отказом — tool error с теми же диагностическими полями. Секретные received редактируются. Исправленный вызов строится только когда исправление однозначно. Пример: «Поле mode: получено current, экземпляр поддерживает только start. Сообщение не отправлено. Повторите с mode=start, если нужен новый ход». UNKNOWN: «Исход отправки неизвестен. Прочитайте указанную квитанцию; новую отправку не делайте».

## Адаптеры: функциональное ядро и небольшие stateful соединения

Цель — независимый тест правил, не запрет объектов. Функция, читающая socket/global clock/SQLite, не становится чистой из-за свободного `fn`. Объект соединения нужен для process handle, socket, token reference, stream cursor и сериализации native writes. В нём нет scheduler, владения проектом или собственного журнала retry.

Чистые функции принимают snapshots/clock values как данные: decode native event, normalize transcript, choose dispatch, classify receipt. Эффекты выполняет небольшой порт. Trait применяется там, где нужна замена эффекта в тесте; не создавать trait на каждый DTO и не использовать наследование base adapter. Для пяти продуктов v1 достаточно enum registry и композиции.

Иллюстративный контракт (типам DTO соответствуют отдельные схемы; это проект, не скомпилированная библиотека):

```rust
pub fn decide_send(s: &SessionSnapshot, c: &SendCommand)
    -> Result<DispatchPlan, DomainError> {
    if s.human_stop { return Err(DomainError::Stopped); }
    if !s.capabilities.supports(c.mode) {
        return Err(DomainError::UnsupportedMode(c.mode));
    }
    Ok(DispatchPlan { target: s.address.clone(),
        expected_turn: s.turn_id.clone(), mode: c.mode })
}

// Статический dispatch/enum registry; async_trait/BoxFuture только при нужде в dyn.
trait NativeSessionPort {
    async fn snapshot(&self, target: &SessionAddress)
        -> Result<SessionSnapshot, ReadError>;
    async fn submit(&self, plan: DispatchPlan, message: &str, key: &RequestKey)
        -> Result<Admission, SubmitError>; // DefinitelyNotSent | OutcomeUnknown
    async fn reconcile(&self, receipt: &NativeReceipt)
        -> Result<Observation, ReadError>;
}
```

Пример 1: `decide_send` на immutable snapshot проверяется таблицей busy/idle/stop/mode без процесса harness. Fake port проверяет, что application сначала фиксирует intent, а только потом вызывает submit. Snapshot не защита от гонки: application заново проверяет hold и передаёт expected_turn; native mismatch отвергается либо фиксируется неопределённость, без переключения режима.

Пример 2: `decode_event(bytes) -> Result<NativeEvent, DecodeError>` и `reduce_turn(old, event) -> TurnSnapshot` чистые; `CodexConnection` читает stream, связывает request IDs и передаёт bytes. Разрыв после записи проверяется fake transport, а доказательство отсутствия дубля — отдельно реальным harness. Аналогичный подход у HTTP/browser, но browser state не делится между профилями. Маленькие отдельные Reader/Control ports допустимы, если продукт реально не умеет управление; не заставлять read-only адаптер реализовывать фиктивные success.

## Поставка

Сначала изолированная вертикаль Codex+OpenCode и проверка клиентов/Tasks, затем остальные адаптеры. Конкретный поддерживаемый контракт определяется bounded probe каждого продукта; отсутствие публичного управления не маскируется фиктивной capability. В v1 остаются только Codex, OpenCode, ZCode, ChatGPT и Z.ai; остальные adapters вынесены в NEXT-UPDATE.md вне рабочего графа. Если lane нельзя выполнить за предполагаемые часы, gate фиксирует результат исследования, блокирует зависимое обещание и требует переразбиения до работы; он не означает отказ от поддержки.

Потребители переводятся явно. Перед cutover остановить старые writers, сделать snapshot, импортировать holds/intents/lineage/correspondence и переключить единственный owner route. Проверка old direct calls обязательна. После новых записей rollback не возвращает старую БД: по умолчанию maintenance + тот же ledger + исправленный новый артефакт. Старый daemon возвращается только при доказанном reverse import без повторных действий. Не обещать это за час.

Весь цикл, включая native проверки, четыре артефакта, Linux/macOS установку, удаление runtime legacy и независимую приёмку, есть в WORKPLAN. Реализацией руководит Тера. Astra ведёт эту детализацию; новые product steps здесь не объявляются выполненными.
