Граф задач: Agent Herder v1 — нулевая ревизия: Codex, OpenCode, ZCode, ChatGPT, Z.ai
Ревизия плана: 5970bb1496b3
Это снимок плана, а не панель управления: фактическое состояние работы приходит из API владельцев, а не из пересказа агента в графе.
Цель: Поставить breaking Agent Herder v1 для пяти сред: Codex, OpenCode, ZCode, ChatGPT, Z.ai; durable MCP, coordination и offline ownership. Остальные адаптеры — следующее обновление.
Бизнес-результат: 14 общих инструментов, 5 прямых adapters, восстановление creator/sender и свободного владельца без MCP; installed consumer proof и удаление legacy.
Как проверим: Один immutable v1 candidate: Codex/OpenCode/ZCode/ChatGPT/Z.ai native lanes; реальные consumers; два Codex/OpenCode/browser profiles и две ноды; creator/sender после compaction; UNKNOWN no replay и HumanStop; offline claim/release receipt при выключенном MCP; migration/legacy removal; Linux/macOS installed acceptance. Остальные adapters не входят в v1.
Декомпозиция: 159 листьев · 4 параллельно · 12 волн · слотов: 4
Прогресс (по листьям графа): 0/159 готово (0.0%) · в работе 0 · заблокировано 0 · ждёт листа 158 · ждёт исполнителя 0 · осталось 159
Смета плана: нет посчитанных денег — 159 листьев без цены
доля frontier не вычисляется: нет посчитанных денег
остатку к запуску: нет посчитанных денег
бюджет не задан
без цены 159: V001, V002, V004, V003, V005, V006, V008, V007, V011, V036, V009, V012, V037, V010, V022, V038, V013, V020, V039, V014, V017, V041, V015, V018, V019, V021, V028, V042, V016, V023, V029, V024, V030, V025, V027, V031, V026, V032, V040, V051, V129, V033, V043, V044, V052, V061, V070, V079, V088, V130, V034, V045, V046, V047, V053, V062, V071, V080, V089, V131, V035, V048, V054, V063, V072, V081, V090, V125, V132, V049, V050, V055, V064, V073, V082, V091, V056, V065, V074, V083, V092, V057, V066, V075, V084, V093, V058, V067, V076, V085, V094, V059, V068, V077, V086, V095, V060, V069, V078, V087, V096, V097, V098, V099, V100, V101, V102, V103, V104, V105, V107, V110, V113, V116, V119, V122, V141, V106, V108, V111, V114, V117, V120, V123, V126, V133, V109, V112, V115, V118, V121, V124, V127, V134, V136, V137, V138, V139, V128, V135, V140, V142, V143, V144, V145, V146, V147, V148, V149, V150, V151, V152, V153, V154, V155, V156, V157, V158, V159
Листьев в графе: 159 · слотов: 4 · волн: 12
Параллельность: сейчас 0 из 4 слотов, пик по плану 4
Исполнители: занято 0 из 4 слотов · ждёт листа: 158 (V002, V004, V003, V005, …) · ждёт исполнителя: 0 · готово к запуску: 1 (V001)
Прогноз: осталось 48 ч 35 мин (от 26 ч), финиш 2026-11-08T03:59:46+03:00–2026-11-09T02:34:46+03:00. отсчёт от последнего события 2026-11-07T01:59+03:00 · простой 1 мин
Критический путь: Закрепить SDK и собрать минимальный wire probe → Конфигурация Node и HarnessInstance → Типы адресов и capabilities → Контракт pure core и native port → Одна диагностическая схема ошибок → Реестр 14 инструментов и typed variants → HTTP и stdio без legacy negotiation → Durable стандартные Tasks get/create → Ресурсы с ACL и приватным cache → Удалённые Tasks и resources без второго lifecycle → Общий create с точным instance → Общий deliver с явным режимом → HumanStop на admission boundary → Нативный тестовый контур и endpoint → Codex: подтвердить точный native контракт → Codex: соединение одного instance → Codex: session list и recent → Codex: создать и сверить session ID → Codex: доставить и сверить input → Codex: transcript страницы → Codex: interrupt и параметры → Codex: подключить context bridge → Codex: установленная тестовая вертикаль → Выпустить тестовую вертикаль Codex + OpenCode → Native admission crash matrix → Репетиция migration на снимке → Rollback после новых записей → Репетиция rollback с новым intent → Интеграционное ревью кандидата → Удалить legacy daemon и registrations → Удалить legacy active clients/launchers → Зафиксировать immutable release candidate → Candidate: контроль codex → Preflight cutover и резервная копия → Переключить state и единственного writer → Linux: обычный потребитель после установки → macOS: установка точного артефакта → macOS: обычный потребитель после установки → Независимая приёмка общения → Независимая приёмка recovery → Main, runbook и передача результата
Листья плана (159):
  - V001 · ⋯ В очереди · (Закрепить SDK и собрать минимальный wire probe) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Cargo.lock/toolchain и probe server/discover → tools/call на rmcp 3.9.0.
      Приёмка: Записаны версии/feature flags; процесс запускается и отдаёт обязательный resultType. Если compile не проходит, точный минимальный failure и пересмотр до адаптеров.
      Затрагиваемые файлы: `crates/herder/Cargo.toml`
  - V002 · ⋯ В очереди · (Проверить Tasks/Skills/subscriptions выбранного SDK) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V001 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Wire transcript get/update/cancel, skills/list/get/read и listen; без native эффектов.
      Приёмка: Capabilities проверяются до возврата Task; отсутствуют tasks/list/result; найденные SDK пробелы названы.
      Затрагиваемые файлы: `tests/protocol/sdk_probe.rs`
  - V004 · ⋯ В очереди · (Конфигурация Node и HarnessInstance) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V001 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Typed config nodes/instances/profiles/authority/secret refs; duplicate ID validation.
      Приёмка: Два профиля одного типа независимы; hostname/root не зашиты; диагностика неверного поля.
      Затрагиваемые файлы: `crates/herder/src/config.rs`
  - V003 · ⋯ В очереди · (Проверить конкретный основной MCP-клиент) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V002 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один объявленный потребитель подключается к probe; revision/extensions/identity matrix.
      Приёмка: Есть прямой trace реального клиента, не SDK talking to itself; unsupported блокирует gate и зависимую реализацию.
      Затрагиваемые файлы: `acceptance/contracts/primary-client.json`
  - V005 · ⋯ В очереди · (Типы адресов и capabilities) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V004 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Node/instance/session refs, supported/available/authorized отдельно; версии capability.
      Приёмка: Одинаковые native IDs в разных instance не равны; offline не unsupported.
      Затрагиваемые файлы: `crates/herder/src/domain/address.rs`
  - V006 · ⋯ В очереди · (Контракт pure core и native port) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V005 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: DTO Admission/Unknown/Receipt и маленькие reader/control ports; enum registry.
      Приёмка: Табличный pure decision test без I/O; fake submit различает never sent и unknown.
      Затрагиваемые файлы: `crates/herder/src/domain/adapter.rs`
  - V008 · ⋯ В очереди · (Привязать caller и области доступа) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V005 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Verified principal/self binding; deny-by-default для private session и ресурсов.
      Приёмка: Подмена sender/session_ref и общий node token не дают self; auth не следует из parent.
      Затрагиваемые файлы: `crates/herder/src/auth/identity.rs`
  - V007 · ⋯ В очереди · (Одна диагностическая схема ошибок) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V006 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: field/received/expected/fix/effect/retry/receipt; redaction секретов.
      Приёмка: Wrong mode и conflict reply_to дают однозначный исправляемый вызов без mutation.
      Затрагиваемые файлы: `crates/herder/src/error.rs`
  - V011 · ⋯ В очереди · (SQLite схема и транзакционные границы) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V006 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Таблицы tasks/intents/messages/holds/lineage/settings; migration version.
      Приёмка: Rollback transaction не оставляет half intent; новый schema version запрещает запись старому binary.
      Затрагиваемые файлы: `crates/herder/src/store/schema.sql`
  - V036 · ⋯ В очереди · (Manifest канонического storage) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 2 · зависит: V004, V008 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Storage/project/resource markers, точный offline locator и ACL policy.
      Приёмка: Wrong root/storage/mount loss отличаются от owner ENOENT; секретов нет.
      Затрагиваемые файлы: `crates/herder/src/ownership/manifest.rs`
  - V009 · ⋯ В очереди · (Реестр 14 инструментов и typed variants) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V007, V002 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Единая декларация discovery/dispatch с oneOf schemas; actions read/mutate разделены.
      Приёмка: tools/list совпадает с dispatch; дополнительные поля/legacy names отвергаются.
      Затрагиваемые файлы: `crates/herder/src/mcp/catalog.rs`
  - V012 · ⋯ В очереди · (Атомарное принятие идемпотентного intent) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V011, V008, V007 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Unique principal/target/request_key + payload hash и CAS prepared→dispatching.
      Приёмка: Два одновременных обработчика вызывают fake submit один раз; conflict payload отклоняется.
      Затрагиваемые файлы: `crates/herder/src/store/intents.rs`
  - V037 · ⋯ В очереди · (Одна owner запись и OS lock) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 2 · зависит: V036 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Claim/renew/release с UUID epoch, atomic rename/unlink+fsync, CAS claim ID.
      Приёмка: Concurrent claims имеют одного победителя; release чужого ID denied; нет state.json transaction.
      Затрагиваемые файлы: `crates/herder/src/ownership/claim.rs`
  - V010 · ⋯ В очереди · (HTTP и stdio без legacy negotiation) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V009, V003, V008 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Транспорт SDK, обязательная request metadata, shutdown; application entrypoint.
      Приёмка: Основной клиент читает catalog обоими поддерживаемыми транспортами; wrong revision до эффекта.
      Затрагиваемые файлы: `crates/herder/src/mcp/transport.rs`
  - V022 · ⋯ В очереди · (Долговечный creator и native parent) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V012 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Создатель в create intent, native parent и происхождение отдельно.
      Приёмка: Restart между intent и native receipt не меняет creator; неизвестное происхождение не угадано.
      Затрагиваемые файлы: `crates/herder/src/store/lineage.rs`
  - V038 · ⋯ В очереди · (Crash proof файловых переходов) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 2 · зависит: V037 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Fault injection до/после rename/unlink/fsync; leftover temp cleanup под lock.
      Приёмка: Полный old/new owner или отсутствие; fsync failure unknown; guard inode не заменён.
      Затрагиваемые файлы: `tests/ownership/crash.rs`
  - V013 · ⋯ В очереди · (Durable стандартные Tasks get/create) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V012, V010 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: SDK wire types и SQLite backend без in-memory authority.
      Приёмка: Task сохранён до ответа, polling после рестарта читает тот же ID/result.
      Затрагиваемые файлы: `crates/herder/src/mcp/tasks.rs`
  - V020 · ⋯ В очереди · (Маршрутизация к owner Node) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V010, V005 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Peer auth, точный instance, deadline и сохранение errors; без local fallback.
      Приёмка: Две конфигурируемые ноды; чужой scope denied, недоступный origin остаётся unavailable.
      Затрагиваемые файлы: `crates/herder/src/peer/route.rs`
  - V039 · ⋯ В очереди · (Offline CLI поверх той же библиотеки) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 2 · зависит: V038 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: herder ownership без запуска daemon/SQLite/MCP; JSON и русские ошибки.
      Приёмка: Потерянный claim response читается по nonce без automatic reclaim после release.
      Затрагиваемые файлы: `crates/herder/src/cli/ownership.rs`
  - V014 · ⋯ В очереди · (Tasks update и cooperative cancel) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V013 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Persist pending inputs и ответы по ключам; cancel intent отдельно от effect outcome.
      Приёмка: Повтор input не продолжает дважды; cancel после admission не выдаёт отмену эффекта.
      Затрагиваемые файлы: `crates/herder/src/store/task_inputs.rs`
  - V017 · ⋯ В очереди · (Ресурсы с ACL и приватным cache) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V010, V013, V008 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Session/task/transcript resources с remote-readable refs и pagination.
      Приёмка: Другой principal не читает result/Task; cacheScope private и ttlMs корректны.
      Затрагиваемые файлы: `crates/herder/src/mcp/resources.rs`
  - V041 · ⋯ В очереди · (Единственная точка release admission) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 2 · зависит: V039 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Target-local lock, live claim check после lock, expected deployed revision.
      Приёмка: Задержавшийся старый claim отвергнут; второй runner path запрещён конфигурацией.
      Затрагиваемые файлы: `crates/herder/src/ownership/release_runner.rs`
  - V015 · ⋯ В очереди · (Reconcile неопределённой native отправки) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V014 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Restart dispatcher читает native receipt по стабильной корреляции, без send.
      Приёмка: Kill после dispatching/admission даёт confirmed или unknown; unknown не получает safe retry.
      Затрагиваемые файлы: `crates/herder/src/application/reconcile.rs`
  - V018 · ⋯ В очереди · (Подписки с bounded очередью и resync) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V017 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: subscriptions/listen filters; drop→snapshot, без SSE replay.
      Приёмка: Медленный клиент не блокирует ноду; reconnect видит current revision без дублирования эффектов.
      Затрагиваемые файлы: `crates/herder/src/mcp/subscriptions.rs`
  - V019 · ⋯ В очереди · (Статический Skills manifest) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V017 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: skills/list/get и resources/read с digest; directoryRead не объявлен.
      Приёмка: Проверены manifest boundary, приватность и content hash; read не объявляет activation.
      Затрагиваемые файлы: `crates/herder/src/mcp/skills.rs`
  - V021 · ⋯ В очереди · (Удалённые Tasks и resources без второго lifecycle) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V020, V013, V017 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Origin Task ref и маршрутизация standard polling/cancel/read по ACL.
      Приёмка: Proxy restart не дублирует native intent; origin task/result остаются теми же.
      Затрагиваемые файлы: `crates/herder/src/peer/tasks.rs`
  - V028 · ⋯ В очереди · (Recent обеих ролей) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V006, V017 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Общий projection user+assistant с turn/time/partial; read-only session.
      Приёмка: Старый assistant не назван ответом на новый input; отсутствующий источник не пустая история.
      Затрагиваемые файлы: `crates/herder/src/application/recent.rs`
  - V042 · ⋯ В очереди · (Durable release receipt до spawn) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 2 · зависит: V041 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Request key/hash, admitted/confirmed/unknown; child удерживает execution lock.
      Приёмка: Crash родителя не отпускает live child; unknown external effect блокирует новый конфликтующий effect.
      Затрагиваемые файлы: `crates/herder/src/ownership/release_receipt.rs`
  - V016 · ⋯ В очереди · (Разделить Task TTL и receipt retention) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V015 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Tombstone дедупликации/удалённого текста, правила expiry.
      Приёмка: Истёкший Task и удалённый transcript не позволяют повтор request_key выполнить эффект.
      Затрагиваемые файлы: `crates/herder/src/store/retention.rs`
  - V023 · ⋯ В очереди · (Общий create с точным instance) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V022, V006, V021 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Application create проверяет capability/auth и связывает intent с native ID.
      Приёмка: Fake native create вызывается один раз; completion только после session readback.
      Затрагиваемые файлы: `crates/herder/src/application/create.rs`
  - V029 · ⋯ В очереди · (Transcript snapshot и cursor) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V028 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Нормализованные blocks, raw ref и подписанный/привязанный snapshot cursor.
      Приёмка: Чужой cursor отвергнут; последняя страница, truncation и snapshot boundary проверены.
      Затрагиваемые файлы: `crates/herder/src/domain/transcript.rs`
  - V024 · ⋯ В очереди · (Общий deliver с явным режимом) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V023, V015 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: current/queue/start, expected turn; implicit create и delayed send отсутствуют.
      Приёмка: Busy/unsupported не подменяют режим; persisted intent предшествует submit.
      Затрагиваемые файлы: `crates/herder/src/application/deliver.rs`
  - V030 · ⋯ В очереди · (Инкрементальный поиск) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V029, V011 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: SQLite FTS и source cursors; обновление только изменённой сессии.
      Приёмка: Одна новая запись не сканирует весь corpus; ACL и coverage сохраняются.
      Затрагиваемые файлы: `crates/herder/src/search/index.rs`
  - V025 · ⋯ В очереди · (HumanStop на admission boundary) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V024 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Durable hold перед interrupt; dispatch/stop сериализуют admission.
      Приёмка: Race stop/deliver: post-hold send не стартует; уже принятое действие отражено честно.
      Затрагиваемые файлы: `crates/herder/src/application/stop.rs`
  - V027 · ⋯ В очереди · (Журнал и reply_to) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V024, V022, V008 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Transaction связывает sender/recipient/message_ref с intent; reply target берётся сервером.
      Приёмка: C→B и ответ B адресованы C; A creator не подменяется; чужой reply_to denied.
      Затрагиваемые файлы: `crates/herder/src/store/correspondence.rs`
  - V031 · ⋯ В очереди · (Sessions/discover и coverage) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V030, V020 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Постраничный список по project/instance; native availability отдельно от cached records.
      Приёмка: Offline peer явно отмечен, одинаковые basename не склеены.
      Затрагиваемые файлы: `crates/herder/src/application/list.rs`
  - V026 · ⋯ В очереди · (Одноразовое resume) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V025 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один request_key → один native turn; HumanStop требует отдельного человеческого права на снятие.
      Приёмка: Дубликат resume не создаёт ход; флаг humanRequested от модели не снимает hold.
      Затрагиваемые файлы: `crates/herder/src/application/resume.rs`
  - V032 · ⋯ В очереди · (Модели и квоты профиля) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V031 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: discover(kind=models) отдаёт verified catalog и unknown значения.
      Приёмка: Два профиля не разделяют auth/quota cache, unknown не zero/unlimited.
      Затрагиваемые файлы: `crates/herder/src/application/models.rs`
  - V040 · ⋯ В очереди · (Workspace declarations и общий claim route) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 2 · зависит: V037, V031 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Project/worktree identity/scopes/notes; MCP ownership вызывает ту же библиотеку.
      Приёмка: Декларация не lease; две ноды одного shared workspace используют один resource.
      Затрагиваемые файлы: `crates/herder/src/application/workspace.rs`
  - V051 · ⋯ В очереди · (Нативный тестовый контур и endpoint) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V010, V023, V025 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Изолированные profiles, deterministic model endpoint для поддерживающих клиентов, receipt schema.
      Приёмка: Native процесс отличим от fake adapter; никакого личного аккаунта/звонка; отдельные browser test identities.
      Затрагиваемые файлы: `tests/native/harness_runner.rs`
  - V129 · ⋯ В очереди · (Контракт одноразового импорта) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 9 · зависит: V011, V022, V027, V037 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Узкие схемы только сохраняемого state: holds/intents/lineage/messages/settings/ownership.
      Приёмка: Unknown provenance остаётся unknown; список active writers и read-only export для этих схем назван.
      Затрагиваемые файлы: `migration/state-map.md`
  - V033 · ⋯ В очереди · (Configure desired/applied CAS) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V032, V008 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Node/instance/session settings поддерживаются только при capability, typed patches.
      Приёмка: Stale revision отвергнут; remote unavailable не applied; scope проверяется.
      Затрагиваемые файлы: `crates/herder/src/application/settings.rs`
  - V043 · ⋯ В очереди · (Гонка release и смена owner) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 2 · зависит: V042, V040 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Test runner делает безопасный локальный file revision effect; delay/crash/partition.
      Приёмка: Максимум один эффект; повтор key только readback; lost authority запрещает новый admission.
      Затрагиваемые файлы: `tests/ownership/release_races.rs`
  - V044 · ⋯ В очереди · (Context self/creator/senders/peers) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 3 · зависит: V027, V040, V028 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один bounded snapshot с адресами, scopes, coverage и курсорами.
      Приёмка: A creator и C sender восстанавливаются без transcript memory; чужие closed sessions скрыты.
      Затрагиваемые файлы: `crates/herder/src/application/context.rs`
  - V052 · ⋯ В очереди · (Codex: подтвердить точный native контракт) · оценка 25 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V006, V051 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один versioned app-server JSON-RPC: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
      Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
      Затрагиваемые файлы: `acceptance/contracts/codex.md`
  - V061 · ⋯ В очереди · (OpenCode: подтвердить точный native контракт) · оценка 25 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V006, V051 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один versioned HTTP/events: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
      Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
      Затрагиваемые файлы: `acceptance/contracts/opencode.md`
  - V070 · ⋯ В очереди · (ZCode: подтвердить точный native контракт) · оценка 25 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V006, V051 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один versioned подтверждаемый native session transport: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
      Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
      Затрагиваемые файлы: `acceptance/contracts/zcode.md`
  - V079 · ⋯ В очереди · (ChatGPT: подтвердить точный native контракт) · оценка 25 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V006, V051 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один versioned авторизованный browser profile через разрешённый маршрут: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
      Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
      Затрагиваемые файлы: `acceptance/contracts/chatgpt.md`
  - V088 · ⋯ В очереди · (Z.ai: подтвердить точный native контракт) · оценка 25 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V006, V051 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один versioned авторизованный browser profile через разрешённый маршрут: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции.
      Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success.
      Затрагиваемые файлы: `acceptance/contracts/z-ai.md`
  - V130 · ⋯ В очереди · (Импорт holds и intents) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 9 · зависит: V129, V016 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Offline importer сохраняет request keys, неизвестные исходы и tombstones; не исполняет ничего.
      Приёмка: Fixture повторов и HumanStop после импорта остаётся тем же; input digest/counts записаны.
      Затрагиваемые файлы: `migration/import_effects.rs`
  - V034 · ⋯ В очереди · (Точный native permission request) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V033, V014 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Pending request identity и authorized answer, без wildcard approvals.
      Приёмка: Expired ID не отвечает другому request; duplicate answer идемпотентен.
      Затрагиваемые файлы: `crates/herder/src/application/permission.rs`
  - V045 · ⋯ В очереди · (Offline context snapshot) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 3 · зависит: V044, V039 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Atomic JSON projection c generated_at, coverage и безопасными routes.
      Приёмка: Без daemon читается stale snapshot; это не owner или delivery receipt.
      Затрагиваемые файлы: `crates/herder/src/ownership/context_snapshot.rs`
  - V046 · ⋯ В очереди · (Контекстные generation и native hook client) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 3 · зависит: V044, V018, V025 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Projector snapshot/delta, новый context generation не подавляется fingerprint.
      Приёмка: Fake compact event вызывает snapshot без нового model turn и без снятия STOP.
      Затрагиваемые файлы: `integrations/hooks/context_client.rs`
  - V047 · ⋯ В очереди · (Typed automation rules) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 4 · зависит: V033, V026 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Schedule/one-shot и autopilot в одном CRUD; timezone, missed/overlap, CAS.
      Приёмка: Неверный cron объясняется; настройка не создаёт parallel job API.
      Затрагиваемые файлы: `crates/herder/src/automation/rules.rs`
  - V053 · ⋯ В очереди · (Codex: соединение одного instance) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V052 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
      Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/connection.rs`
  - V062 · ⋯ В очереди · (OpenCode: соединение одного instance) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V061 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
      Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/connection.rs`
  - V071 · ⋯ В очереди · (ZCode: соединение одного instance) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V070 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
      Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/connection.rs`
  - V080 · ⋯ В очереди · (ChatGPT: соединение одного instance) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V079 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
      Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/connection.rs`
  - V089 · ⋯ В очереди · (Z.ai: соединение одного instance) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V088 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте.
      Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/connection.rs`
  - V131 · ⋯ В очереди · (Импорт lineage/settings/correspondence) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 9 · зависит: V130 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Explicit schema transform, sender evidence, потерянный текст помечен.
      Приёмка: Creator не заменён sender; foreign refs не склеены; повтор import безопасен.
      Затрагиваемые файлы: `migration/import_context.rs`
  - V035 · ⋯ В очереди · (Внешний вопрос и MCP input раздельно) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V034, V026 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: MRTR/Task input и external correlation используют одну delivery boundary.
      Приёмка: Ответ относится одной сессии, повтор callback не даёт два resume; внешняя отправка только в test route.
      Затрагиваемые файлы: `crates/herder/src/application/human.rs`
  - V048 · ⋯ В очереди · (Один admission executor триггеров) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 4 · зависит: V047 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Trigger ID + правило + native turn → постоянный delivery request_key.
      Приёмка: Hook/observer/end-turn повтор не создаёт второй continuation; hold всегда проверен.
      Затрагиваемые файлы: `crates/herder/src/automation/executor.rs`
  - V054 · ⋯ В очереди · (Codex: session list и recent) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V053, V028 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Одна подтверждённая native read route → адреса/status/последние user+assistant.
      Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/read.rs`
  - V063 · ⋯ В очереди · (OpenCode: session list и recent) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V062, V028 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Одна подтверждённая native read route → адреса/status/последние user+assistant.
      Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/read.rs`
  - V072 · ⋯ В очереди · (ZCode: session list и recent) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V071, V028 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Одна подтверждённая native read route → адреса/status/последние user+assistant.
      Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/read.rs`
  - V081 · ⋯ В очереди · (ChatGPT: session list и recent) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V080, V028 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Одна подтверждённая native read route → адреса/status/последние user+assistant.
      Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/read.rs`
  - V090 · ⋯ В очереди · (Z.ai: session list и recent) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V089, V028 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Одна подтверждённая native read route → адреса/status/последние user+assistant.
      Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/read.rs`
  - V125 · ⋯ В очереди · (Recovery Skill и локальная инструкция) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V019, V039, V045 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один исходник инструкции и manifest template; expose Skills и package local copy.
      Приёмка: Отключённый MCP не мешает найти путь; команды read/claim с подставленным locator и без секретов.
      Затрагиваемые файлы: `skills/herder-recovery/SKILL.md`
  - V132 · ⋯ В очереди · (Ownership cutover без второго writer) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 9 · зависит: V131, V043 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Stop writers → проверка receipts → JSON owner import → старые writers остаются выключены.
      Приёмка: Git/DB fallback не активируется при падении MCP; fencing assumptions заменены target runner проверками.
      Затрагиваемые файлы: `migration/ownership.rs`
  - V049 · ⋯ В очереди · (DST/restart/pause расписания) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 4 · зависит: V048 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Clock как вход pure reducer; bounded catch-up и no overlap.
      Приёмка: DST fold/gap, restart после admission и pause не дают дубля.
      Затрагиваемые файлы: `tests/automation/schedule.rs`
  - V050 · ⋯ В очереди · (Остановка автопилота по цели/бюджету) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 4 · зависит: V048 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Existing goal judge contract как input; bounded continuation, явный failure.
      Приёмка: Goal done, quota unknown/denied и HumanStop не вызывают retry-loop; одна continuation на turn.
      Затрагиваемые файлы: `crates/herder/src/automation/autopilot.rs`
  - V055 · ⋯ В очереди · (Codex: создать и сверить session ID) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V054, V023 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Одна native create route; request correlation и readback.
      Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/create.rs`
  - V064 · ⋯ В очереди · (OpenCode: создать и сверить session ID) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V063, V023 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Одна native create route; request correlation и readback.
      Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/create.rs`
  - V073 · ⋯ В очереди · (ZCode: создать и сверить session ID) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V072, V023 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Одна native create route; request correlation и readback.
      Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/create.rs`
  - V082 · ⋯ В очереди · (ChatGPT: создать и сверить session ID) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V081, V023 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Одна native create route; request correlation и readback.
      Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/create.rs`
  - V091 · ⋯ В очереди · (Z.ai: создать и сверить session ID) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V090, V023 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Одна native create route; request correlation и readback.
      Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/create.rs`
  - V056 · ⋯ В очереди · (Codex: доставить и сверить input) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V055, V024 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
      Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/deliver.rs`
  - V065 · ⋯ В очереди · (OpenCode: доставить и сверить input) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V064, V024 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
      Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/deliver.rs`
  - V074 · ⋯ В очереди · (ZCode: доставить и сверить input) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V073, V024 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
      Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/deliver.rs`
  - V083 · ⋯ В очереди · (ChatGPT: доставить и сверить input) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V082, V024 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
      Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/deliver.rs`
  - V092 · ⋯ В очереди · (Z.ai: доставить и сверить input) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V091, V024 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Одна native send route; поддерживаемые modes кодируются явно; native receipt.
      Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/deliver.rs`
  - V057 · ⋯ В очереди · (Codex: transcript страницы) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V056, V029, V030 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
      Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/transcript.rs`
  - V066 · ⋯ В очереди · (OpenCode: transcript страницы) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V065, V029, V030 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
      Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/transcript.rs`
  - V075 · ⋯ В очереди · (ZCode: transcript страницы) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V074, V029, V030 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
      Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/transcript.rs`
  - V084 · ⋯ В очереди · (ChatGPT: transcript страницы) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V083, V029, V030 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
      Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/transcript.rs`
  - V093 · ⋯ В очереди · (Z.ai: transcript страницы) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V092, V029, V030 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса.
      Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/transcript.rs`
  - V058 · ⋯ В очереди · (Codex: interrupt и параметры) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V057, V025, V034, V032 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Только доказанные stop/model/permission methods; unsupported явно, не успех.
      Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/control.rs`
  - V067 · ⋯ В очереди · (OpenCode: interrupt и параметры) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V066, V025, V034, V032 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Только доказанные stop/model/permission methods; unsupported явно, не успех.
      Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/control.rs`
  - V076 · ⋯ В очереди · (ZCode: interrupt и параметры) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V075, V025, V034, V032 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Только доказанные stop/model/permission methods; unsupported явно, не успех.
      Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/control.rs`
  - V085 · ⋯ В очереди · (ChatGPT: interrupt и параметры) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V084, V025, V034, V032 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Только доказанные stop/model/permission methods; unsupported явно, не успех.
      Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/control.rs`
  - V094 · ⋯ В очереди · (Z.ai: interrupt и параметры) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V093, V025, V034, V032 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Только доказанные stop/model/permission methods; unsupported явно, не успех.
      Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/control.rs`
  - V059 · ⋯ В очереди · (Codex: подключить context bridge) · оценка 25 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V058, V046 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
      Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/context.rs`
  - V068 · ⋯ В очереди · (OpenCode: подключить context bridge) · оценка 25 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V067, V046 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
      Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/context.rs`
  - V077 · ⋯ В очереди · (ZCode: подключить context bridge) · оценка 25 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V076, V046 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
      Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/context.rs`
  - V086 · ⋯ В очереди · (ChatGPT: подключить context bridge) · оценка 25 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V085, V046 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
      Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/context.rs`
  - V095 · ⋯ В очереди · (Z.ai: подключить context bridge) · оценка 25 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V094, V046 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Привязка self и один подтверждённый startup/resume/compact hook; absence явная.
      Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/context.rs`
  - V060 · ⋯ В очереди · (Codex: установленная тестовая вертикаль) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V059, V051, V016 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
      Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
      Затрагиваемые файлы: `acceptance/native/codex/`
  - V069 · ⋯ В очереди · (OpenCode: установленная тестовая вертикаль) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V068, V051, V016 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
      Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
      Затрагиваемые файлы: `acceptance/native/opencode/`
  - V078 · ⋯ В очереди · (ZCode: установленная тестовая вертикаль) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V077, V051, V016 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
      Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
      Затрагиваемые файлы: `acceptance/native/zcode/`
  - V087 · ⋯ В очереди · (ChatGPT: установленная тестовая вертикаль) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V086, V051, V016 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
      Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
      Затрагиваемые файлы: `acceptance/native/chatgpt/`
  - V096 · ⋯ В очереди · (Z.ai: установленная тестовая вертикаль) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: V095, V051, V016 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop.
      Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane.
      Затрагиваемые файлы: `acceptance/native/z-ai/`
  - V097 · ⋯ В очереди · (Выпустить тестовую вертикаль Codex + OpenCode) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 6 · зависит: V060, V069, V003 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Установленный dev artifact и один основной MCP client с durable Task polling.
      Приёмка: Create/deliver/context работают через реальные adapters; missing extension не скрыт.
      Затрагиваемые файлы: `release/dev-vertical/`
  - V098 · ⋯ В очереди · (Два Codex instance на одной ноде) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 7 · зависит: V060 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Изолированные profiles и двунаправленная отправка/чтение.
      Приёмка: В обоих профилях свои IDs/history; fixture одинакового native ID не смешивает ключи.
      Затрагиваемые файлы: `acceptance/multi/codex/`
  - V099 · ⋯ В очереди · (Два OpenCode instance на одной ноде) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 7 · зависит: V069 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Изолированные connections и проверка control/history.
      Приёмка: Отправка и stop одного instance не касаются второго.
      Затрагиваемые файлы: `acceptance/multi/opencode/`
  - V100 · ⋯ В очереди · (Два браузерных профиля) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 7 · зависит: V087 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Два разрешённых тестовых profile refs и отдельные вкладки.
      Приёмка: History/send не пересекают аккаунты; нет использования чужой вкладки или credentials в receipt.
      Затрагиваемые файлы: `acceptance/multi/browser/`
  - V101 · ⋯ В очереди · (Две ноды и remote Task readback) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 7 · зависит: V097, V021 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Codex→OpenCode через объявленные endpoints; exact origin refs.
      Приёмка: Чтение result с удалённой ноды доступно клиенту; offline coverage partial, no local retry.
      Затрагиваемые файлы: `acceptance/multi/nodes/`
  - V102 · ⋯ В очереди · (Creator/sender после компакции) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 7 · зависит: V097, V044, V046, V027 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: A создаёт B, C пишет B; очистить context и рестарт Herder; B отвечает C.
      Приёмка: Native readback одного ответа C; A остался creator; доказана инъекция, не только resource read.
      Затрагиваемые файлы: `acceptance/context/compaction/`
  - V103 · ⋯ В очереди · (Native admission crash matrix) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 7 · зависит: V097, V015 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Три точки сбоя: до вызова, после admission, после completion до ответа.
      Приёмка: Повтор key не создаёт input; unknown без native lookup остаётся unknown.
      Затрагиваемые файлы: `acceptance/native/crash/`
  - V104 · ⋯ В очереди · (CLI обычных операций) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V097, V009 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Subcommands из тех же DTO/application, polling Tasks и чтение ресурсов.
      Приёмка: create/deliver/read ошибки и completion показаны раздельно; old routes отсутствуют.
      Затрагиваемые файлы: `crates/herder/src/cli/main.rs`
  - V105 · ⋯ В очереди · (Web UI чтение и reload) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V097, V017 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Typed client sessions/recent/transcript, partial/turn refs.
      Приёмка: Обычный браузер показывает обе роли после reload и remote resource.
      Затрагиваемые файлы: `web/src/session.ts`
  - V107 · ⋯ В очереди · (Hub: зафиксировать точный контракт потребителя) · оценка 20 мин–40 мин · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V097, V002, V019, V018 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route.
      Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции.
      Затрагиваемые файлы: `integrations/consumers/hub/target.json`
  - V110 · ⋯ В очереди · (LHC: зафиксировать точный контракт потребителя) · оценка 20 мин–40 мин · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V097, V039, V043 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route.
      Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции.
      Затрагиваемые файлы: `integrations/consumers/lhc/target.json`
  - V113 · ⋯ В очереди · (Notice Place: зафиксировать точный контракт потребителя) · оценка 20 мин–40 мин · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V097, V035 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route.
      Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции.
      Затрагиваемые файлы: `integrations/consumers/noticeplace/target.json`
  - V116 · ⋯ В очереди · (UserIO: зафиксировать точный контракт потребителя) · оценка 20 мин–40 мин · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V097, V035, V017 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route.
      Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции.
      Затрагиваемые файлы: `integrations/consumers/userio/target.json`
  - V119 · ⋯ В очереди · (ExManager Board: зафиксировать точный контракт потребителя) · оценка 20 мин–40 мин · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V097, V023, V024 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route.
      Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции.
      Затрагиваемые файлы: `integrations/consumers/board/target.json`
  - V122 · ⋯ В очереди · (Секретарь: зафиксировать точный контракт потребителя) · оценка 20 мин–40 мин · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V097, V087, V049 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route.
      Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции.
      Затрагиваемые файлы: `integrations/consumers/secretary/target.json`
  - V141 · ⋯ В очереди · (Bounded нагрузочный сценарий) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 7 · зависит: V097, V030, V018 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Фиксированный corpus, concurrent read/send/index и slow subscriber; baseline metrics.
      Приёмка: Нет busy loop/unbounded queue; latency/RSS и границы workload записаны, starvation не наблюдается.
      Затрагиваемые файлы: `acceptance/performance/`
  - V106 · ⋯ В очереди · (Web UI действия и Task lifecycle) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V105, V033 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Create/deliver/stop/settings; standard polling и cancelled/unknown rendering.
      Приёмка: Повтор кнопки не даёт duplicate; unknown не предлагает повторную отправку.
      Затрагиваемые файлы: `web/src/control.ts`
  - V108 · ⋯ В очереди · (Hub: перевести один вызывающий маршрут) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V107 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях.
      Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены.
      Затрагиваемые файлы: `consumer:hub:paths-from-target.json`
  - V111 · ⋯ В очереди · (LHC: перевести один вызывающий маршрут) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V110 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях.
      Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены.
      Затрагиваемые файлы: `consumer:lhc:paths-from-target.json`
  - V114 · ⋯ В очереди · (Notice Place: перевести один вызывающий маршрут) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V113 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях.
      Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены.
      Затрагиваемые файлы: `consumer:noticeplace:paths-from-target.json`
  - V117 · ⋯ В очереди · (UserIO: перевести один вызывающий маршрут) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V116 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях.
      Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены.
      Затрагиваемые файлы: `consumer:userio:paths-from-target.json`
  - V120 · ⋯ В очереди · (ExManager Board: перевести один вызывающий маршрут) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V119 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях.
      Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены.
      Затрагиваемые файлы: `consumer:board:paths-from-target.json`
  - V123 · ⋯ В очереди · (Секретарь: перевести один вызывающий маршрут) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V122 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях.
      Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены.
      Затрагиваемые файлы: `consumer:secretary:paths-from-target.json`
  - V126 · ⋯ В очереди · (Короткий Skill обычной координации) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V019, V102 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: context→messages→reply_to, roster/worktree и errors; один источник примеров.
      Приёмка: Каталог/schema примеров совпадают; read skill и activation отмечены отдельно.
      Затрагиваемые файлы: `skills/herder/SKILL.md`
  - V133 · ⋯ В очереди · (Репетиция migration на снимке) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 9 · зависит: V132, V103 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Checksums/counts, run importer дважды, restart, no-send readback.
      Приёмка: Ноль native send/create; все holds/UNKNOWN сохранены; корректный отказ при corrupt input.
      Затрагиваемые файлы: `acceptance/migration/rehearsal/`
  - V109 · ⋯ В очереди · (Hub: проверить реальный consumer readback) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V108 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один изолированный сценарий через обычного потребителя и native result.
      Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль.
      Затрагиваемые файлы: `acceptance/consumers/hub/`
  - V112 · ⋯ В очереди · (LHC: проверить реальный consumer readback) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V111 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один изолированный сценарий через обычного потребителя и native result.
      Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль.
      Затрагиваемые файлы: `acceptance/consumers/lhc/`
  - V115 · ⋯ В очереди · (Notice Place: проверить реальный consumer readback) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V114 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один изолированный сценарий через обычного потребителя и native result.
      Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль.
      Затрагиваемые файлы: `acceptance/consumers/noticeplace/`
  - V118 · ⋯ В очереди · (UserIO: проверить реальный consumer readback) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V117 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один изолированный сценарий через обычного потребителя и native result.
      Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль.
      Затрагиваемые файлы: `acceptance/consumers/userio/`
  - V121 · ⋯ В очереди · (ExManager Board: проверить реальный consumer readback) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V120 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один изолированный сценарий через обычного потребителя и native result.
      Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль.
      Затрагиваемые файлы: `acceptance/consumers/board/`
  - V124 · ⋯ В очереди · (Секретарь: проверить реальный consumer readback) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 8 · зависит: V123 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один изолированный сценарий через обычного потребителя и native result.
      Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль.
      Затрагиваемые файлы: `acceptance/consumers/secretary/`
  - V127 · ⋯ В очереди · (Свежий пользователь: выбор инструмента и errors) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 7 · зависит: V126, V106, V104 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Свежий контекст без исходников: найти роли, исправить wrong mode/field и ответить отправителю.
      Приёмка: Trace показывает исправление за один повтор без новых effects; UNKNOWN/forbidden не вызывают unsafe retry.
      Затрагиваемые файлы: `acceptance/usability/`
  - V134 · ⋯ В очереди · (Rollback после новых записей) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 9 · зависит: V133 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Maintenance + сохранённый ledger + предыдущий новый binary/schema compatible; старый daemon не включать без reverse proof.
      Приёмка: New hold/receipt переживают откат; old writer не получает ownership; rollback отдельно от release.
      Затрагиваемые файлы: `release/rollback.md`
  - V136 · ⋯ В очереди · (Артефакт linux/amd64) · оценка 25 мин–50 мин · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V104, V106, V125 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Reproducible locked build с embedded UI/Skills, digest и platform manifest.
      Приёмка: Binary запускается в целевой среде/соответствующем runner; cross-compile отдельно от native run; Node daemon не нужен.
      Затрагиваемые файлы: `release/build/linux-amd64/`
  - V137 · ⋯ В очереди · (Артефакт linux/arm64) · оценка 25 мин–50 мин · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V104, V106, V125 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Reproducible locked build с embedded UI/Skills, digest и platform manifest.
      Приёмка: Binary запускается в целевой среде/соответствующем runner; cross-compile отдельно от native run; Node daemon не нужен.
      Затрагиваемые файлы: `release/build/linux-arm64/`
  - V138 · ⋯ В очереди · (Артефакт macos/arm64) · оценка 25 мин–50 мин · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V104, V106, V125 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Reproducible locked build с embedded UI/Skills, digest и platform manifest.
      Приёмка: Binary запускается в целевой среде/соответствующем runner; cross-compile отдельно от native run; Node daemon не нужен.
      Затрагиваемые файлы: `release/build/macos-arm64/`
  - V139 · ⋯ В очереди · (Артефакт macos/amd64) · оценка 25 мин–50 мин · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V104, V106, V125 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Reproducible locked build с embedded UI/Skills, digest и platform manifest.
      Приёмка: Binary запускается в целевой среде/соответствующем runner; cross-compile отдельно от native run; Node daemon не нужен.
      Затрагиваемые файлы: `release/build/macos-amd64/`
  - V128 · ⋯ В очереди · (Свежий агент при выключенном MCP) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 7 · зависит: V125, V043, V112 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Остановить только test daemon; read markers→claim→безопасный release через runner→receipt.
      Приёмка: Ноль вопросов о назначении свободного owner, одна операция; повтор MCP видит тот же owner.
      Затрагиваемые файлы: `acceptance/recovery/offline/`
  - V135 · ⋯ В очереди · (Репетиция rollback с новым intent) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 9 · зависит: V134 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Изолированный candidate принимает тестовый intent, rollback читает его без replay.
      Приёмка: Unknown/confirmed и HumanStop не потеряны; incompatible schema останавливает writes.
      Затрагиваемые файлы: `acceptance/migration/rollback/`
  - V140 · ⋯ В очереди · (Параметризованный installer) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V136, V137, V138, V139 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Install artifact/config/manifest/local instruction, preserve data; explicit paths и service launcher.
      Приёмка: Нестандартный root работает; offline CLI доступен без daemon; чужой service/config не меняется.
      Затрагиваемые файлы: `release/install/`
  - V142 · ⋯ В очереди · (Интеграционное ревью кандидата) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V060, V069, V078, V087, V096, V109, V112, V115, V118, V121, V124, V102, V098, V099, V100, V101, V103, V127, V128, V141, V135, V050 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один diff review по boundaries/errors/ownership/cutover; конкретный журнал дефектов.
      Приёмка: Все найденные defects имеют owned fix/retest leaf до release; review не выдаёт будущий PASS.
      Затрагиваемые файлы: `acceptance/review/`
  - V143 · ⋯ В очереди · (Удалить legacy daemon и registrations) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V142, V140 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Удалить заменённые TS daemon/job API/_async/aliases из source и package entrypoints.
      Приёмка: Старые имена не вызываются напрямую; frontend TS сохранён как frontend; native histories не удалены.
      Затрагиваемые файлы: `legacy-removal:runtime paths resolved in reviewed diff`
  - V144 · ⋯ В очереди · (Удалить legacy active clients/launchers) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V143 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Пакеты/hooks/docs consumers используют новый API; прежние fallback writers disabled.
      Приёмка: Legacy references только в историческом archive; runtime graph не запускает старый daemon.
      Затрагиваемые файлы: `legacy-removal:active client paths from consumer targets`
  - V145 · ⋯ В очереди · (Зафиксировать immutable release candidate) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V144 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Build exact reviewed source после удаления legacy, manifests всех платформ.
      Приёмка: Каждая тестовая lane указывает один source revision/artifact family; чужой WIP не включён.
      Затрагиваемые файлы: `release/candidate.json`
  - V146 · ⋯ В очереди · (Candidate: контроль codex) · оценка 20 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V145, V060 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
      Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
      Затрагиваемые файлы: `acceptance/candidate/codex/`
  - V147 · ⋯ В очереди · (Candidate: контроль opencode) · оценка 20 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V145, V069 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
      Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
      Затрагиваемые файлы: `acceptance/candidate/opencode/`
  - V148 · ⋯ В очереди · (Candidate: контроль zcode) · оценка 20 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V145, V078 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
      Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
      Затрагиваемые файлы: `acceptance/candidate/zcode/`
  - V149 · ⋯ В очереди · (Candidate: контроль chatgpt) · оценка 20 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V145, V087 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
      Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
      Затрагиваемые файлы: `acceptance/candidate/chatgpt/`
  - V150 · ⋯ В очереди · (Candidate: контроль z-ai) · оценка 20 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V145, V096 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один обязательный adapter lane повторён на финальном artifact без иных изменений.
      Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS.
      Затрагиваемые файлы: `acceptance/candidate/z-ai/`
  - V151 · ⋯ В очереди · (Candidate: проверка соединённых consumers) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V145, V109, V112, V115, V118, V121, V124 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Сверить ранее полученные consumer proofs с API/schema digest RC; повторить затронутый основной путь.
      Приёмка: Несовпадение digest требует отдельной адресной проверки; нельзя принять устаревший receipt.
      Затрагиваемые файлы: `acceptance/candidate/consumers/`
  - V152 · ⋯ В очереди · (Preflight cutover и резервная копия) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V140, V135, V146, V147, V148, V149, V150, V151 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Проверить точные target/config/version/права, snapshot и maintenance window выбранного выпуска.
      Приёмка: Нет неизвестных active writers/release effects; backup восстановим; fail-fast до остановки.
      Затрагиваемые файлы: `release/cutover/preflight.json`
  - V153 · ⋯ В очереди · (Переключить state и единственного writer) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V152 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Остановить старый entrypoint, выполнить проверенный импорт и установить Linux target candidate.
      Приёмка: Новый runtime SHA/digest/schema; один owner writer; не возобновлены UNKNOWN или HumanStop.
      Затрагиваемые файлы: `release/cutover/linux/`
  - V154 · ⋯ В очереди · (Linux: обычный потребитель после установки) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V153 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Primary MCP consumer create/deliver/recent/export/context на тестовых сессиях, reload.
      Приёмка: Runtime→receipt→native readback доказаны; приложение работает после штатного restart.
      Затрагиваемые файлы: `acceptance/installed/linux/`
  - V155 · ⋯ В очереди · (macOS: установка точного артефакта) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V154, V140 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Target preflight, config/manifest, штатный launcher; без чужих profiles.
      Приёмка: Artifact digest и version совпали, offline path установлен; rollback доступен.
      Затрагиваемые файлы: `release/cutover/macos/`
  - V156 · ⋯ В очереди · (macOS: обычный потребитель после установки) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: V155 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Create/read/deliver/stop и restart конкретного native instance.
      Приёмка: Installed consumer readback, permissions и native filesystem semantics доказаны.
      Затрагиваемые файлы: `acceptance/installed/macos/`
  - V157 · ⋯ В очереди · (Независимая приёмка общения) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 11 · зависит: V154, V156, V102 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Свежий tester без кода/авторского отчёта: discover→create→deliver→read→stop и compaction reply.
      Приёмка: Правильный sender/creator и отсутствие duplicate; тестовый circuit, никаких звонков людям.
      Затрагиваемые файлы: `acceptance/independent/communication/`
  - V158 · ⋯ В очереди · (Независимая приёмка recovery) · оценка 30 мин–1 ч · усилие не измерено · ждёт: причина не названа · волна 11 · зависит: V157, V128 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Свежий tester по локальному Skill при выключенном test MCP; checkout conflict и release receipt.
      Приёмка: Успешный claim без назначения человеком; UNKNOWN не повторён; wrong root не свободен.
      Затрагиваемые файлы: `acceptance/independent/recovery/`
  - V159 · ⋯ В очереди · (Main, runbook и передача результата) · оценка 30 мин–45 мин · усилие не измерено · ждёт: причина не названа · волна 11 · зависит: V158 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Только owned commits; опубликованный main, artifacts и acceptance manifest; чистка только своих принятых временных сред.
      Приёмка: Remote main включает результат; zero unresolved mandatory defects; scope exclusions названы и явно приняты, не молча вычеркнуты.
      Затрагиваемые файлы: `release/handoff/`