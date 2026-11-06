# Рабочий план Agent Herder v1 — нулевая ревизия

159 исполнимых листьев V001–V159 по 20–60 минут. Только Codex, OpenCode, ZCode, ChatGPT и Z.ai. Нет deferred/history leaves; прежние версии сохранены вне рабочего графа. Исполнители ещё не назначены.

Каждый лист получает результаты depends_on и текущие SPEC/RUST-DESIGN/COORDINATION/RECOVERY-STORAGE. В consumer:... точные repo/files обязательны из предыдущего target.json gate. Отсутствующее native API не оценивается фиктивным часом: gate фиксирует пробел, зависимая реализация переразбивается. Дорожка допускает только одного одновременно пишущего исполнителя; независимые дорожки могут идти параллельно.

Оценки и проверенный ресурсный календарь: ESTIMATES.md. Входные данные и канонические leaves согласованы.

## Основа

### V001. Закрепить SDK и собрать минимальный wire probe — 30–45 мин

Вход: официальные источники MCP-EVIDENCE и scope v1. Дорожка: `core`.
Результат: Cargo.lock/toolchain и probe server/discover → tools/call на rmcp 3.9.0.
Приёмка: Записаны версии/feature flags; процесс запускается и отдаёт обязательный resultType. Если compile не проходит, точный минимальный failure и пересмотр до адаптеров.
Область: `crates/herder/Cargo.toml`.

### V002. Проверить Tasks/Skills/subscriptions выбранного SDK — 30–60 мин

Вход: V001. Дорожка: `core`.
Результат: Wire transcript get/update/cancel, skills/list/get/read и listen; без native эффектов.
Приёмка: Capabilities проверяются до возврата Task; отсутствуют tasks/list/result; найденные SDK пробелы названы.
Область: `tests/protocol/sdk_probe.rs`.

### V003. Проверить конкретный основной MCP-клиент — 30–60 мин

Вход: V002. Дорожка: `clients`.
Результат: Один объявленный потребитель подключается к probe; revision/extensions/identity matrix.
Приёмка: Есть прямой trace реального клиента, не SDK talking to itself; unsupported блокирует gate и зависимую реализацию.
Область: `acceptance/contracts/primary-client.json`.

### V004. Конфигурация Node и HarnessInstance — 30–45 мин

Вход: V001. Дорожка: `core`.
Результат: Typed config nodes/instances/profiles/authority/secret refs; duplicate ID validation.
Приёмка: Два профиля одного типа независимы; hostname/root не зашиты; диагностика неверного поля.
Область: `crates/herder/src/config.rs`.

### V005. Типы адресов и capabilities — 30–45 мин

Вход: V004. Дорожка: `core`.
Результат: Node/instance/session refs, supported/available/authorized отдельно; версии capability.
Приёмка: Одинаковые native IDs в разных instance не равны; offline не unsupported.
Область: `crates/herder/src/domain/address.rs`.

### V006. Контракт pure core и native port — 30–45 мин

Вход: V005. Дорожка: `core`.
Результат: DTO Admission/Unknown/Receipt и маленькие reader/control ports; enum registry.
Приёмка: Табличный pure decision test без I/O; fake submit различает never sent и unknown.
Область: `crates/herder/src/domain/adapter.rs`.

### V007. Одна диагностическая схема ошибок — 30–45 мин

Вход: V006. Дорожка: `core`.
Результат: field/received/expected/fix/effect/retry/receipt; redaction секретов.
Приёмка: Wrong mode и conflict reply_to дают однозначный исправляемый вызов без mutation.
Область: `crates/herder/src/error.rs`.

### V008. Привязать caller и области доступа — 30–60 мин

Вход: V005. Дорожка: `security`.
Результат: Verified principal/self binding; deny-by-default для private session и ресурсов.
Приёмка: Подмена sender/session_ref и общий node token не дают self; auth не следует из parent.
Область: `crates/herder/src/auth/identity.rs`.

### V009. Реестр 14 инструментов и typed variants — 30–45 мин

Вход: V007, V002. Дорожка: `core`.
Результат: Единая декларация discovery/dispatch с oneOf schemas; actions read/mutate разделены.
Приёмка: tools/list совпадает с dispatch; дополнительные поля/legacy names отвергаются.
Область: `crates/herder/src/mcp/catalog.rs`.

### V010. HTTP и stdio без legacy negotiation — 30–60 мин

Вход: V009, V003, V008. Дорожка: `core`.
Результат: Транспорт SDK, обязательная request metadata, shutdown; application entrypoint.
Приёмка: Основной клиент читает catalog обоими поддерживаемыми транспортами; wrong revision до эффекта.
Область: `crates/herder/src/mcp/transport.rs`.

### V011. SQLite схема и транзакционные границы — 30–60 мин

Вход: V006. Дорожка: `storage`.
Результат: Таблицы tasks/intents/messages/holds/lineage/settings; migration version.
Приёмка: Rollback transaction не оставляет half intent; новый schema version запрещает запись старому binary.
Область: `crates/herder/src/store/schema.sql`.

### V012. Атомарное принятие идемпотентного intent — 30–60 мин

Вход: V011, V008, V007. Дорожка: `storage`.
Результат: Unique principal/target/request_key + payload hash и CAS prepared→dispatching.
Приёмка: Два одновременных обработчика вызывают fake submit один раз; conflict payload отклоняется.
Область: `crates/herder/src/store/intents.rs`.

### V013. Durable стандартные Tasks get/create — 30–60 мин

Вход: V012, V010. Дорожка: `storage`.
Результат: SDK wire types и SQLite backend без in-memory authority.
Приёмка: Task сохранён до ответа, polling после рестарта читает тот же ID/result.
Область: `crates/herder/src/mcp/tasks.rs`.

### V014. Tasks update и cooperative cancel — 30–60 мин

Вход: V013. Дорожка: `storage`.
Результат: Persist pending inputs и ответы по ключам; cancel intent отдельно от effect outcome.
Приёмка: Повтор input не продолжает дважды; cancel после admission не выдаёт отмену эффекта.
Область: `crates/herder/src/store/task_inputs.rs`.

### V015. Reconcile неопределённой native отправки — 30–60 мин

Вход: V014. Дорожка: `storage`.
Результат: Restart dispatcher читает native receipt по стабильной корреляции, без send.
Приёмка: Kill после dispatching/admission даёт confirmed или unknown; unknown не получает safe retry.
Область: `crates/herder/src/application/reconcile.rs`.

### V016. Разделить Task TTL и receipt retention — 30–45 мин

Вход: V015. Дорожка: `storage`.
Результат: Tombstone дедупликации/удалённого текста, правила expiry.
Приёмка: Истёкший Task и удалённый transcript не позволяют повтор request_key выполнить эффект.
Область: `crates/herder/src/store/retention.rs`.

### V017. Ресурсы с ACL и приватным cache — 30–60 мин

Вход: V010, V013, V008. Дорожка: `protocol`.
Результат: Session/task/transcript resources с remote-readable refs и pagination.
Приёмка: Другой principal не читает result/Task; cacheScope private и ttlMs корректны.
Область: `crates/herder/src/mcp/resources.rs`.

### V018. Подписки с bounded очередью и resync — 30–60 мин

Вход: V017. Дорожка: `protocol`.
Результат: subscriptions/listen filters; drop→snapshot, без SSE replay.
Приёмка: Медленный клиент не блокирует ноду; reconnect видит current revision без дублирования эффектов.
Область: `crates/herder/src/mcp/subscriptions.rs`.

### V019. Статический Skills manifest — 30–45 мин

Вход: V017. Дорожка: `protocol`.
Результат: skills/list/get и resources/read с digest; directoryRead не объявлен.
Приёмка: Проверены manifest boundary, приватность и content hash; read не объявляет activation.
Область: `crates/herder/src/mcp/skills.rs`.

### V020. Маршрутизация к owner Node — 30–60 мин

Вход: V010, V005. Дорожка: `protocol`.
Результат: Peer auth, точный instance, deadline и сохранение errors; без local fallback.
Приёмка: Две конфигурируемые ноды; чужой scope denied, недоступный origin остаётся unavailable.
Область: `crates/herder/src/peer/route.rs`.

### V021. Удалённые Tasks и resources без второго lifecycle — 30–60 мин

Вход: V020, V013, V017. Дорожка: `protocol`.
Результат: Origin Task ref и маршрутизация standard polling/cancel/read по ACL.
Приёмка: Proxy restart не дублирует native intent; origin task/result остаются теми же.
Область: `crates/herder/src/peer/tasks.rs`.

### V022. Долговечный creator и native parent — 30–45 мин

Вход: V012. Дорожка: `core`.
Результат: Создатель в create intent, native parent и происхождение отдельно.
Приёмка: Restart между intent и native receipt не меняет creator; неизвестное происхождение не угадано.
Область: `crates/herder/src/store/lineage.rs`.

### V023. Общий create с точным instance — 30–60 мин

Вход: V022, V006, V021. Дорожка: `core`.
Результат: Application create проверяет capability/auth и связывает intent с native ID.
Приёмка: Fake native create вызывается один раз; completion только после session readback.
Область: `crates/herder/src/application/create.rs`.

### V024. Общий deliver с явным режимом — 30–60 мин

Вход: V023, V015. Дорожка: `core`.
Результат: current/queue/start, expected turn; implicit create и delayed send отсутствуют.
Приёмка: Busy/unsupported не подменяют режим; persisted intent предшествует submit.
Область: `crates/herder/src/application/deliver.rs`.

### V025. HumanStop на admission boundary — 30–60 мин

Вход: V024. Дорожка: `core`.
Результат: Durable hold перед interrupt; dispatch/stop сериализуют admission.
Приёмка: Race stop/deliver: post-hold send не стартует; уже принятое действие отражено честно.
Область: `crates/herder/src/application/stop.rs`.

### V026. Одноразовое resume — 30–45 мин

Вход: V025. Дорожка: `core`.
Результат: Один request_key → один native turn; HumanStop требует отдельного человеческого права на снятие.
Приёмка: Дубликат resume не создаёт ход; флаг humanRequested от модели не снимает hold.
Область: `crates/herder/src/application/resume.rs`.

### V027. Журнал и reply_to — 30–60 мин

Вход: V024, V022, V008. Дорожка: `storage`.
Результат: Transaction связывает sender/recipient/message_ref с intent; reply target берётся сервером.
Приёмка: C→B и ответ B адресованы C; A creator не подменяется; чужой reply_to denied.
Область: `crates/herder/src/store/correspondence.rs`.

### V028. Recent обеих ролей — 30–45 мин

Вход: V006, V017. Дорожка: `core`.
Результат: Общий projection user+assistant с turn/time/partial; read-only session.
Приёмка: Старый assistant не назван ответом на новый input; отсутствующий источник не пустая история.
Область: `crates/herder/src/application/recent.rs`.

### V029. Transcript snapshot и cursor — 30–45 мин

Вход: V028. Дорожка: `core`.
Результат: Нормализованные blocks, raw ref и подписанный/привязанный snapshot cursor.
Приёмка: Чужой cursor отвергнут; последняя страница, truncation и snapshot boundary проверены.
Область: `crates/herder/src/domain/transcript.rs`.

### V030. Инкрементальный поиск — 30–60 мин

Вход: V029, V011. Дорожка: `storage`.
Результат: SQLite FTS и source cursors; обновление только изменённой сессии.
Приёмка: Одна новая запись не сканирует весь corpus; ACL и coverage сохраняются.
Область: `crates/herder/src/search/index.rs`.

### V031. Sessions/discover и coverage — 30–45 мин

Вход: V030, V020. Дорожка: `core`.
Результат: Постраничный список по project/instance; native availability отдельно от cached records.
Приёмка: Offline peer явно отмечен, одинаковые basename не склеены.
Область: `crates/herder/src/application/list.rs`.

### V032. Модели и квоты профиля — 30–45 мин

Вход: V031. Дорожка: `core`.
Результат: discover(kind=models) отдаёт verified catalog и unknown значения.
Приёмка: Два профиля не разделяют auth/quota cache, unknown не zero/unlimited.
Область: `crates/herder/src/application/models.rs`.

### V033. Configure desired/applied CAS — 30–60 мин

Вход: V032, V008. Дорожка: `core`.
Результат: Node/instance/session settings поддерживаются только при capability, typed patches.
Приёмка: Stale revision отвергнут; remote unavailable не applied; scope проверяется.
Область: `crates/herder/src/application/settings.rs`.

### V034. Точный native permission request — 30–45 мин

Вход: V033, V014. Дорожка: `core`.
Результат: Pending request identity и authorized answer, без wildcard approvals.
Приёмка: Expired ID не отвечает другому request; duplicate answer идемпотентен.
Область: `crates/herder/src/application/permission.rs`.

### V035. Внешний вопрос и MCP input раздельно — 30–60 мин

Вход: V034, V026. Дорожка: `core`.
Результат: MRTR/Task input и external correlation используют одну delivery boundary.
Приёмка: Ответ относится одной сессии, повтор callback не даёт два resume; внешняя отправка только в test route.
Область: `crates/herder/src/application/human.rs`.


## Владение

### V036. Manifest канонического storage — 30–45 мин

Вход: V004, V008. Дорожка: `ownership`.
Результат: Storage/project/resource markers, точный offline locator и ACL policy.
Приёмка: Wrong root/storage/mount loss отличаются от owner ENOENT; секретов нет.
Область: `crates/herder/src/ownership/manifest.rs`.

### V037. Одна owner запись и OS lock — 30–60 мин

Вход: V036. Дорожка: `ownership`.
Результат: Claim/renew/release с UUID epoch, atomic rename/unlink+fsync, CAS claim ID.
Приёмка: Concurrent claims имеют одного победителя; release чужого ID denied; нет state.json transaction.
Область: `crates/herder/src/ownership/claim.rs`.

### V038. Crash proof файловых переходов — 30–60 мин

Вход: V037. Дорожка: `ownership`.
Результат: Fault injection до/после rename/unlink/fsync; leftover temp cleanup под lock.
Приёмка: Полный old/new owner или отсутствие; fsync failure unknown; guard inode не заменён.
Область: `tests/ownership/crash.rs`.

### V039. Offline CLI поверх той же библиотеки — 30–45 мин

Вход: V038. Дорожка: `ownership`.
Результат: herder ownership без запуска daemon/SQLite/MCP; JSON и русские ошибки.
Приёмка: Потерянный claim response читается по nonce без automatic reclaim после release.
Область: `crates/herder/src/cli/ownership.rs`.

### V040. Workspace declarations и общий claim route — 30–60 мин

Вход: V037, V031. Дорожка: `ownership`.
Результат: Project/worktree identity/scopes/notes; MCP ownership вызывает ту же библиотеку.
Приёмка: Декларация не lease; две ноды одного shared workspace используют один resource.
Область: `crates/herder/src/application/workspace.rs`.

### V041. Единственная точка release admission — 30–60 мин

Вход: V039. Дорожка: `ownership`.
Результат: Target-local lock, live claim check после lock, expected deployed revision.
Приёмка: Задержавшийся старый claim отвергнут; второй runner path запрещён конфигурацией.
Область: `crates/herder/src/ownership/release_runner.rs`.

### V042. Durable release receipt до spawn — 30–60 мин

Вход: V041. Дорожка: `ownership`.
Результат: Request key/hash, admitted/confirmed/unknown; child удерживает execution lock.
Приёмка: Crash родителя не отпускает live child; unknown external effect блокирует новый конфликтующий effect.
Область: `crates/herder/src/ownership/release_receipt.rs`.

### V043. Гонка release и смена owner — 30–60 мин

Вход: V042, V040. Дорожка: `ownership`.
Результат: Test runner делает безопасный локальный file revision effect; delay/crash/partition.
Приёмка: Максимум один эффект; повтор key только readback; lost authority запрещает новый admission.
Область: `tests/ownership/release_races.rs`.


## Координация

### V044. Context self/creator/senders/peers — 30–60 мин

Вход: V027, V040, V028. Дорожка: `core`.
Результат: Один bounded snapshot с адресами, scopes, coverage и курсорами.
Приёмка: A creator и C sender восстанавливаются без transcript memory; чужие closed sessions скрыты.
Область: `crates/herder/src/application/context.rs`.

### V045. Offline context snapshot — 30–45 мин

Вход: V044, V039. Дорожка: `ownership`.
Результат: Atomic JSON projection c generated_at, coverage и безопасными routes.
Приёмка: Без daemon читается stale snapshot; это не owner или delivery receipt.
Область: `crates/herder/src/ownership/context_snapshot.rs`.

### V046. Контекстные generation и native hook client — 30–60 мин

Вход: V044, V018, V025. Дорожка: `core`.
Результат: Projector snapshot/delta, новый context generation не подавляется fingerprint.
Приёмка: Fake compact event вызывает snapshot без нового model turn и без снятия STOP.
Область: `integrations/hooks/context_client.rs`.


## Автоматизация

### V047. Typed automation rules — 30–60 мин

Вход: V033, V026. Дорожка: `core`.
Результат: Schedule/one-shot и autopilot в одном CRUD; timezone, missed/overlap, CAS.
Приёмка: Неверный cron объясняется; настройка не создаёт parallel job API.
Область: `crates/herder/src/automation/rules.rs`.

### V048. Один admission executor триггеров — 30–60 мин

Вход: V047. Дорожка: `core`.
Результат: Trigger ID + правило + native turn → постоянный delivery request_key.
Приёмка: Hook/observer/end-turn повтор не создаёт второй continuation; hold всегда проверен.
Область: `crates/herder/src/automation/executor.rs`.

### V049. DST/restart/pause расписания — 30–45 мин

Вход: V048. Дорожка: `core`.
Результат: Clock как вход pure reducer; bounded catch-up и no overlap.
Приёмка: DST fold/gap, restart после admission и pause не дают дубля.
Область: `tests/automation/schedule.rs`.

### V050. Остановка автопилота по цели/бюджету — 30–60 мин

Вход: V048. Дорожка: `core`.
Результат: Existing goal judge contract как input; bounded continuation, явный failure.
Приёмка: Goal done, quota unknown/denied и HumanStop не вызывают retry-loop; одна continuation на turn.
Область: `crates/herder/src/automation/autopilot.rs`.


## Адаптеры

### V051. Нативный тестовый контур и endpoint — 30–60 мин

Вход: V010, V023, V025. Дорожка: `qa`.
Результат: Изолированные profiles, deterministic model endpoint для поддерживающих клиентов, receipt schema.
Приёмка: Native процесс отличим от fake adapter; никакого личного аккаунта/звонка; отдельные browser test identities.
Область: `tests/native/harness_runner.rs`.

### V052. Codex: подтвердить точный native контракт — 25–45 мин

Вход: V006, V051. Дорожка: `adapter:codex`.
Результат: Один versioned app-server JSON-RPC: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
Область: `acceptance/contracts/codex.md`.

### V053. Codex: соединение одного instance — 30–60 мин

Вход: V052. Дорожка: `adapter:codex`.
Результат: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
Область: `crates/herder/src/adapters/codex/connection.rs`.
Неопределённость: Объём интеграции неизвестен до подтверждения native route предыдущим gate; 30–60 минут покрывают только готовый versioned transport. При отсутствующем API нужны новые slices, прогноз полного срока пока условный.

### V054. Codex: session list и recent — 30–60 мин

Вход: V053, V028. Дорожка: `adapter:codex`.
Результат: Одна подтверждённая native read route → адреса/status/последние user+assistant.
Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
Область: `crates/herder/src/adapters/codex/read.rs`.

### V055. Codex: создать и сверить session ID — 30–60 мин

Вход: V054, V023. Дорожка: `adapter:codex`.
Результат: Одна native create route; request correlation и readback.
Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
Область: `crates/herder/src/adapters/codex/create.rs`.

### V056. Codex: доставить и сверить input — 30–60 мин

Вход: V055, V024. Дорожка: `adapter:codex`.
Результат: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
Область: `crates/herder/src/adapters/codex/deliver.rs`.

### V057. Codex: transcript страницы — 30–60 мин

Вход: V056, V029, V030. Дорожка: `adapter:codex`.
Результат: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
Область: `crates/herder/src/adapters/codex/transcript.rs`.

### V058. Codex: interrupt и параметры — 30–60 мин

Вход: V057, V025, V034, V032. Дорожка: `adapter:codex`.
Результат: Только доказанные stop/model/permission methods; unsupported явно, не успех.
Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
Область: `crates/herder/src/adapters/codex/control.rs`.

### V059. Codex: подключить context bridge — 25–45 мин

Вход: V058, V046. Дорожка: `adapter:codex`.
Результат: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
Область: `crates/herder/src/adapters/codex/context.rs`.

### V060. Codex: установленная тестовая вертикаль — 30–60 мин

Вход: V059, V051, V016. Дорожка: `adapter:codex`.
Результат: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
Область: `acceptance/native/codex/`.

### V061. OpenCode: подтвердить точный native контракт — 25–45 мин

Вход: V006, V051. Дорожка: `adapter:opencode`.
Результат: Один versioned HTTP/events: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
Область: `acceptance/contracts/opencode.md`.

### V062. OpenCode: соединение одного instance — 30–60 мин

Вход: V061. Дорожка: `adapter:opencode`.
Результат: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
Область: `crates/herder/src/adapters/opencode/connection.rs`.
Неопределённость: Объём интеграции неизвестен до подтверждения native route предыдущим gate; 30–60 минут покрывают только готовый versioned transport. При отсутствующем API нужны новые slices, прогноз полного срока пока условный.

### V063. OpenCode: session list и recent — 30–60 мин

Вход: V062, V028. Дорожка: `adapter:opencode`.
Результат: Одна подтверждённая native read route → адреса/status/последние user+assistant.
Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
Область: `crates/herder/src/adapters/opencode/read.rs`.

### V064. OpenCode: создать и сверить session ID — 30–60 мин

Вход: V063, V023. Дорожка: `adapter:opencode`.
Результат: Одна native create route; request correlation и readback.
Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
Область: `crates/herder/src/adapters/opencode/create.rs`.

### V065. OpenCode: доставить и сверить input — 30–60 мин

Вход: V064, V024. Дорожка: `adapter:opencode`.
Результат: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
Область: `crates/herder/src/adapters/opencode/deliver.rs`.

### V066. OpenCode: transcript страницы — 30–60 мин

Вход: V065, V029, V030. Дорожка: `adapter:opencode`.
Результат: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
Область: `crates/herder/src/adapters/opencode/transcript.rs`.

### V067. OpenCode: interrupt и параметры — 30–60 мин

Вход: V066, V025, V034, V032. Дорожка: `adapter:opencode`.
Результат: Только доказанные stop/model/permission methods; unsupported явно, не успех.
Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
Область: `crates/herder/src/adapters/opencode/control.rs`.

### V068. OpenCode: подключить context bridge — 25–45 мин

Вход: V067, V046. Дорожка: `adapter:opencode`.
Результат: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
Область: `crates/herder/src/adapters/opencode/context.rs`.

### V069. OpenCode: установленная тестовая вертикаль — 30–60 мин

Вход: V068, V051, V016. Дорожка: `adapter:opencode`.
Результат: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
Область: `acceptance/native/opencode/`.

### V070. ZCode: подтвердить точный native контракт — 25–45 мин

Вход: V006, V051. Дорожка: `adapter:zcode`.
Результат: Один versioned подтверждаемый native session transport: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
Область: `acceptance/contracts/zcode.md`.

### V071. ZCode: соединение одного instance — 30–60 мин

Вход: V070. Дорожка: `adapter:zcode`.
Результат: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
Область: `crates/herder/src/adapters/zcode/connection.rs`.
Неопределённость: Объём интеграции неизвестен до подтверждения native route предыдущим gate; 30–60 минут покрывают только готовый versioned transport. При отсутствующем API нужны новые slices, прогноз полного срока пока условный.

### V072. ZCode: session list и recent — 30–60 мин

Вход: V071, V028. Дорожка: `adapter:zcode`.
Результат: Одна подтверждённая native read route → адреса/status/последние user+assistant.
Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
Область: `crates/herder/src/adapters/zcode/read.rs`.

### V073. ZCode: создать и сверить session ID — 30–60 мин

Вход: V072, V023. Дорожка: `adapter:zcode`.
Результат: Одна native create route; request correlation и readback.
Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
Область: `crates/herder/src/adapters/zcode/create.rs`.

### V074. ZCode: доставить и сверить input — 30–60 мин

Вход: V073, V024. Дорожка: `adapter:zcode`.
Результат: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
Область: `crates/herder/src/adapters/zcode/deliver.rs`.

### V075. ZCode: transcript страницы — 30–60 мин

Вход: V074, V029, V030. Дорожка: `adapter:zcode`.
Результат: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
Область: `crates/herder/src/adapters/zcode/transcript.rs`.

### V076. ZCode: interrupt и параметры — 30–60 мин

Вход: V075, V025, V034, V032. Дорожка: `adapter:zcode`.
Результат: Только доказанные stop/model/permission methods; unsupported явно, не успех.
Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
Область: `crates/herder/src/adapters/zcode/control.rs`.

### V077. ZCode: подключить context bridge — 25–45 мин

Вход: V076, V046. Дорожка: `adapter:zcode`.
Результат: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
Область: `crates/herder/src/adapters/zcode/context.rs`.

### V078. ZCode: установленная тестовая вертикаль — 30–60 мин

Вход: V077, V051, V016. Дорожка: `adapter:zcode`.
Результат: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
Область: `acceptance/native/zcode/`.

### V079. ChatGPT: подтвердить точный native контракт — 25–45 мин

Вход: V006, V051. Дорожка: `adapter:chatgpt`.
Результат: Один versioned авторизованный browser profile через разрешённый маршрут: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
Область: `acceptance/contracts/chatgpt.md`.

### V080. ChatGPT: соединение одного instance — 30–60 мин

Вход: V079. Дорожка: `adapter:chatgpt`.
Результат: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
Область: `crates/herder/src/adapters/chatgpt/connection.rs`.
Неопределённость: Объём интеграции неизвестен до подтверждения native route предыдущим gate; 30–60 минут покрывают только готовый versioned transport. При отсутствующем API нужны новые slices, прогноз полного срока пока условный.

### V081. ChatGPT: session list и recent — 30–60 мин

Вход: V080, V028. Дорожка: `adapter:chatgpt`.
Результат: Одна подтверждённая native read route → адреса/status/последние user+assistant.
Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
Область: `crates/herder/src/adapters/chatgpt/read.rs`.

### V082. ChatGPT: создать и сверить session ID — 30–60 мин

Вход: V081, V023. Дорожка: `adapter:chatgpt`.
Результат: Одна native create route; request correlation и readback.
Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
Область: `crates/herder/src/adapters/chatgpt/create.rs`.

### V083. ChatGPT: доставить и сверить input — 30–60 мин

Вход: V082, V024. Дорожка: `adapter:chatgpt`.
Результат: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
Область: `crates/herder/src/adapters/chatgpt/deliver.rs`.

### V084. ChatGPT: transcript страницы — 30–60 мин

Вход: V083, V029, V030. Дорожка: `adapter:chatgpt`.
Результат: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
Область: `crates/herder/src/adapters/chatgpt/transcript.rs`.

### V085. ChatGPT: interrupt и параметры — 30–60 мин

Вход: V084, V025, V034, V032. Дорожка: `adapter:chatgpt`.
Результат: Только доказанные stop/model/permission methods; unsupported явно, не успех.
Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
Область: `crates/herder/src/adapters/chatgpt/control.rs`.

### V086. ChatGPT: подключить context bridge — 25–45 мин

Вход: V085, V046. Дорожка: `adapter:chatgpt`.
Результат: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
Область: `crates/herder/src/adapters/chatgpt/context.rs`.

### V087. ChatGPT: установленная тестовая вертикаль — 30–60 мин

Вход: V086, V051, V016. Дорожка: `adapter:chatgpt`.
Результат: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
Область: `acceptance/native/chatgpt/`.

### V088. Z.ai: подтвердить точный native контракт — 25–45 мин

Вход: V006, V051. Дорожка: `adapter:z-ai`.
Результат: Один versioned авторизованный browser profile через разрешённый маршрут: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
Область: `acceptance/contracts/z-ai.md`.

### V089. Z.ai: соединение одного instance — 30–60 мин

Вход: V088. Дорожка: `adapter:z-ai`.
Результат: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
Область: `crates/herder/src/adapters/z_ai/connection.rs`.
Неопределённость: Объём интеграции неизвестен до подтверждения native route предыдущим gate; 30–60 минут покрывают только готовый versioned transport. При отсутствующем API нужны новые slices, прогноз полного срока пока условный.

### V090. Z.ai: session list и recent — 30–60 мин

Вход: V089, V028. Дорожка: `adapter:z-ai`.
Результат: Одна подтверждённая native read route → адреса/status/последние user+assistant.
Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
Область: `crates/herder/src/adapters/z_ai/read.rs`.

### V091. Z.ai: создать и сверить session ID — 30–60 мин

Вход: V090, V023. Дорожка: `adapter:z-ai`.
Результат: Одна native create route; request correlation и readback.
Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
Область: `crates/herder/src/adapters/z_ai/create.rs`.

### V092. Z.ai: доставить и сверить input — 30–60 мин

Вход: V091, V024. Дорожка: `adapter:z-ai`.
Результат: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
Область: `crates/herder/src/adapters/z_ai/deliver.rs`.

### V093. Z.ai: transcript страницы — 30–60 мин

Вход: V092, V029, V030. Дорожка: `adapter:z-ai`.
Результат: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
Область: `crates/herder/src/adapters/z_ai/transcript.rs`.

### V094. Z.ai: interrupt и параметры — 30–60 мин

Вход: V093, V025, V034, V032. Дорожка: `adapter:z-ai`.
Результат: Только доказанные stop/model/permission methods; unsupported явно, не успех.
Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
Область: `crates/herder/src/adapters/z_ai/control.rs`.

### V095. Z.ai: подключить context bridge — 25–45 мин

Вход: V094, V046. Дорожка: `adapter:z-ai`.
Результат: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
Область: `crates/herder/src/adapters/z_ai/context.rs`.

### V096. Z.ai: установленная тестовая вертикаль — 30–60 мин

Вход: V095, V051, V016. Дорожка: `adapter:z-ai`.
Результат: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
Область: `acceptance/native/z-ai/`.


## Ранняя поставка

### V097. Выпустить тестовую вертикаль Codex + OpenCode — 30–60 мин

Вход: V060, V069, V003. Дорожка: `release`.
Результат: Установленный dev artifact и один основной MCP client с durable Task polling.
Приёмка: Create/deliver/context работают через реальные adapters; missing extension не скрыт.
Область: `release/dev-vertical/`.


## Сквозная приёмка

### V098. Два Codex instance на одной ноде — 30–60 мин

Вход: V060. Дорожка: `qa`.
Результат: Изолированные profiles и двунаправленная отправка/чтение.
Приёмка: В обоих профилях свои IDs/history; fixture одинакового native ID не смешивает ключи.
Область: `acceptance/multi/codex/`.

### V099. Два OpenCode instance на одной ноде — 30–60 мин

Вход: V069. Дорожка: `qa`.
Результат: Изолированные connections и проверка control/history.
Приёмка: Отправка и stop одного instance не касаются второго.
Область: `acceptance/multi/opencode/`.

### V100. Два браузерных профиля — 30–60 мин

Вход: V087. Дорожка: `qa`.
Результат: Два разрешённых тестовых profile refs и отдельные вкладки.
Приёмка: History/send не пересекают аккаунты; нет использования чужой вкладки или credentials в receipt.
Область: `acceptance/multi/browser/`.

### V101. Две ноды и remote Task readback — 30–60 мин

Вход: V097, V021. Дорожка: `qa`.
Результат: Codex→OpenCode через объявленные endpoints; exact origin refs.
Приёмка: Чтение result с удалённой ноды доступно клиенту; offline coverage partial, no local retry.
Область: `acceptance/multi/nodes/`.

### V102. Creator/sender после компакции — 30–60 мин

Вход: V097, V044, V046, V027. Дорожка: `qa`.
Результат: A создаёт B, C пишет B; очистить context и рестарт Herder; B отвечает C.
Приёмка: Native readback одного ответа C; A остался creator; доказана инъекция, не только resource read.
Область: `acceptance/context/compaction/`.

### V103. Native admission crash matrix — 30–60 мин

Вход: V097, V015. Дорожка: `qa`.
Результат: Три точки сбоя: до вызова, после admission, после completion до ответа.
Приёмка: Повтор key не создаёт input; unknown без native lookup остаётся unknown.
Область: `acceptance/native/crash/`.

### V127. Свежий пользователь: выбор инструмента и errors — 30–60 мин

Вход: V126, V106, V104. Дорожка: `qa`.
Результат: Свежий контекст без исходников: найти роли, исправить wrong mode/field и ответить отправителю.
Приёмка: Trace показывает исправление за один повтор без новых effects; UNKNOWN/forbidden не вызывают unsafe retry.
Область: `acceptance/usability/`.

### V128. Свежий агент при выключенном MCP — 30–60 мин

Вход: V125, V043, V112. Дорожка: `qa`.
Результат: Остановить только test daemon; read markers→claim→безопасный release через runner→receipt.
Приёмка: Ноль вопросов о назначении свободного owner, одна операция; повтор MCP видит тот же owner.
Область: `acceptance/recovery/offline/`.

### V141. Bounded нагрузочный сценарий — 30–60 мин

Вход: V097, V030, V018. Дорожка: `qa`.
Результат: Фиксированный corpus, concurrent read/send/index и slow subscriber; baseline metrics.
Приёмка: Нет busy loop/unbounded queue; latency/RSS и границы workload записаны, starvation не наблюдается.
Область: `acceptance/performance/`.


## Потребители

### V104. CLI обычных операций — 30–60 мин

Вход: V097, V009. Дорожка: `clients`.
Результат: Subcommands из тех же DTO/application, polling Tasks и чтение ресурсов.
Приёмка: create/deliver/read ошибки и completion показаны раздельно; old routes отсутствуют.
Область: `crates/herder/src/cli/main.rs`.

### V105. Web UI чтение и reload — 30–60 мин

Вход: V097, V017. Дорожка: `web`.
Результат: Typed client sessions/recent/transcript, partial/turn refs.
Приёмка: Обычный браузер показывает обе роли после reload и remote resource.
Область: `web/src/session.ts`.

### V106. Web UI действия и Task lifecycle — 30–60 мин

Вход: V105, V033. Дорожка: `web`.
Результат: Create/deliver/stop/settings; standard polling и cancelled/unknown rendering.
Приёмка: Повтор кнопки не даёт duplicate; unknown не предлагает повторную отправку.
Область: `web/src/control.ts`.

### V107. Hub: зафиксировать точный контракт потребителя — 20–40 мин

Вход: V097, V002, V019, V018. Дорожка: `consumer:hub`.
Результат: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route.
Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции.
Область: `integrations/consumers/hub/target.json`.

### V108. Hub: перевести один вызывающий маршрут — 30–60 мин

Вход: V107. Дорожка: `consumer:hub`.
Результат: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях.
Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены.
Область: `consumer:hub:paths-from-target.json`.

### V109. Hub: проверить реальный consumer readback — 30–60 мин

Вход: V108. Дорожка: `consumer:hub`.
Результат: Один изолированный сценарий через обычного потребителя и native result.
Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль.
Область: `acceptance/consumers/hub/`.

### V110. LHC: зафиксировать точный контракт потребителя — 20–40 мин

Вход: V097, V039, V043. Дорожка: `consumer:lhc`.
Результат: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route.
Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции.
Область: `integrations/consumers/lhc/target.json`.

### V111. LHC: перевести один вызывающий маршрут — 30–60 мин

Вход: V110. Дорожка: `consumer:lhc`.
Результат: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях.
Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены.
Область: `consumer:lhc:paths-from-target.json`.

### V112. LHC: проверить реальный consumer readback — 30–60 мин

Вход: V111. Дорожка: `consumer:lhc`.
Результат: Один изолированный сценарий через обычного потребителя и native result.
Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль.
Область: `acceptance/consumers/lhc/`.

### V113. Notice Place: зафиксировать точный контракт потребителя — 20–40 мин

Вход: V097, V035. Дорожка: `consumer:noticeplace`.
Результат: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route.
Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции.
Область: `integrations/consumers/noticeplace/target.json`.

### V114. Notice Place: перевести один вызывающий маршрут — 30–60 мин

Вход: V113. Дорожка: `consumer:noticeplace`.
Результат: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях.
Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены.
Область: `consumer:noticeplace:paths-from-target.json`.

### V115. Notice Place: проверить реальный consumer readback — 30–60 мин

Вход: V114. Дорожка: `consumer:noticeplace`.
Результат: Один изолированный сценарий через обычного потребителя и native result.
Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль.
Область: `acceptance/consumers/noticeplace/`.

### V116. UserIO: зафиксировать точный контракт потребителя — 20–40 мин

Вход: V097, V035, V017. Дорожка: `consumer:userio`.
Результат: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route.
Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции.
Область: `integrations/consumers/userio/target.json`.

### V117. UserIO: перевести один вызывающий маршрут — 30–60 мин

Вход: V116. Дорожка: `consumer:userio`.
Результат: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях.
Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены.
Область: `consumer:userio:paths-from-target.json`.

### V118. UserIO: проверить реальный consumer readback — 30–60 мин

Вход: V117. Дорожка: `consumer:userio`.
Результат: Один изолированный сценарий через обычного потребителя и native result.
Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль.
Область: `acceptance/consumers/userio/`.

### V119. ExManager Board: зафиксировать точный контракт потребителя — 20–40 мин

Вход: V097, V023, V024. Дорожка: `consumer:board`.
Результат: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route.
Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции.
Область: `integrations/consumers/board/target.json`.

### V120. ExManager Board: перевести один вызывающий маршрут — 30–60 мин

Вход: V119. Дорожка: `consumer:board`.
Результат: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях.
Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены.
Область: `consumer:board:paths-from-target.json`.

### V121. ExManager Board: проверить реальный consumer readback — 30–60 мин

Вход: V120. Дорожка: `consumer:board`.
Результат: Один изолированный сценарий через обычного потребителя и native result.
Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль.
Область: `acceptance/consumers/board/`.

### V122. Секретарь: зафиксировать точный контракт потребителя — 20–40 мин

Вход: V097, V087, V049. Дорожка: `consumer:secretary`.
Результат: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route.
Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции.
Область: `integrations/consumers/secretary/target.json`.

### V123. Секретарь: перевести один вызывающий маршрут — 30–60 мин

Вход: V122. Дорожка: `consumer:secretary`.
Результат: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях.
Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены.
Область: `consumer:secretary:paths-from-target.json`.

### V124. Секретарь: проверить реальный consumer readback — 30–60 мин

Вход: V123. Дорожка: `consumer:secretary`.
Результат: Один изолированный сценарий через обычного потребителя и native result.
Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль.
Область: `acceptance/consumers/secretary/`.

### V125. Recovery Skill и локальная инструкция — 30–45 мин

Вход: V019, V039, V045. Дорожка: `docs`.
Результат: Один исходник инструкции и manifest template; expose Skills и package local copy.
Приёмка: Отключённый MCP не мешает найти путь; команды read/claim с подставленным locator и без секретов.
Область: `skills/herder-recovery/SKILL.md`.

### V126. Короткий Skill обычной координации — 30–45 мин

Вход: V019, V102. Дорожка: `docs`.
Результат: context→messages→reply_to, roster/worktree и errors; один источник примеров.
Приёмка: Каталог/schema примеров совпадают; read skill и activation отмечены отдельно.
Область: `skills/herder/SKILL.md`.


## Миграция

### V129. Контракт одноразового импорта — 30–45 мин

Вход: V011, V022, V027, V037. Дорожка: `migration`.
Результат: Узкие схемы только сохраняемого state: holds/intents/lineage/messages/settings/ownership.
Приёмка: Unknown provenance остаётся unknown; список active writers и read-only export для этих схем назван.
Область: `migration/state-map.md`.

### V130. Импорт holds и intents — 30–60 мин

Вход: V129, V016. Дорожка: `migration`.
Результат: Offline importer сохраняет request keys, неизвестные исходы и tombstones; не исполняет ничего.
Приёмка: Fixture повторов и HumanStop после импорта остаётся тем же; input digest/counts записаны.
Область: `migration/import_effects.rs`.

### V131. Импорт lineage/settings/correspondence — 30–60 мин

Вход: V130. Дорожка: `migration`.
Результат: Explicit schema transform, sender evidence, потерянный текст помечен.
Приёмка: Creator не заменён sender; foreign refs не склеены; повтор import безопасен.
Область: `migration/import_context.rs`.

### V132. Ownership cutover без второго writer — 30–60 мин

Вход: V131, V043. Дорожка: `migration`.
Результат: Stop writers → проверка receipts → JSON owner import → старые writers остаются выключены.
Приёмка: Git/DB fallback не активируется при падении MCP; fencing assumptions заменены target runner проверками.
Область: `migration/ownership.rs`.

### V133. Репетиция migration на снимке — 30–60 мин

Вход: V132, V103. Дорожка: `migration`.
Результат: Checksums/counts, run importer дважды, restart, no-send readback.
Приёмка: Ноль native send/create; все holds/UNKNOWN сохранены; корректный отказ при corrupt input.
Область: `acceptance/migration/rehearsal/`.

### V134. Rollback после новых записей — 30–60 мин

Вход: V133. Дорожка: `migration`.
Результат: Maintenance + сохранённый ledger + предыдущий новый binary/schema compatible; старый daemon не включать без reverse proof.
Приёмка: New hold/receipt переживают откат; old writer не получает ownership; rollback отдельно от release.
Область: `release/rollback.md`.

### V135. Репетиция rollback с новым intent — 30–60 мин

Вход: V134. Дорожка: `migration`.
Результат: Изолированный candidate принимает тестовый intent, rollback читает его без replay.
Приёмка: Unknown/confirmed и HumanStop не потеряны; incompatible schema останавливает writes.
Область: `acceptance/migration/rollback/`.


## Поставка

### V136. Артефакт linux/amd64 — 25–50 мин

Вход: V104, V106, V125. Дорожка: `build:linux-amd64`.
Результат: Reproducible locked build с embedded UI/Skills, digest и platform manifest.
Приёмка: Binary запускается в целевой среде/соответствующем runner; cross-compile отдельно от native run; Node daemon не нужен.
Область: `release/build/linux-amd64/`.

### V137. Артефакт linux/arm64 — 25–50 мин

Вход: V104, V106, V125. Дорожка: `build:linux-arm64`.
Результат: Reproducible locked build с embedded UI/Skills, digest и platform manifest.
Приёмка: Binary запускается в целевой среде/соответствующем runner; cross-compile отдельно от native run; Node daemon не нужен.
Область: `release/build/linux-arm64/`.

### V138. Артефакт macos/arm64 — 25–50 мин

Вход: V104, V106, V125. Дорожка: `build:macos-arm64`.
Результат: Reproducible locked build с embedded UI/Skills, digest и platform manifest.
Приёмка: Binary запускается в целевой среде/соответствующем runner; cross-compile отдельно от native run; Node daemon не нужен.
Область: `release/build/macos-arm64/`.

### V139. Артефакт macos/amd64 — 25–50 мин

Вход: V104, V106, V125. Дорожка: `build:macos-amd64`.
Результат: Reproducible locked build с embedded UI/Skills, digest и platform manifest.
Приёмка: Binary запускается в целевой среде/соответствующем runner; cross-compile отдельно от native run; Node daemon не нужен.
Область: `release/build/macos-amd64/`.

### V140. Параметризованный installer — 30–60 мин

Вход: V136, V137, V138, V139. Дорожка: `release`.
Результат: Install artifact/config/manifest/local instruction, preserve data; explicit paths и service launcher.
Приёмка: Нестандартный root работает; offline CLI доступен без daemon; чужой service/config не меняется.
Область: `release/install/`.

### V142. Интеграционное ревью кандидата — 30–60 мин

Вход: V060, V069, V078, V087, V096, V109, V112, V115, V118, V121, V124, V102, V098, V099, V100, V101, V103, V127, V128, V141, V135, V050. Дорожка: `review`.
Результат: Один diff review по boundaries/errors/ownership/cutover; конкретный журнал дефектов.
Приёмка: Все найденные defects имеют owned fix/retest leaf до release; review не выдаёт будущий PASS.
Область: `acceptance/review/`.

### V143. Удалить legacy daemon и registrations — 30–60 мин

Вход: V142, V140. Дорожка: `release`.
Результат: Удалить заменённые TS daemon/job API/_async/aliases из source и package entrypoints.
Приёмка: Старые имена не вызываются напрямую; frontend TS сохранён как frontend; native histories не удалены.
Область: `legacy-removal:runtime paths resolved in reviewed diff`.

### V144. Удалить legacy active clients/launchers — 30–45 мин

Вход: V143. Дорожка: `release`.
Результат: Пакеты/hooks/docs consumers используют новый API; прежние fallback writers disabled.
Приёмка: Legacy references только в историческом archive; runtime graph не запускает старый daemon.
Область: `legacy-removal:active client paths from consumer targets`.

### V145. Зафиксировать immutable release candidate — 30–45 мин

Вход: V144. Дорожка: `release`.
Результат: Build exact reviewed source после удаления legacy, manifests всех платформ.
Приёмка: Каждая тестовая lane указывает один source revision/artifact family; чужой WIP не включён.
Область: `release/candidate.json`.

### V146. Candidate: контроль codex — 20–45 мин

Вход: V145, V060. Дорожка: `adapter:codex`.
Результат: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
Область: `acceptance/candidate/codex/`.

### V147. Candidate: контроль opencode — 20–45 мин

Вход: V145, V069. Дорожка: `adapter:opencode`.
Результат: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
Область: `acceptance/candidate/opencode/`.

### V148. Candidate: контроль zcode — 20–45 мин

Вход: V145, V078. Дорожка: `adapter:zcode`.
Результат: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
Область: `acceptance/candidate/zcode/`.

### V149. Candidate: контроль chatgpt — 20–45 мин

Вход: V145, V087. Дорожка: `adapter:chatgpt`.
Результат: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
Область: `acceptance/candidate/chatgpt/`.

### V150. Candidate: контроль z-ai — 20–45 мин

Вход: V145, V096. Дорожка: `adapter:z-ai`.
Результат: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
Область: `acceptance/candidate/z-ai/`.

### V151. Candidate: проверка соединённых consumers — 30–45 мин

Вход: V145, V109, V112, V115, V118, V121, V124. Дорожка: `clients`.
Результат: Сверить ранее полученные consumer proofs с API/schema digest RC; повторить затронутый основной путь.
Приёмка: Несовпадение digest требует отдельной адресной проверки; нельзя принять устаревший receipt.
Область: `acceptance/candidate/consumers/`.

### V152. Preflight cutover и резервная копия — 30–45 мин

Вход: V140, V135, V146, V147, V148, V149, V150, V151. Дорожка: `release`.
Результат: Проверить точные target/config/version/права, snapshot и maintenance window выбранного выпуска.
Приёмка: Нет неизвестных active writers/release effects; backup восстановим; fail-fast до остановки.
Область: `release/cutover/preflight.json`.

### V153. Переключить state и единственного writer — 30–60 мин

Вход: V152. Дорожка: `release`.
Результат: Остановить старый entrypoint, выполнить проверенный импорт и установить Linux target candidate.
Приёмка: Новый runtime SHA/digest/schema; один owner writer; не возобновлены UNKNOWN или HumanStop.
Область: `release/cutover/linux/`.

### V154. Linux: обычный потребитель после установки — 30–60 мин

Вход: V153. Дорожка: `qa`.
Результат: Primary MCP consumer create/deliver/recent/export/context на тестовых сессиях, reload.
Приёмка: Runtime→receipt→native readback доказаны; приложение работает после штатного restart.
Область: `acceptance/installed/linux/`.

### V155. macOS: установка точного артефакта — 30–60 мин

Вход: V154, V140. Дорожка: `release`.
Результат: Target preflight, config/manifest, штатный launcher; без чужих profiles.
Приёмка: Artifact digest и version совпали, offline path установлен; rollback доступен.
Область: `release/cutover/macos/`.

### V156. macOS: обычный потребитель после установки — 30–60 мин

Вход: V155. Дорожка: `qa`.
Результат: Create/read/deliver/stop и restart конкретного native instance.
Приёмка: Installed consumer readback, permissions и native filesystem semantics доказаны.
Область: `acceptance/installed/macos/`.


## Передача

### V157. Независимая приёмка общения — 30–60 мин

Вход: V154, V156, V102. Дорожка: `qa`.
Результат: Свежий tester без кода/авторского отчёта: discover→create→deliver→read→stop и compaction reply.
Приёмка: Правильный sender/creator и отсутствие duplicate; тестовый circuit, никаких звонков людям.
Область: `acceptance/independent/communication/`.

### V158. Независимая приёмка recovery — 30–60 мин

Вход: V157, V128. Дорожка: `qa`.
Результат: Свежий tester по локальному Skill при выключенном test MCP; checkout conflict и release receipt.
Приёмка: Успешный claim без назначения человеком; UNKNOWN не повторён; wrong root не свободен.
Область: `acceptance/independent/recovery/`.

### V159. Main, runbook и передача результата — 30–45 мин

Вход: V158. Дорожка: `release`.
Результат: Только owned commits; опубликованный main, artifacts и acceptance manifest; чистка только своих принятых временных сред.
Приёмка: Remote main включает результат; zero unresolved mandatory defects; scope exclusions названы и явно приняты, не молча вычеркнуты.
Область: `release/handoff/`.
