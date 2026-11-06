# Полный рабочий план — ревизия 5 Astra

219 исполнимых листьев, каждый 20–60 минут. Реализация не запущена. Диапазоны условны при готовности входов; риски и расчёт — [ESTIMATES](ESTIMATES.md). Граф создаётся scoped canonical writer, этот текст — читаемая проекция тех же входных данных.

Вход каждого листа: результат перечисленных depends_on, соответствующий контракт RUST-DESIGN/COORDINATION/RECOVERY-STORAGE и подтверждённый native/consumer gate. Область consumer:... раскрывается в конкретные repo/files обязательным предыдущим target.json gate; вне подтверждённой области запись не разрешена. Gate с отрицательным ответом не закрывает обязательную capability.

Код, fixture и live acceptance разделены. Для неизвестного объёма разрешён только ограниченный research результат; если нужное решение не найдено, зависимый implementation slice блокируется и переразбивается. Не продолжать часовой лист бесконечно и не объявлять старую оценку гарантией.

Дорожка ограничивает одновременную запись: один adapter/consumer/module lane ведёт один исполнитель. Независимые каталоги могут выполняться параллельно. Интегратор принимает изменения общих контрактов. Ни один исполнитель сейчас не назначен.

## Основа

### A001. Закрепить SDK и собрать минимальный wire probe — 30–45 мин

Вход: официальные источники MCP-EVIDENCE и утверждённая область переписи. Дорожка: `core`.
Результат: Cargo.lock/toolchain и probe server/discover → tools/call на rmcp 3.9.0.
Приёмка: Записаны версии/feature flags; процесс запускается и отдаёт обязательный resultType. Если compile не проходит, точный минимальный failure и пересмотр до адаптеров.
Область: `crates/herder/Cargo.toml`.

### A002. Проверить Tasks/Skills/subscriptions выбранного SDK — 30–60 мин

Вход: A001. Дорожка: `core`.
Результат: Wire transcript get/update/cancel, skills/list/get/read и listen; без native эффектов.
Приёмка: Capabilities проверяются до возврата Task; отсутствуют tasks/list/result; найденные SDK пробелы названы.
Область: `tests/protocol/sdk_probe.rs`.

### A003. Проверить конкретный основной MCP-клиент — 30–60 мин

Вход: A002. Дорожка: `clients`.
Результат: Один объявленный потребитель подключается к probe; revision/extensions/identity matrix.
Приёмка: Есть прямой trace реального клиента, не SDK talking to itself; unsupported блокирует gate и зависимую реализацию.
Область: `acceptance/contracts/primary-client.json`.

### A004. Конфигурация Node и HarnessInstance — 30–45 мин

Вход: A001. Дорожка: `core`.
Результат: Typed config nodes/instances/profiles/authority/secret refs; duplicate ID validation.
Приёмка: Два профиля одного типа независимы; hostname/root не зашиты; диагностика неверного поля.
Область: `crates/herder/src/config.rs`.

### A005. Типы адресов и capabilities — 30–45 мин

Вход: A004. Дорожка: `core`.
Результат: Node/instance/session refs, supported/available/authorized отдельно; версии capability.
Приёмка: Одинаковые native IDs в разных instance не равны; offline не unsupported.
Область: `crates/herder/src/domain/address.rs`.

### A006. Контракт pure core и native port — 30–45 мин

Вход: A005. Дорожка: `core`.
Результат: DTO Admission/Unknown/Receipt и маленькие reader/control ports; enum registry.
Приёмка: Табличный pure decision test без I/O; fake submit различает never sent и unknown.
Область: `crates/herder/src/domain/adapter.rs`.

### A007. Одна диагностическая схема ошибок — 30–45 мин

Вход: A006. Дорожка: `core`.
Результат: field/received/expected/fix/effect/retry/receipt; redaction секретов.
Приёмка: Wrong mode и conflict reply_to дают однозначный исправляемый вызов без mutation.
Область: `crates/herder/src/error.rs`.

### A008. Привязать caller и области доступа — 30–60 мин

Вход: A005. Дорожка: `security`.
Результат: Verified principal/self binding; deny-by-default для private session и ресурсов.
Приёмка: Подмена sender/session_ref и общий node token не дают self; auth не следует из parent.
Область: `crates/herder/src/auth/identity.rs`.

### A009. Реестр 14 инструментов и typed variants — 30–45 мин

Вход: A007, A002. Дорожка: `core`.
Результат: Единая декларация discovery/dispatch с oneOf schemas; actions read/mutate разделены.
Приёмка: tools/list совпадает с dispatch; дополнительные поля/legacy names отвергаются.
Область: `crates/herder/src/mcp/catalog.rs`.

### A010. HTTP и stdio без legacy negotiation — 30–60 мин

Вход: A009, A003, A008. Дорожка: `core`.
Результат: Транспорт SDK, обязательная request metadata, shutdown; application entrypoint.
Приёмка: Основной клиент читает catalog обоими поддерживаемыми транспортами; wrong revision до эффекта.
Область: `crates/herder/src/mcp/transport.rs`.

### A011. SQLite схема и транзакционные границы — 30–60 мин

Вход: A006. Дорожка: `storage`.
Результат: Таблицы tasks/intents/messages/holds/lineage/settings; migration version.
Приёмка: Rollback transaction не оставляет half intent; новый schema version запрещает запись старому binary.
Область: `crates/herder/src/store/schema.sql`.

### A012. Атомарное принятие идемпотентного intent — 30–60 мин

Вход: A011, A008, A007. Дорожка: `storage`.
Результат: Unique principal/target/request_key + payload hash и CAS prepared→dispatching.
Приёмка: Два одновременных обработчика вызывают fake submit один раз; conflict payload отклоняется.
Область: `crates/herder/src/store/intents.rs`.

### A013. Durable стандартные Tasks get/create — 30–60 мин

Вход: A012, A010. Дорожка: `storage`.
Результат: SDK wire types и SQLite backend без in-memory authority.
Приёмка: Task сохранён до ответа, polling после рестарта читает тот же ID/result.
Область: `crates/herder/src/mcp/tasks.rs`.

### A014. Tasks update и cooperative cancel — 30–60 мин

Вход: A013. Дорожка: `storage`.
Результат: Persist pending inputs и ответы по ключам; cancel intent отдельно от effect outcome.
Приёмка: Повтор input не продолжает дважды; cancel после admission не выдаёт отмену эффекта.
Область: `crates/herder/src/store/task_inputs.rs`.

### A015. Reconcile неопределённой native отправки — 30–60 мин

Вход: A014. Дорожка: `storage`.
Результат: Restart dispatcher читает native receipt по стабильной корреляции, без send.
Приёмка: Kill после dispatching/admission даёт confirmed или unknown; unknown не получает safe retry.
Область: `crates/herder/src/application/reconcile.rs`.

### A016. Разделить Task TTL и receipt retention — 30–45 мин

Вход: A015. Дорожка: `storage`.
Результат: Tombstone дедупликации/удалённого текста, правила expiry.
Приёмка: Истёкший Task и удалённый transcript не позволяют повтор request_key выполнить эффект.
Область: `crates/herder/src/store/retention.rs`.

### A017. Ресурсы с ACL и приватным cache — 30–60 мин

Вход: A010, A013, A008. Дорожка: `protocol`.
Результат: Session/task/transcript resources с remote-readable refs и pagination.
Приёмка: Другой principal не читает result/Task; cacheScope private и ttlMs корректны.
Область: `crates/herder/src/mcp/resources.rs`.

### A018. Подписки с bounded очередью и resync — 30–60 мин

Вход: A017. Дорожка: `protocol`.
Результат: subscriptions/listen filters; drop→snapshot, без SSE replay.
Приёмка: Медленный клиент не блокирует ноду; reconnect видит current revision без дублирования эффектов.
Область: `crates/herder/src/mcp/subscriptions.rs`.

### A019. Статический Skills manifest — 30–45 мин

Вход: A017. Дорожка: `protocol`.
Результат: skills/list/get и resources/read с digest; directoryRead не объявлен.
Приёмка: Проверены manifest boundary, приватность и content hash; read не объявляет activation.
Область: `crates/herder/src/mcp/skills.rs`.

### A020. Маршрутизация к owner Node — 30–60 мин

Вход: A010, A005. Дорожка: `protocol`.
Результат: Peer auth, точный instance, deadline и сохранение errors; без local fallback.
Приёмка: Две конфигурируемые ноды; чужой scope denied, недоступный origin остаётся unavailable.
Область: `crates/herder/src/peer/route.rs`.

### A021. Удалённые Tasks и resources без второго lifecycle — 30–60 мин

Вход: A020, A013, A017. Дорожка: `protocol`.
Результат: Origin Task ref и маршрутизация standard polling/cancel/read по ACL.
Приёмка: Proxy restart не дублирует native intent; origin task/result остаются теми же.
Область: `crates/herder/src/peer/tasks.rs`.

### A022. Долговечный creator и native parent — 30–45 мин

Вход: A012. Дорожка: `core`.
Результат: Создатель в create intent, native parent и происхождение отдельно.
Приёмка: Restart между intent и native receipt не меняет creator; неизвестное происхождение не угадано.
Область: `crates/herder/src/store/lineage.rs`.

### A023. Общий create с точным instance — 30–60 мин

Вход: A022, A006, A021. Дорожка: `core`.
Результат: Application create проверяет capability/auth и связывает intent с native ID.
Приёмка: Fake native create вызывается один раз; completion только после session readback.
Область: `crates/herder/src/application/create.rs`.

### A024. Общий deliver с явным режимом — 30–60 мин

Вход: A023, A015. Дорожка: `core`.
Результат: current/queue/start, expected turn; implicit create и delayed send отсутствуют.
Приёмка: Busy/unsupported не подменяют режим; persisted intent предшествует submit.
Область: `crates/herder/src/application/deliver.rs`.

### A025. HumanStop на admission boundary — 30–60 мин

Вход: A024. Дорожка: `core`.
Результат: Durable hold перед interrupt; dispatch/stop сериализуют admission.
Приёмка: Race stop/deliver: post-hold send не стартует; уже принятое действие отражено честно.
Область: `crates/herder/src/application/stop.rs`.

### A026. Одноразовое resume — 30–45 мин

Вход: A025. Дорожка: `core`.
Результат: Один request_key → один native turn; HumanStop требует отдельного человеческого права на снятие.
Приёмка: Дубликат resume не создаёт ход; флаг humanRequested от модели не снимает hold.
Область: `crates/herder/src/application/resume.rs`.

### A027. Журнал и reply_to — 30–60 мин

Вход: A024, A022, A008. Дорожка: `storage`.
Результат: Transaction связывает sender/recipient/message_ref с intent; reply target берётся сервером.
Приёмка: C→B и ответ B адресованы C; A creator не подменяется; чужой reply_to denied.
Область: `crates/herder/src/store/correspondence.rs`.

### A028. Recent обеих ролей — 30–45 мин

Вход: A006, A017. Дорожка: `core`.
Результат: Общий projection user+assistant с turn/time/partial; read-only session.
Приёмка: Старый assistant не назван ответом на новый input; отсутствующий источник не пустая история.
Область: `crates/herder/src/application/recent.rs`.

### A029. Transcript snapshot и cursor — 30–45 мин

Вход: A028. Дорожка: `core`.
Результат: Нормализованные blocks, raw ref и подписанный/привязанный snapshot cursor.
Приёмка: Чужой cursor отвергнут; последняя страница, truncation и snapshot boundary проверены.
Область: `crates/herder/src/domain/transcript.rs`.

### A030. Инкрементальный поиск — 30–60 мин

Вход: A029, A011. Дорожка: `storage`.
Результат: SQLite FTS и source cursors; обновление только изменённой сессии.
Приёмка: Одна новая запись не сканирует весь corpus; ACL и coverage сохраняются.
Область: `crates/herder/src/search/index.rs`.

### A031. Sessions/discover и coverage — 30–45 мин

Вход: A030, A020. Дорожка: `core`.
Результат: Постраничный список по project/instance; native availability отдельно от cached records.
Приёмка: Offline peer явно отмечен, одинаковые basename не склеены.
Область: `crates/herder/src/application/list.rs`.

### A032. Модели и квоты профиля — 30–45 мин

Вход: A031. Дорожка: `core`.
Результат: discover(kind=models) отдаёт verified catalog и unknown значения.
Приёмка: Два профиля не разделяют auth/quota cache, unknown не zero/unlimited.
Область: `crates/herder/src/application/models.rs`.

### A033. Configure desired/applied CAS — 30–60 мин

Вход: A032, A008. Дорожка: `core`.
Результат: Node/instance/session settings поддерживаются только при capability, typed patches.
Приёмка: Stale revision отвергнут; remote unavailable не applied; scope проверяется.
Область: `crates/herder/src/application/settings.rs`.

### A034. Точный native permission request — 30–45 мин

Вход: A033, A014. Дорожка: `core`.
Результат: Pending request identity и authorized answer, без wildcard approvals.
Приёмка: Expired ID не отвечает другому request; duplicate answer идемпотентен.
Область: `crates/herder/src/application/permission.rs`.

### A035. Внешний вопрос и MCP input раздельно — 30–60 мин

Вход: A034, A026. Дорожка: `core`.
Результат: MRTR/Task input и external correlation используют одну delivery boundary.
Приёмка: Ответ относится одной сессии, повтор callback не даёт два resume; внешняя отправка только в test route.
Область: `crates/herder/src/application/human.rs`.


## Владение

### A036. Manifest канонического storage — 30–45 мин

Вход: A004, A008. Дорожка: `ownership`.
Результат: Storage/project/resource markers, точный offline locator и ACL policy.
Приёмка: Wrong root/storage/mount loss отличаются от owner ENOENT; секретов нет.
Область: `crates/herder/src/ownership/manifest.rs`.

### A037. Одна owner запись и OS lock — 30–60 мин

Вход: A036. Дорожка: `ownership`.
Результат: Claim/renew/release с UUID epoch, atomic rename/unlink+fsync, CAS claim ID.
Приёмка: Concurrent claims имеют одного победителя; release чужого ID denied; нет state.json transaction.
Область: `crates/herder/src/ownership/claim.rs`.

### A038. Crash proof файловых переходов — 30–60 мин

Вход: A037. Дорожка: `ownership`.
Результат: Fault injection до/после rename/unlink/fsync; leftover temp cleanup под lock.
Приёмка: Полный old/new owner или отсутствие; fsync failure unknown; guard inode не заменён.
Область: `tests/ownership/crash.rs`.

### A039. Offline CLI поверх той же библиотеки — 30–45 мин

Вход: A038. Дорожка: `ownership`.
Результат: herder ownership без запуска daemon/SQLite/MCP; JSON и русские ошибки.
Приёмка: Потерянный claim response читается по nonce без automatic reclaim после release.
Область: `crates/herder/src/cli/ownership.rs`.

### A040. Workspace declarations и общий claim route — 30–60 мин

Вход: A037, A031. Дорожка: `ownership`.
Результат: Project/worktree identity/scopes/notes; MCP ownership вызывает ту же библиотеку.
Приёмка: Декларация не lease; две ноды одного shared workspace используют один resource.
Область: `crates/herder/src/application/workspace.rs`.

### A041. Единственная точка release admission — 30–60 мин

Вход: A039. Дорожка: `ownership`.
Результат: Target-local lock, live claim check после lock, expected deployed revision.
Приёмка: Задержавшийся старый claim отвергнут; второй runner path запрещён конфигурацией.
Область: `crates/herder/src/ownership/release_runner.rs`.

### A042. Durable release receipt до spawn — 30–60 мин

Вход: A041. Дорожка: `ownership`.
Результат: Request key/hash, admitted/confirmed/unknown; child удерживает execution lock.
Приёмка: Crash родителя не отпускает live child; unknown external effect блокирует новый конфликтующий effect.
Область: `crates/herder/src/ownership/release_receipt.rs`.

### A043. Гонка release и смена owner — 30–60 мин

Вход: A042, A040. Дорожка: `ownership`.
Результат: Test runner делает безопасный локальный file revision effect; delay/crash/partition.
Приёмка: Максимум один эффект; повтор key только readback; lost authority запрещает новый admission.
Область: `tests/ownership/release_races.rs`.


## Координация

### A044. Context self/creator/senders/peers — 30–60 мин

Вход: A027, A040, A028. Дорожка: `core`.
Результат: Один bounded snapshot с адресами, scopes, coverage и курсорами.
Приёмка: A creator и C sender восстанавливаются без transcript memory; чужие closed sessions скрыты.
Область: `crates/herder/src/application/context.rs`.

### A045. Offline context snapshot — 30–45 мин

Вход: A044, A039. Дорожка: `ownership`.
Результат: Atomic JSON projection c generated_at, coverage и безопасными routes.
Приёмка: Без daemon читается stale snapshot; это не owner или delivery receipt.
Область: `crates/herder/src/ownership/context_snapshot.rs`.

### A046. Контекстные generation и native hook client — 30–60 мин

Вход: A044, A018, A025. Дорожка: `core`.
Результат: Projector snapshot/delta, новый context generation не подавляется fingerprint.
Приёмка: Fake compact event вызывает snapshot без нового model turn и без снятия STOP.
Область: `integrations/hooks/context_client.rs`.


## Автоматизация

### A047. Typed automation rules — 30–60 мин

Вход: A033, A026. Дорожка: `core`.
Результат: Schedule/one-shot и autopilot в одном CRUD; timezone, missed/overlap, CAS.
Приёмка: Неверный cron объясняется; настройка не создаёт parallel job API.
Область: `crates/herder/src/automation/rules.rs`.

### A048. Один admission executor триггеров — 30–60 мин

Вход: A047. Дорожка: `core`.
Результат: Trigger ID + правило + native turn → постоянный delivery request_key.
Приёмка: Hook/observer/end-turn повтор не создаёт второй continuation; hold всегда проверен.
Область: `crates/herder/src/automation/executor.rs`.

### A049. DST/restart/pause расписания — 30–45 мин

Вход: A048. Дорожка: `core`.
Результат: Clock как вход pure reducer; bounded catch-up и no overlap.
Приёмка: DST fold/gap, restart после admission и pause не дают дубля.
Область: `tests/automation/schedule.rs`.

### A050. Остановка автопилота по цели/бюджету — 30–60 мин

Вход: A048. Дорожка: `core`.
Результат: Existing goal judge contract как input; bounded continuation, явный failure.
Приёмка: Goal done, quota unknown/denied и HumanStop не вызывают retry-loop; одна continuation на turn.
Область: `crates/herder/src/automation/autopilot.rs`.


## Адаптеры

### A051. Нативный тестовый контур и endpoint — 30–60 мин

Вход: A010, A023, A025. Дорожка: `qa`.
Результат: Изолированные profiles, deterministic model endpoint для поддерживающих клиентов, receipt schema.
Приёмка: Native процесс отличим от fake adapter; никакого личного аккаунта/звонка; отдельные browser test identities.
Область: `tests/native/harness_runner.rs`.

### A052. Codex: подтвердить точный native контракт — 25–45 мин

Вход: A006, A051. Дорожка: `adapter:codex`.
Результат: Один versioned app-server JSON-RPC: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
Область: `acceptance/contracts/codex.md`.

### A053. Codex: соединение одного instance — 30–60 мин

Вход: A052. Дорожка: `adapter:codex`.
Результат: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
Область: `crates/herder/src/adapters/codex/connection.rs`.
Неопределённость: Объём интеграции неизвестен до подтверждения native route предыдущим gate; 30–60 минут покрывают только готовый versioned transport. При отсутствующем API нужны новые slices, прогноз полного срока пока условный.

### A054. Codex: session list и recent — 30–60 мин

Вход: A053, A028. Дорожка: `adapter:codex`.
Результат: Одна подтверждённая native read route → адреса/status/последние user+assistant.
Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
Область: `crates/herder/src/adapters/codex/read.rs`.

### A055. Codex: создать и сверить session ID — 30–60 мин

Вход: A054, A023. Дорожка: `adapter:codex`.
Результат: Одна native create route; request correlation и readback.
Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
Область: `crates/herder/src/adapters/codex/create.rs`.

### A056. Codex: доставить и сверить input — 30–60 мин

Вход: A055, A024. Дорожка: `adapter:codex`.
Результат: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
Область: `crates/herder/src/adapters/codex/deliver.rs`.

### A057. Codex: transcript страницы — 30–60 мин

Вход: A056, A029, A030. Дорожка: `adapter:codex`.
Результат: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
Область: `crates/herder/src/adapters/codex/transcript.rs`.

### A058. Codex: interrupt и параметры — 30–60 мин

Вход: A057, A025, A034, A032. Дорожка: `adapter:codex`.
Результат: Только доказанные stop/model/permission methods; unsupported явно, не успех.
Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
Область: `crates/herder/src/adapters/codex/control.rs`.

### A059. Codex: подключить context bridge — 25–45 мин

Вход: A058, A046. Дорожка: `adapter:codex`.
Результат: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
Область: `crates/herder/src/adapters/codex/context.rs`.

### A060. Codex: установленная тестовая вертикаль — 30–60 мин

Вход: A059, A051, A016. Дорожка: `adapter:codex`.
Результат: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
Область: `acceptance/native/codex/`.

### A061. OpenCode: подтвердить точный native контракт — 25–45 мин

Вход: A006, A051. Дорожка: `adapter:opencode`.
Результат: Один versioned HTTP/events: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
Область: `acceptance/contracts/opencode.md`.

### A062. OpenCode: соединение одного instance — 30–60 мин

Вход: A061. Дорожка: `adapter:opencode`.
Результат: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
Область: `crates/herder/src/adapters/opencode/connection.rs`.
Неопределённость: Объём интеграции неизвестен до подтверждения native route предыдущим gate; 30–60 минут покрывают только готовый versioned transport. При отсутствующем API нужны новые slices, прогноз полного срока пока условный.

### A063. OpenCode: session list и recent — 30–60 мин

Вход: A062, A028. Дорожка: `adapter:opencode`.
Результат: Одна подтверждённая native read route → адреса/status/последние user+assistant.
Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
Область: `crates/herder/src/adapters/opencode/read.rs`.

### A064. OpenCode: создать и сверить session ID — 30–60 мин

Вход: A063, A023. Дорожка: `adapter:opencode`.
Результат: Одна native create route; request correlation и readback.
Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
Область: `crates/herder/src/adapters/opencode/create.rs`.

### A065. OpenCode: доставить и сверить input — 30–60 мин

Вход: A064, A024. Дорожка: `adapter:opencode`.
Результат: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
Область: `crates/herder/src/adapters/opencode/deliver.rs`.

### A066. OpenCode: transcript страницы — 30–60 мин

Вход: A065, A029, A030. Дорожка: `adapter:opencode`.
Результат: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
Область: `crates/herder/src/adapters/opencode/transcript.rs`.

### A067. OpenCode: interrupt и параметры — 30–60 мин

Вход: A066, A025, A034, A032. Дорожка: `adapter:opencode`.
Результат: Только доказанные stop/model/permission methods; unsupported явно, не успех.
Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
Область: `crates/herder/src/adapters/opencode/control.rs`.

### A068. OpenCode: подключить context bridge — 25–45 мин

Вход: A067, A046. Дорожка: `adapter:opencode`.
Результат: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
Область: `crates/herder/src/adapters/opencode/context.rs`.

### A069. OpenCode: установленная тестовая вертикаль — 30–60 мин

Вход: A068, A051, A016. Дорожка: `adapter:opencode`.
Результат: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
Область: `acceptance/native/opencode/`.

### A070. Claude: подтвердить точный native контракт — 25–45 мин

Вход: A006, A051. Дорожка: `adapter:claude`.
Результат: Один versioned официальный CLI/stream JSON: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
Область: `acceptance/contracts/claude.md`.

### A071. Claude: соединение одного instance — 30–60 мин

Вход: A070. Дорожка: `adapter:claude`.
Результат: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
Область: `crates/herder/src/adapters/claude/connection.rs`.
Неопределённость: Объём интеграции неизвестен до подтверждения native route предыдущим gate; 30–60 минут покрывают только готовый versioned transport. При отсутствующем API нужны новые slices, прогноз полного срока пока условный.

### A072. Claude: session list и recent — 30–60 мин

Вход: A071, A028. Дорожка: `adapter:claude`.
Результат: Одна подтверждённая native read route → адреса/status/последние user+assistant.
Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
Область: `crates/herder/src/adapters/claude/read.rs`.

### A073. Claude: создать и сверить session ID — 30–60 мин

Вход: A072, A023. Дорожка: `adapter:claude`.
Результат: Одна native create route; request correlation и readback.
Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
Область: `crates/herder/src/adapters/claude/create.rs`.

### A074. Claude: доставить и сверить input — 30–60 мин

Вход: A073, A024. Дорожка: `adapter:claude`.
Результат: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
Область: `crates/herder/src/adapters/claude/deliver.rs`.

### A075. Claude: transcript страницы — 30–60 мин

Вход: A074, A029, A030. Дорожка: `adapter:claude`.
Результат: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
Область: `crates/herder/src/adapters/claude/transcript.rs`.

### A076. Claude: interrupt и параметры — 30–60 мин

Вход: A075, A025, A034, A032. Дорожка: `adapter:claude`.
Результат: Только доказанные stop/model/permission methods; unsupported явно, не успех.
Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
Область: `crates/herder/src/adapters/claude/control.rs`.

### A077. Claude: подключить context bridge — 25–45 мин

Вход: A076, A046. Дорожка: `adapter:claude`.
Результат: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
Область: `crates/herder/src/adapters/claude/context.rs`.

### A078. Claude: установленная тестовая вертикаль — 30–60 мин

Вход: A077, A051, A016. Дорожка: `adapter:claude`.
Результат: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
Область: `acceptance/native/claude/`.

### A079. ZCode: подтвердить точный native контракт — 25–45 мин

Вход: A006, A051. Дорожка: `adapter:zcode`.
Результат: Один versioned подтверждаемый native session transport: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
Область: `acceptance/contracts/zcode.md`.

### A080. ZCode: соединение одного instance — 30–60 мин

Вход: A079. Дорожка: `adapter:zcode`.
Результат: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
Область: `crates/herder/src/adapters/zcode/connection.rs`.
Неопределённость: Объём интеграции неизвестен до подтверждения native route предыдущим gate; 30–60 минут покрывают только готовый versioned transport. При отсутствующем API нужны новые slices, прогноз полного срока пока условный.

### A081. ZCode: session list и recent — 30–60 мин

Вход: A080, A028. Дорожка: `adapter:zcode`.
Результат: Одна подтверждённая native read route → адреса/status/последние user+assistant.
Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
Область: `crates/herder/src/adapters/zcode/read.rs`.

### A082. ZCode: создать и сверить session ID — 30–60 мин

Вход: A081, A023. Дорожка: `adapter:zcode`.
Результат: Одна native create route; request correlation и readback.
Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
Область: `crates/herder/src/adapters/zcode/create.rs`.

### A083. ZCode: доставить и сверить input — 30–60 мин

Вход: A082, A024. Дорожка: `adapter:zcode`.
Результат: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
Область: `crates/herder/src/adapters/zcode/deliver.rs`.

### A084. ZCode: transcript страницы — 30–60 мин

Вход: A083, A029, A030. Дорожка: `adapter:zcode`.
Результат: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
Область: `crates/herder/src/adapters/zcode/transcript.rs`.

### A085. ZCode: interrupt и параметры — 30–60 мин

Вход: A084, A025, A034, A032. Дорожка: `adapter:zcode`.
Результат: Только доказанные stop/model/permission methods; unsupported явно, не успех.
Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
Область: `crates/herder/src/adapters/zcode/control.rs`.

### A086. ZCode: подключить context bridge — 25–45 мин

Вход: A085, A046. Дорожка: `adapter:zcode`.
Результат: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
Область: `crates/herder/src/adapters/zcode/context.rs`.

### A087. ZCode: установленная тестовая вертикаль — 30–60 мин

Вход: A086, A051, A016. Дорожка: `adapter:zcode`.
Результат: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
Область: `acceptance/native/zcode/`.

### A088. Qoder: подтвердить точный native контракт — 25–45 мин

Вход: A006, A051. Дорожка: `adapter:qoder`.
Результат: Один versioned подтверждаемый native CLI/session transport: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
Область: `acceptance/contracts/qoder.md`.

### A089. Qoder: соединение одного instance — 30–60 мин

Вход: A088. Дорожка: `adapter:qoder`.
Результат: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
Область: `crates/herder/src/adapters/qoder/connection.rs`.
Неопределённость: Объём интеграции неизвестен до подтверждения native route предыдущим gate; 30–60 минут покрывают только готовый versioned transport. При отсутствующем API нужны новые slices, прогноз полного срока пока условный.

### A090. Qoder: session list и recent — 30–60 мин

Вход: A089, A028. Дорожка: `adapter:qoder`.
Результат: Одна подтверждённая native read route → адреса/status/последние user+assistant.
Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
Область: `crates/herder/src/adapters/qoder/read.rs`.

### A091. Qoder: создать и сверить session ID — 30–60 мин

Вход: A090, A023. Дорожка: `adapter:qoder`.
Результат: Одна native create route; request correlation и readback.
Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
Область: `crates/herder/src/adapters/qoder/create.rs`.

### A092. Qoder: доставить и сверить input — 30–60 мин

Вход: A091, A024. Дорожка: `adapter:qoder`.
Результат: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
Область: `crates/herder/src/adapters/qoder/deliver.rs`.

### A093. Qoder: transcript страницы — 30–60 мин

Вход: A092, A029, A030. Дорожка: `adapter:qoder`.
Результат: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
Область: `crates/herder/src/adapters/qoder/transcript.rs`.

### A094. Qoder: interrupt и параметры — 30–60 мин

Вход: A093, A025, A034, A032. Дорожка: `adapter:qoder`.
Результат: Только доказанные stop/model/permission methods; unsupported явно, не успех.
Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
Область: `crates/herder/src/adapters/qoder/control.rs`.

### A095. Qoder: подключить context bridge — 25–45 мин

Вход: A094, A046. Дорожка: `adapter:qoder`.
Результат: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
Область: `crates/herder/src/adapters/qoder/context.rs`.

### A096. Qoder: установленная тестовая вертикаль — 30–60 мин

Вход: A095, A051, A016. Дорожка: `adapter:qoder`.
Результат: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
Область: `acceptance/native/qoder/`.

### A097. Hermes: подтвердить точный native контракт — 25–45 мин

Вход: A006, A051. Дорожка: `adapter:hermes`.
Результат: Один versioned подтверждаемый session transport/history: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
Область: `acceptance/contracts/hermes.md`.

### A098. Hermes: соединение одного instance — 30–60 мин

Вход: A097. Дорожка: `adapter:hermes`.
Результат: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
Область: `crates/herder/src/adapters/hermes/connection.rs`.
Неопределённость: Объём интеграции неизвестен до подтверждения native route предыдущим gate; 30–60 минут покрывают только готовый versioned transport. При отсутствующем API нужны новые slices, прогноз полного срока пока условный.

### A099. Hermes: session list и recent — 30–60 мин

Вход: A098, A028. Дорожка: `adapter:hermes`.
Результат: Одна подтверждённая native read route → адреса/status/последние user+assistant.
Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
Область: `crates/herder/src/adapters/hermes/read.rs`.

### A100. Hermes: создать и сверить session ID — 30–60 мин

Вход: A099, A023. Дорожка: `adapter:hermes`.
Результат: Одна native create route; request correlation и readback.
Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
Область: `crates/herder/src/adapters/hermes/create.rs`.

### A101. Hermes: доставить и сверить input — 30–60 мин

Вход: A100, A024. Дорожка: `adapter:hermes`.
Результат: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
Область: `crates/herder/src/adapters/hermes/deliver.rs`.

### A102. Hermes: transcript страницы — 30–60 мин

Вход: A101, A029, A030. Дорожка: `adapter:hermes`.
Результат: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
Область: `crates/herder/src/adapters/hermes/transcript.rs`.

### A103. Hermes: interrupt и параметры — 30–60 мин

Вход: A102, A025, A034, A032. Дорожка: `adapter:hermes`.
Результат: Только доказанные stop/model/permission methods; unsupported явно, не успех.
Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
Область: `crates/herder/src/adapters/hermes/control.rs`.

### A104. Hermes: подключить context bridge — 25–45 мин

Вход: A103, A046. Дорожка: `adapter:hermes`.
Результат: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
Область: `crates/herder/src/adapters/hermes/context.rs`.

### A105. Hermes: установленная тестовая вертикаль — 30–60 мин

Вход: A104, A051, A016. Дорожка: `adapter:hermes`.
Результат: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
Область: `acceptance/native/hermes/`.

### A106. Fast Agent: подтвердить точный native контракт — 25–45 мин

Вход: A006, A051. Дорожка: `adapter:fast-agent`.
Результат: Один versioned подтверждаемый native transport: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
Область: `acceptance/contracts/fast-agent.md`.

### A107. Fast Agent: соединение одного instance — 30–60 мин

Вход: A106. Дорожка: `adapter:fast-agent`.
Результат: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
Область: `crates/herder/src/adapters/fast_agent/connection.rs`.
Неопределённость: Объём интеграции неизвестен до подтверждения native route предыдущим gate; 30–60 минут покрывают только готовый versioned transport. При отсутствующем API нужны новые slices, прогноз полного срока пока условный.

### A108. Fast Agent: session list и recent — 30–60 мин

Вход: A107, A028. Дорожка: `adapter:fast-agent`.
Результат: Одна подтверждённая native read route → адреса/status/последние user+assistant.
Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
Область: `crates/herder/src/adapters/fast_agent/read.rs`.

### A109. Fast Agent: создать и сверить session ID — 30–60 мин

Вход: A108, A023. Дорожка: `adapter:fast-agent`.
Результат: Одна native create route; request correlation и readback.
Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
Область: `crates/herder/src/adapters/fast_agent/create.rs`.

### A110. Fast Agent: доставить и сверить input — 30–60 мин

Вход: A109, A024. Дорожка: `adapter:fast-agent`.
Результат: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
Область: `crates/herder/src/adapters/fast_agent/deliver.rs`.

### A111. Fast Agent: transcript страницы — 30–60 мин

Вход: A110, A029, A030. Дорожка: `adapter:fast-agent`.
Результат: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
Область: `crates/herder/src/adapters/fast_agent/transcript.rs`.

### A112. Fast Agent: interrupt и параметры — 30–60 мин

Вход: A111, A025, A034, A032. Дорожка: `adapter:fast-agent`.
Результат: Только доказанные stop/model/permission methods; unsupported явно, не успех.
Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
Область: `crates/herder/src/adapters/fast_agent/control.rs`.

### A113. Fast Agent: подключить context bridge — 25–45 мин

Вход: A112, A046. Дорожка: `adapter:fast-agent`.
Результат: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
Область: `crates/herder/src/adapters/fast_agent/context.rs`.

### A114. Fast Agent: установленная тестовая вертикаль — 30–60 мин

Вход: A113, A051, A016. Дорожка: `adapter:fast-agent`.
Результат: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
Область: `acceptance/native/fast-agent/`.

### A115. MiniMax Code: подтвердить точный native контракт — 25–45 мин

Вход: A006, A051. Дорожка: `adapter:minimax-code`.
Результат: Один versioned подтверждаемый ACP/CLI: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
Область: `acceptance/contracts/minimax-code.md`.

### A116. MiniMax Code: соединение одного instance — 30–60 мин

Вход: A115. Дорожка: `adapter:minimax-code`.
Результат: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
Область: `crates/herder/src/adapters/minimax_code/connection.rs`.
Неопределённость: Объём интеграции неизвестен до подтверждения native route предыдущим gate; 30–60 минут покрывают только готовый versioned transport. При отсутствующем API нужны новые slices, прогноз полного срока пока условный.

### A117. MiniMax Code: session list и recent — 30–60 мин

Вход: A116, A028. Дорожка: `adapter:minimax-code`.
Результат: Одна подтверждённая native read route → адреса/status/последние user+assistant.
Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
Область: `crates/herder/src/adapters/minimax_code/read.rs`.

### A118. MiniMax Code: создать и сверить session ID — 30–60 мин

Вход: A117, A023. Дорожка: `adapter:minimax-code`.
Результат: Одна native create route; request correlation и readback.
Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
Область: `crates/herder/src/adapters/minimax_code/create.rs`.

### A119. MiniMax Code: доставить и сверить input — 30–60 мин

Вход: A118, A024. Дорожка: `adapter:minimax-code`.
Результат: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
Область: `crates/herder/src/adapters/minimax_code/deliver.rs`.

### A120. MiniMax Code: transcript страницы — 30–60 мин

Вход: A119, A029, A030. Дорожка: `adapter:minimax-code`.
Результат: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
Область: `crates/herder/src/adapters/minimax_code/transcript.rs`.

### A121. MiniMax Code: interrupt и параметры — 30–60 мин

Вход: A120, A025, A034, A032. Дорожка: `adapter:minimax-code`.
Результат: Только доказанные stop/model/permission methods; unsupported явно, не успех.
Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
Область: `crates/herder/src/adapters/minimax_code/control.rs`.

### A122. MiniMax Code: подключить context bridge — 25–45 мин

Вход: A121, A046. Дорожка: `adapter:minimax-code`.
Результат: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
Область: `crates/herder/src/adapters/minimax_code/context.rs`.

### A123. MiniMax Code: установленная тестовая вертикаль — 30–60 мин

Вход: A122, A051, A016. Дорожка: `adapter:minimax-code`.
Результат: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
Область: `acceptance/native/minimax-code/`.

### A124. ChatGPT: подтвердить точный native контракт — 25–45 мин

Вход: A006, A051. Дорожка: `adapter:chatgpt`.
Результат: Один versioned авторизованный browser profile через разрешённый маршрут: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
Область: `acceptance/contracts/chatgpt.md`.

### A125. ChatGPT: соединение одного instance — 30–60 мин

Вход: A124. Дорожка: `adapter:chatgpt`.
Результат: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
Область: `crates/herder/src/adapters/chatgpt/connection.rs`.
Неопределённость: Объём интеграции неизвестен до подтверждения native route предыдущим gate; 30–60 минут покрывают только готовый versioned transport. При отсутствующем API нужны новые slices, прогноз полного срока пока условный.

### A126. ChatGPT: session list и recent — 30–60 мин

Вход: A125, A028. Дорожка: `adapter:chatgpt`.
Результат: Одна подтверждённая native read route → адреса/status/последние user+assistant.
Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
Область: `crates/herder/src/adapters/chatgpt/read.rs`.

### A127. ChatGPT: создать и сверить session ID — 30–60 мин

Вход: A126, A023. Дорожка: `adapter:chatgpt`.
Результат: Одна native create route; request correlation и readback.
Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
Область: `crates/herder/src/adapters/chatgpt/create.rs`.

### A128. ChatGPT: доставить и сверить input — 30–60 мин

Вход: A127, A024. Дорожка: `adapter:chatgpt`.
Результат: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
Область: `crates/herder/src/adapters/chatgpt/deliver.rs`.

### A129. ChatGPT: transcript страницы — 30–60 мин

Вход: A128, A029, A030. Дорожка: `adapter:chatgpt`.
Результат: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
Область: `crates/herder/src/adapters/chatgpt/transcript.rs`.

### A130. ChatGPT: interrupt и параметры — 30–60 мин

Вход: A129, A025, A034, A032. Дорожка: `adapter:chatgpt`.
Результат: Только доказанные stop/model/permission methods; unsupported явно, не успех.
Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
Область: `crates/herder/src/adapters/chatgpt/control.rs`.

### A131. ChatGPT: подключить context bridge — 25–45 мин

Вход: A130, A046. Дорожка: `adapter:chatgpt`.
Результат: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
Область: `crates/herder/src/adapters/chatgpt/context.rs`.

### A132. ChatGPT: установленная тестовая вертикаль — 30–60 мин

Вход: A131, A051, A016. Дорожка: `adapter:chatgpt`.
Результат: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
Область: `acceptance/native/chatgpt/`.

### A133. Z AI: подтвердить точный native контракт — 25–45 мин

Вход: A006, A051. Дорожка: `adapter:z-ai`.
Результат: Один versioned авторизованный browser profile через разрешённый маршрут: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
Область: `acceptance/contracts/z-ai.md`.

### A134. Z AI: соединение одного instance — 30–60 мин

Вход: A133. Дорожка: `adapter:z-ai`.
Результат: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
Область: `crates/herder/src/adapters/z_ai/connection.rs`.
Неопределённость: Объём интеграции неизвестен до подтверждения native route предыдущим gate; 30–60 минут покрывают только готовый versioned transport. При отсутствующем API нужны новые slices, прогноз полного срока пока условный.

### A135. Z AI: session list и recent — 30–60 мин

Вход: A134, A028. Дорожка: `adapter:z-ai`.
Результат: Одна подтверждённая native read route → адреса/status/последние user+assistant.
Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
Область: `crates/herder/src/adapters/z_ai/read.rs`.

### A136. Z AI: создать и сверить session ID — 30–60 мин

Вход: A135, A023. Дорожка: `adapter:z-ai`.
Результат: Одна native create route; request correlation и readback.
Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
Область: `crates/herder/src/adapters/z_ai/create.rs`.

### A137. Z AI: доставить и сверить input — 30–60 мин

Вход: A136, A024. Дорожка: `adapter:z-ai`.
Результат: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
Область: `crates/herder/src/adapters/z_ai/deliver.rs`.

### A138. Z AI: transcript страницы — 30–60 мин

Вход: A137, A029, A030. Дорожка: `adapter:z-ai`.
Результат: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
Область: `crates/herder/src/adapters/z_ai/transcript.rs`.

### A139. Z AI: interrupt и параметры — 30–60 мин

Вход: A138, A025, A034, A032. Дорожка: `adapter:z-ai`.
Результат: Только доказанные stop/model/permission methods; unsupported явно, не успех.
Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
Область: `crates/herder/src/adapters/z_ai/control.rs`.

### A140. Z AI: подключить context bridge — 25–45 мин

Вход: A139, A046. Дорожка: `adapter:z-ai`.
Результат: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
Область: `crates/herder/src/adapters/z_ai/context.rs`.

### A141. Z AI: установленная тестовая вертикаль — 30–60 мин

Вход: A140, A051, A016. Дорожка: `adapter:z-ai`.
Результат: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
Область: `acceptance/native/z-ai/`.

### A142. Browser Chat: подтвердить точный native контракт — 25–45 мин

Вход: A006, A051. Дорожка: `adapter:browser-chat`.
Результат: Один versioned один явно именованный endpoint/provider из установленного контракта: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
Область: `acceptance/contracts/browser-chat.md`.

### A143. Browser Chat: соединение одного instance — 30–60 мин

Вход: A142. Дорожка: `adapter:browser-chat`.
Результат: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
Область: `crates/herder/src/adapters/browser_chat/connection.rs`.
Неопределённость: Объём интеграции неизвестен до подтверждения native route предыдущим gate; 30–60 минут покрывают только готовый versioned transport. При отсутствующем API нужны новые slices, прогноз полного срока пока условный.

### A144. Browser Chat: session list и recent — 30–60 мин

Вход: A143, A028. Дорожка: `adapter:browser-chat`.
Результат: Одна подтверждённая native read route → адреса/status/последние user+assistant.
Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
Область: `crates/herder/src/adapters/browser_chat/read.rs`.

### A145. Browser Chat: создать и сверить session ID — 30–60 мин

Вход: A144, A023. Дорожка: `adapter:browser-chat`.
Результат: Одна native create route; request correlation и readback.
Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
Область: `crates/herder/src/adapters/browser_chat/create.rs`.

### A146. Browser Chat: доставить и сверить input — 30–60 мин

Вход: A145, A024. Дорожка: `adapter:browser-chat`.
Результат: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
Область: `crates/herder/src/adapters/browser_chat/deliver.rs`.

### A147. Browser Chat: transcript страницы — 30–60 мин

Вход: A146, A029, A030. Дорожка: `adapter:browser-chat`.
Результат: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
Область: `crates/herder/src/adapters/browser_chat/transcript.rs`.

### A148. Browser Chat: interrupt и параметры — 30–60 мин

Вход: A147, A025, A034, A032. Дорожка: `adapter:browser-chat`.
Результат: Только доказанные stop/model/permission methods; unsupported явно, не успех.
Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
Область: `crates/herder/src/adapters/browser_chat/control.rs`.

### A149. Browser Chat: подключить context bridge — 25–45 мин

Вход: A148, A046. Дорожка: `adapter:browser-chat`.
Результат: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
Область: `crates/herder/src/adapters/browser_chat/context.rs`.

### A150. Browser Chat: установленная тестовая вертикаль — 30–60 мин

Вход: A149, A051, A016. Дорожка: `adapter:browser-chat`.
Результат: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
Область: `acceptance/native/browser-chat/`.


## Ранняя поставка

### A151. Выпустить тестовую вертикаль Codex + OpenCode — 30–60 мин

Вход: A060, A069, A003. Дорожка: `release`.
Результат: Установленный dev artifact и один основной MCP client с durable Task polling.
Приёмка: Create/deliver/context работают через реальные adapters; missing extension не скрыт.
Область: `release/dev-vertical/`.


## Сквозная приёмка

### A152. Два Codex instance на одной ноде — 30–60 мин

Вход: A060. Дорожка: `qa`.
Результат: Изолированные profiles и двунаправленная отправка/чтение.
Приёмка: В обоих профилях свои IDs/history; fixture одинакового native ID не смешивает ключи.
Область: `acceptance/multi/codex/`.

### A153. Два Claude instance на одной ноде — 30–60 мин

Вход: A078. Дорожка: `qa`.
Результат: Изолированные connections и проверка control/history.
Приёмка: Отправка и stop одного instance не касаются второго.
Область: `acceptance/multi/claude/`.

### A154. Два браузерных профиля — 30–60 мин

Вход: A132. Дорожка: `qa`.
Результат: Два разрешённых тестовых profile refs и отдельные вкладки.
Приёмка: History/send не пересекают аккаунты; нет использования чужой вкладки или credentials в receipt.
Область: `acceptance/multi/browser/`.

### A155. Две ноды и remote Task readback — 30–60 мин

Вход: A151, A021. Дорожка: `qa`.
Результат: Codex→OpenCode через объявленные endpoints; exact origin refs.
Приёмка: Чтение result с удалённой ноды доступно клиенту; offline coverage partial, no local retry.
Область: `acceptance/multi/nodes/`.

### A156. Creator/sender после компакции — 30–60 мин

Вход: A151, A044, A046, A027. Дорожка: `qa`.
Результат: A создаёт B, C пишет B; очистить context и рестарт Herder; B отвечает C.
Приёмка: Native readback одного ответа C; A остался creator; доказана инъекция, не только resource read.
Область: `acceptance/context/compaction/`.

### A157. Native admission crash matrix — 30–60 мин

Вход: A151, A015. Дорожка: `qa`.
Результат: Три точки сбоя: до вызова, после admission, после completion до ответа.
Приёмка: Повтор key не создаёт input; unknown без native lookup остаётся unknown.
Область: `acceptance/native/crash/`.

### A181. Свежий пользователь: выбор инструмента и errors — 30–60 мин

Вход: A180, A160, A158. Дорожка: `qa`.
Результат: Свежий контекст без исходников: найти роли, исправить wrong mode/field и ответить отправителю.
Приёмка: Trace показывает исправление за один повтор без новых effects; UNKNOWN/forbidden не вызывают unsafe retry.
Область: `acceptance/usability/`.

### A182. Свежий агент при выключенном MCP — 30–60 мин

Вход: A179, A043, A166. Дорожка: `qa`.
Результат: Остановить только test daemon; read markers→claim→безопасный release через runner→receipt.
Приёмка: Ноль вопросов о назначении свободного owner, одна операция; повтор MCP видит тот же owner.
Область: `acceptance/recovery/offline/`.

### A195. Bounded нагрузочный сценарий — 30–60 мин

Вход: A151, A030, A018. Дорожка: `qa`.
Результат: Фиксированный corpus, concurrent read/send/index и slow subscriber; baseline metrics.
Приёмка: Нет busy loop/unbounded queue; latency/RSS и границы workload записаны, starvation не наблюдается.
Область: `acceptance/performance/`.


## Потребители

### A158. CLI обычных операций — 30–60 мин

Вход: A151, A009. Дорожка: `clients`.
Результат: Subcommands из тех же DTO/application, polling Tasks и чтение ресурсов.
Приёмка: create/deliver/read ошибки и completion показаны раздельно; old routes отсутствуют.
Область: `crates/herder/src/cli/main.rs`.

### A159. Web UI чтение и reload — 30–60 мин

Вход: A151, A017. Дорожка: `web`.
Результат: Typed client sessions/recent/transcript, partial/turn refs.
Приёмка: Обычный браузер показывает обе роли после reload и remote resource.
Область: `web/src/session.ts`.

### A160. Web UI действия и Task lifecycle — 30–60 мин

Вход: A159, A033. Дорожка: `web`.
Результат: Create/deliver/stop/settings; standard polling и cancelled/unknown rendering.
Приёмка: Повтор кнопки не даёт duplicate; unknown не предлагает повторную отправку.
Область: `web/src/control.ts`.

### A161. Hub: зафиксировать точный контракт потребителя — 20–40 мин

Вход: A151, A002, A019, A018. Дорожка: `consumer:hub`.
Результат: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route.
Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции.
Область: `integrations/consumers/hub/target.json`.

### A162. Hub: перевести один вызывающий маршрут — 30–60 мин

Вход: A161. Дорожка: `consumer:hub`.
Результат: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях.
Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены.
Область: `consumer:hub:paths-from-target.json`.

### A163. Hub: проверить реальный consumer readback — 30–60 мин

Вход: A162. Дорожка: `consumer:hub`.
Результат: Один изолированный сценарий через обычного потребителя и native result.
Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль.
Область: `acceptance/consumers/hub/`.

### A164. LHC: зафиксировать точный контракт потребителя — 20–40 мин

Вход: A151, A039, A043. Дорожка: `consumer:lhc`.
Результат: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route.
Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции.
Область: `integrations/consumers/lhc/target.json`.

### A165. LHC: перевести один вызывающий маршрут — 30–60 мин

Вход: A164. Дорожка: `consumer:lhc`.
Результат: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях.
Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены.
Область: `consumer:lhc:paths-from-target.json`.

### A166. LHC: проверить реальный consumer readback — 30–60 мин

Вход: A165. Дорожка: `consumer:lhc`.
Результат: Один изолированный сценарий через обычного потребителя и native result.
Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль.
Область: `acceptance/consumers/lhc/`.

### A167. Notice Place: зафиксировать точный контракт потребителя — 20–40 мин

Вход: A151, A035. Дорожка: `consumer:noticeplace`.
Результат: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route.
Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции.
Область: `integrations/consumers/noticeplace/target.json`.

### A168. Notice Place: перевести один вызывающий маршрут — 30–60 мин

Вход: A167. Дорожка: `consumer:noticeplace`.
Результат: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях.
Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены.
Область: `consumer:noticeplace:paths-from-target.json`.

### A169. Notice Place: проверить реальный consumer readback — 30–60 мин

Вход: A168. Дорожка: `consumer:noticeplace`.
Результат: Один изолированный сценарий через обычного потребителя и native result.
Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль.
Область: `acceptance/consumers/noticeplace/`.

### A170. UserIO: зафиксировать точный контракт потребителя — 20–40 мин

Вход: A151, A035, A017. Дорожка: `consumer:userio`.
Результат: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route.
Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции.
Область: `integrations/consumers/userio/target.json`.

### A171. UserIO: перевести один вызывающий маршрут — 30–60 мин

Вход: A170. Дорожка: `consumer:userio`.
Результат: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях.
Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены.
Область: `consumer:userio:paths-from-target.json`.

### A172. UserIO: проверить реальный consumer readback — 30–60 мин

Вход: A171. Дорожка: `consumer:userio`.
Результат: Один изолированный сценарий через обычного потребителя и native result.
Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль.
Область: `acceptance/consumers/userio/`.

### A173. ExManager Board: зафиксировать точный контракт потребителя — 20–40 мин

Вход: A151, A023, A024. Дорожка: `consumer:board`.
Результат: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route.
Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции.
Область: `integrations/consumers/board/target.json`.

### A174. ExManager Board: перевести один вызывающий маршрут — 30–60 мин

Вход: A173. Дорожка: `consumer:board`.
Результат: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях.
Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены.
Область: `consumer:board:paths-from-target.json`.

### A175. ExManager Board: проверить реальный consumer readback — 30–60 мин

Вход: A174. Дорожка: `consumer:board`.
Результат: Один изолированный сценарий через обычного потребителя и native result.
Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль.
Область: `acceptance/consumers/board/`.

### A176. Секретарь: зафиксировать точный контракт потребителя — 20–40 мин

Вход: A151, A150, A049. Дорожка: `consumer:secretary`.
Результат: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route.
Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции.
Область: `integrations/consumers/secretary/target.json`.

### A177. Секретарь: перевести один вызывающий маршрут — 30–60 мин

Вход: A176. Дорожка: `consumer:secretary`.
Результат: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях.
Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены.
Область: `consumer:secretary:paths-from-target.json`.

### A178. Секретарь: проверить реальный consumer readback — 30–60 мин

Вход: A177. Дорожка: `consumer:secretary`.
Результат: Один изолированный сценарий через обычного потребителя и native result.
Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль.
Область: `acceptance/consumers/secretary/`.

### A179. Recovery Skill и локальная инструкция — 30–45 мин

Вход: A019, A039, A045. Дорожка: `docs`.
Результат: Один исходник инструкции и manifest template; expose Skills и package local copy.
Приёмка: Отключённый MCP не мешает найти путь; команды read/claim с подставленным locator и без секретов.
Область: `skills/herder-recovery/SKILL.md`.

### A180. Короткий Skill обычной координации — 30–45 мин

Вход: A019, A156. Дорожка: `docs`.
Результат: context→messages→reply_to, roster/worktree и errors; один источник примеров.
Приёмка: Каталог/schema примеров совпадают; read skill и activation отмечены отдельно.
Область: `skills/herder/SKILL.md`.


## Миграция

### A183. Контракт одноразового импорта — 30–45 мин

Вход: A011, A022, A027, A037. Дорожка: `migration`.
Результат: Узкие схемы только сохраняемого state: holds/intents/lineage/messages/settings/ownership.
Приёмка: Unknown provenance остаётся unknown; список active writers и read-only export для этих схем назван.
Область: `migration/state-map.md`.

### A184. Импорт holds и intents — 30–60 мин

Вход: A183, A016. Дорожка: `migration`.
Результат: Offline importer сохраняет request keys, неизвестные исходы и tombstones; не исполняет ничего.
Приёмка: Fixture повторов и HumanStop после импорта остаётся тем же; input digest/counts записаны.
Область: `migration/import_effects.rs`.

### A185. Импорт lineage/settings/correspondence — 30–60 мин

Вход: A184. Дорожка: `migration`.
Результат: Explicit schema transform, sender evidence, потерянный текст помечен.
Приёмка: Creator не заменён sender; foreign refs не склеены; повтор import безопасен.
Область: `migration/import_context.rs`.

### A186. Ownership cutover без второго writer — 30–60 мин

Вход: A185, A043. Дорожка: `migration`.
Результат: Stop writers → проверка receipts → JSON owner import → старые writers остаются выключены.
Приёмка: Git/DB fallback не активируется при падении MCP; fencing assumptions заменены target runner проверками.
Область: `migration/ownership.rs`.

### A187. Репетиция migration на снимке — 30–60 мин

Вход: A186, A157. Дорожка: `migration`.
Результат: Checksums/counts, run importer дважды, restart, no-send readback.
Приёмка: Ноль native send/create; все holds/UNKNOWN сохранены; корректный отказ при corrupt input.
Область: `acceptance/migration/rehearsal/`.

### A188. Rollback после новых записей — 30–60 мин

Вход: A187. Дорожка: `migration`.
Результат: Maintenance + сохранённый ledger + предыдущий новый binary/schema compatible; старый daemon не включать без reverse proof.
Приёмка: New hold/receipt переживают откат; old writer не получает ownership; rollback отдельно от release.
Область: `release/rollback.md`.

### A189. Репетиция rollback с новым intent — 30–60 мин

Вход: A188. Дорожка: `migration`.
Результат: Изолированный candidate принимает тестовый intent, rollback читает его без replay.
Приёмка: Unknown/confirmed и HumanStop не потеряны; incompatible schema останавливает writes.
Область: `acceptance/migration/rollback/`.


## Поставка

### A190. Артефакт linux/amd64 — 25–50 мин

Вход: A158, A160, A179. Дорожка: `build:linux-amd64`.
Результат: Reproducible locked build с embedded UI/Skills, digest и platform manifest.
Приёмка: Binary запускается в целевой среде/соответствующем runner; cross-compile отдельно от native run; Node daemon не нужен.
Область: `release/build/linux-amd64/`.

### A191. Артефакт linux/arm64 — 25–50 мин

Вход: A158, A160, A179. Дорожка: `build:linux-arm64`.
Результат: Reproducible locked build с embedded UI/Skills, digest и platform manifest.
Приёмка: Binary запускается в целевой среде/соответствующем runner; cross-compile отдельно от native run; Node daemon не нужен.
Область: `release/build/linux-arm64/`.

### A192. Артефакт macos/arm64 — 25–50 мин

Вход: A158, A160, A179. Дорожка: `build:macos-arm64`.
Результат: Reproducible locked build с embedded UI/Skills, digest и platform manifest.
Приёмка: Binary запускается в целевой среде/соответствующем runner; cross-compile отдельно от native run; Node daemon не нужен.
Область: `release/build/macos-arm64/`.

### A193. Артефакт macos/amd64 — 25–50 мин

Вход: A158, A160, A179. Дорожка: `build:macos-amd64`.
Результат: Reproducible locked build с embedded UI/Skills, digest и platform manifest.
Приёмка: Binary запускается в целевой среде/соответствующем runner; cross-compile отдельно от native run; Node daemon не нужен.
Область: `release/build/macos-amd64/`.

### A194. Параметризованный installer — 30–60 мин

Вход: A190, A191, A192, A193. Дорожка: `release`.
Результат: Install artifact/config/manifest/local instruction, preserve data; explicit paths и service launcher.
Приёмка: Нестандартный root работает; offline CLI доступен без daemon; чужой service/config не меняется.
Область: `release/install/`.

### A196. Интеграционное ревью кандидата — 30–60 мин

Вход: A060, A069, A078, A087, A096, A105, A114, A123, A132, A141, A150, A163, A166, A169, A172, A175, A178, A156, A152, A153, A154, A155, A157, A181, A182, A195, A189, A050. Дорожка: `review`.
Результат: Один diff review по boundaries/errors/ownership/cutover; конкретный журнал дефектов.
Приёмка: Все найденные defects имеют owned fix/retest leaf до release; review не выдаёт будущий PASS.
Область: `acceptance/review/`.

### A197. Удалить legacy daemon и registrations — 30–60 мин

Вход: A196, A194. Дорожка: `release`.
Результат: Удалить заменённые TS daemon/job API/_async/aliases из source и package entrypoints.
Приёмка: Старые имена не вызываются напрямую; frontend TS сохранён как frontend; native histories не удалены.
Область: `legacy-removal:runtime paths resolved in reviewed diff`.

### A198. Удалить legacy active clients/launchers — 30–45 мин

Вход: A197. Дорожка: `release`.
Результат: Пакеты/hooks/docs consumers используют новый API; прежние fallback writers disabled.
Приёмка: Legacy references только в историческом archive; runtime graph не запускает старый daemon.
Область: `legacy-removal:active client paths from consumer targets`.

### A199. Зафиксировать immutable release candidate — 30–45 мин

Вход: A198. Дорожка: `release`.
Результат: Build exact reviewed source после удаления legacy, manifests всех платформ.
Приёмка: Каждая тестовая lane указывает один source revision/artifact family; чужой WIP не включён.
Область: `release/candidate.json`.

### A200. Candidate: контроль codex — 20–45 мин

Вход: A199, A060. Дорожка: `adapter:codex`.
Результат: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
Область: `acceptance/candidate/codex/`.

### A201. Candidate: контроль opencode — 20–45 мин

Вход: A199, A069. Дорожка: `adapter:opencode`.
Результат: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
Область: `acceptance/candidate/opencode/`.

### A202. Candidate: контроль claude — 20–45 мин

Вход: A199, A078. Дорожка: `adapter:claude`.
Результат: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
Область: `acceptance/candidate/claude/`.

### A203. Candidate: контроль zcode — 20–45 мин

Вход: A199, A087. Дорожка: `adapter:zcode`.
Результат: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
Область: `acceptance/candidate/zcode/`.

### A204. Candidate: контроль qoder — 20–45 мин

Вход: A199, A096. Дорожка: `adapter:qoder`.
Результат: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
Область: `acceptance/candidate/qoder/`.

### A205. Candidate: контроль hermes — 20–45 мин

Вход: A199, A105. Дорожка: `adapter:hermes`.
Результат: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
Область: `acceptance/candidate/hermes/`.

### A206. Candidate: контроль fast-agent — 20–45 мин

Вход: A199, A114. Дорожка: `adapter:fast-agent`.
Результат: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
Область: `acceptance/candidate/fast-agent/`.

### A207. Candidate: контроль minimax-code — 20–45 мин

Вход: A199, A123. Дорожка: `adapter:minimax-code`.
Результат: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
Область: `acceptance/candidate/minimax-code/`.

### A208. Candidate: контроль chatgpt — 20–45 мин

Вход: A199, A132. Дорожка: `adapter:chatgpt`.
Результат: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
Область: `acceptance/candidate/chatgpt/`.

### A209. Candidate: контроль z-ai — 20–45 мин

Вход: A199, A141. Дорожка: `adapter:z-ai`.
Результат: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
Область: `acceptance/candidate/z-ai/`.

### A210. Candidate: контроль browser-chat — 20–45 мин

Вход: A199, A150. Дорожка: `adapter:browser-chat`.
Результат: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
Область: `acceptance/candidate/browser-chat/`.

### A211. Candidate: проверка соединённых consumers — 30–45 мин

Вход: A199, A163, A166, A169, A172, A175, A178. Дорожка: `clients`.
Результат: Сверить ранее полученные consumer proofs с API/schema digest RC; повторить затронутый основной путь.
Приёмка: Несовпадение digest требует отдельной адресной проверки; нельзя принять устаревший receipt.
Область: `acceptance/candidate/consumers/`.

### A212. Preflight cutover и резервная копия — 30–45 мин

Вход: A194, A189, A200, A201, A202, A203, A204, A205, A206, A207, A208, A209, A210, A211. Дорожка: `release`.
Результат: Проверить точные target/config/version/права, snapshot и maintenance window выбранного выпуска.
Приёмка: Нет неизвестных active writers/release effects; backup восстановим; fail-fast до остановки.
Область: `release/cutover/preflight.json`.

### A213. Переключить state и единственного writer — 30–60 мин

Вход: A212. Дорожка: `release`.
Результат: Остановить старый entrypoint, выполнить проверенный импорт и установить Linux target candidate.
Приёмка: Новый runtime SHA/digest/schema; один owner writer; не возобновлены UNKNOWN или HumanStop.
Область: `release/cutover/linux/`.

### A214. Linux: обычный потребитель после установки — 30–60 мин

Вход: A213. Дорожка: `qa`.
Результат: Primary MCP consumer create/deliver/recent/export/context на тестовых сессиях, reload.
Приёмка: Runtime→receipt→native readback доказаны; приложение работает после штатного restart.
Область: `acceptance/installed/linux/`.

### A215. macOS: установка точного артефакта — 30–60 мин

Вход: A214, A194. Дорожка: `release`.
Результат: Target preflight, config/manifest, штатный launcher; без чужих profiles.
Приёмка: Artifact digest и version совпали, offline path установлен; rollback доступен.
Область: `release/cutover/macos/`.

### A216. macOS: обычный потребитель после установки — 30–60 мин

Вход: A215. Дорожка: `qa`.
Результат: Create/read/deliver/stop и restart конкретного native instance.
Приёмка: Installed consumer readback, permissions и native filesystem semantics доказаны.
Область: `acceptance/installed/macos/`.


## Передача

### A217. Независимая приёмка общения — 30–60 мин

Вход: A214, A216, A156. Дорожка: `qa`.
Результат: Свежий tester без кода/авторского отчёта: discover→create→deliver→read→stop и compaction reply.
Приёмка: Правильный sender/creator и отсутствие duplicate; тестовый circuit, никаких звонков людям.
Область: `acceptance/independent/communication/`.

### A218. Независимая приёмка recovery — 30–60 мин

Вход: A217, A182. Дорожка: `qa`.
Результат: Свежий tester по локальному Skill при выключенном test MCP; checkout conflict и release receipt.
Приёмка: Успешный claim без назначения человеком; UNKNOWN не повторён; wrong root не свободен.
Область: `acceptance/independent/recovery/`.

### A219. Main, runbook и передача результата — 30–45 мин

Вход: A218. Дорожка: `release`.
Результат: Только owned commits; опубликованный main, artifacts и acceptance manifest; чистка только своих принятых временных сред.
Приёмка: Remote main включает результат; zero unresolved mandatory defects; scope exclusions названы и явно приняты, не молча вычеркнуты.
Область: `release/handoff/`.
