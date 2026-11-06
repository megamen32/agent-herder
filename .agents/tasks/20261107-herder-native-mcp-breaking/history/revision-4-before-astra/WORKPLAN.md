# Рабочие задания новой реализации Agent Herder

Ревизия 4. Rust/rmcp; обязательные контракты [координации](COORDINATION.md) и [работы без MCP](RECOVERY-STORAGE.md). Все задачи описаны до начала реализации; обследования старой архитектуры и флота отсутствуют.

149 задач; каждая 30–60 минут; сумма планового усилия 138.5 ч. Это не календарный срок. Старые отклонённые задачи не входят в сумму.

Зависимости задают необходимые входы. Для одного рабочего пути назначается один исполнитель. Параллельные адаптеры имеют отдельные каталоги. Предварительные пути consumer-change уточняются при конкретном изменении этого потребителя, без отдельного общего обследования.

## Порядок и критерии

### Ядро Rust и MCP

**R001. Собираемый Rust binary и команды serve/version — 30 мин.**
Вход: нет. Результат: Один crate приложения, Cargo.lock, точная зависимость rmcp 3.9.0, командный вход.
Приёмка: Binary запускается, сообщает build revision, корректно завершает процесс по сигналу.
Область: `crates/herder/Cargo.toml`.

**R002. Переносимая конфигурация ноды и экземпляров — 45 мин.**
Вход: R001. Результат: Типизированная конфигурация listeners/state_dir/peers/instances; secret refs вместо секретов в JSON.
Приёмка: Произвольные имена и адреса; duplicate instance_id и неверный endpoint объясняются до запуска.
Область: `crates/herder/src/config/`.

**R003. Адреса node/instance/session и instance registry — 45 мин.**
Вход: R002. Результат: Стабильные ссылки, отдельные instance profiles; общий Adapter trait и тип capabilities.
Приёмка: Одинаковый native_session_id в двух экземплярах не пересекается; разрешения не следуют из знания ссылки.
Область: `crates/herder/src/domain/`.

**R004. MCP 2026-07-28 через HTTP и stdio — 60 мин.**
Вход: R003. Результат: Discovery и transport lifecycle на rmcp; только согласованная ревизия, один application entrypoint.
Приёмка: Настоящий клиент подключается; старая ревизия получает понятный отказ до side effect.
Область: `crates/herder/src/mcp/transport.rs`.

**R005. Реестр ровно 17 публичных инструментов — 45 мин.**
Вход: R004. Результат: Одна декларация имён, typed schemas, описаний и handlers; никакого динамического legacy forwarding.
Приёмка: tools/list и dispatch используют один registry; старое имя не вызывается.
Область: `crates/herder/src/mcp/catalog.rs`.

**R006. Схемы session/create/deliver/wake/stop — 60 мин.**
Вход: R005. Результат: Typed schemas lifecycle; session context/messages и deliver reply_to из COORDINATION.md, без новых команд.
Приёмка: Self из проверенной привязки; поля sender не позволяют impersonation; конфликт target/reply_to объясняется до side effect.
Область: `crates/herder/src/contracts/session.rs`.

**R007. Схемы nodes/list/search/models/export — 45 мин.**
Вход: R005. Результат: Typed read DTO, cursors, freshness и coverage.
Приёмка: Частичный ответ не превращается в полный при сериализации.
Область: `crates/herder/src/contracts/read.rs`.

**R008. Схемы autopilot/cron/notes/workspace/settings/permission/human_request — 60 мин.**
Вход: R005. Результат: У каждого action одна форма; workspace различает resource kind checkout/release; MCP input_required отдельно от внешнего human_request.
Приёмка: Неизвестные поля и конфликтующие действия отвергаются с точной веткой схемы.
Область: `crates/herder/src/contracts/control.rs`.

**R009. Исправимые validation и domain errors — 60 мин.**
Вход: R006, R007, R008. Результат: Error path/actual/expected/fix/effect/retry; generated corrected call без секретов.
Приёмка: Две исходные ошибки из CI воспроизводятся через MCP и дают исправление за один новый вызов.
Область: `crates/herder/src/error/`.

**R010. SQLite state schema и атомарные транзакции — 60 мин.**
Вход: R003. Результат: SQLite для Tasks/holds/delivery intents/config/correspondence; ownership является каноническим JSON из RECOVERY-STORAGE.md, его DB-проекция восстанавливаема.
Приёмка: Рестарт сохраняет состояние; несовместимая schema version не открывается для записи.
Область: `crates/herder/src/store/`.

**R011. Стандартные Tasks create/get/update/cancel — 60 мин.**
Вход: R004, R010. Результат: rmcp TaskManager связан с durable store; отсутствует отдельный job API.
Приёмка: Клиент видит resultType=task и финальный результат; missing capability -32021 до mutation.
Область: `crates/herder/src/mcp/tasks.rs`.

**R012. Восстановление и отмена Task после рестарта — 60 мин.**
Вход: R011. Результат: Persisted native correlation и outcome; cancellation отдельно от результата побочного эффекта.
Приёмка: Рестарт после admission не повторяет отправку; UNKNOWN не объявляется failed-safe-to-retry.
Область: `crates/herder/src/store/task_recovery.rs`.

**R013. Права вызовов и ресурсов на границе ноды — 60 мин.**
Вход: R004, R003. Результат: Authenticated principal, scope checks и redaction; единые проверки для local/remote.
Приёмка: Чужой session_ref не открывает историю, Task и subscriptions; secret не попадает в errors.
Область: `crates/herder/src/auth/`.

**R014. Ресурсы сессий, проектов и результатов — 45 мин.**
Вход: R013, R007. Результат: resources/list/read и templates, стабильные revisions, доступное удалённое чтение.
Приёмка: Результат remote export читается клиентом; неизвестный URI даёт корректную диагностику.
Область: `crates/herder/src/mcp/resources.rs`.

**R015. Подписки, backpressure и resync — 60 мин.**
Вход: R014, R011. Результат: subscriptions/listen с acknowledged filter, ограниченной очередью и повторным чтением ресурса.
Приёмка: После disconnect клиент получает актуальное состояние; slow subscriber не блокирует ноду.
Область: `crates/herder/src/mcp/subscriptions.rs`.

**R016. Skills discovery и manifests — 45 мин.**
Вход: R014. Результат: Стандартные skills/list/get, ресурсы файлов, digests и защита путей.
Приёмка: Реальный клиент читает SKILL.md и ссылки; чужой путь и неверный digest не принимаются.
Область: `crates/herder/src/mcp/skills.rs`.

**R017. Межнодовой вызов без второго controller — 60 мин.**
Вход: R013, R003, R011. Результат: Peer client маршрутизирует точный instance к его owner; timeouts и capability errors сохраняются.
Приёмка: Недоступная нода не приводит к локальному созданию замены; права перепроверяются получателем.
Область: `crates/herder/src/peer/`.

**R018. Дедупликация create/deliver на принимающей ноде — 60 мин.**
Вход: R010, R017. Результат: Request key связан с principal/target/payload; durable admission intent до native call.
Приёмка: Повтор того же key возвращает исходный receipt; другой payload с тем же key даёт conflict.
Область: `crates/herder/src/application/intent.rs`.

**R019. Общий create_session и именованные цели — 45 мин.**
Вход: R018, R006, R133. Результат: Создание с точным instance_ref; created_by из authenticated caller сохраняется в create intent и связывается с native receipt.
Приёмка: Два одинаковых имени на разных instance разрешены; неоднозначная цель не выбирается наугад.
Область: `crates/herder/src/application/create.rs`.

**R020. Общая доставка current-turn/queue/start — 60 мин.**
Вход: R018, R006. Результат: Один dispatch для всех adapters, однозначные mode и activation defaults.
Приёмка: Busy/idle/unsupported имеют проверяемые результаты; режим не подменяется молча.
Область: `crates/herder/src/application/deliver.rs`.

**R021. HumanStop и native interruption — 60 мин.**
Вход: R020. Результат: Hold фиксируется независимо от успеха interrupt; снятие требует полномочий человека.
Приёмка: Гонка stop/deliver и рестарт сохраняют hold; model-provided humanRequested не снимает его.
Область: `crates/herder/src/application/stop.rs`.

**R022. Wake и зависимости от стандартных Tasks — 45 мин.**
Вход: R011, R021. Результат: Продолжение точной сессии один раз после заданного результата; без собственного wait API.
Приёмка: Повтор notification не создаёт второго хода; failed dependency и STOP объясняются.
Область: `crates/herder/src/application/wake.rs`.

**R023. Cron CRUD и разовая отложенная доставка — 45 мин.**
Вход: R010, R020. Результат: Явные schedule/timezone/missed-run policy; durable record, update/pause/delete.
Приёмка: Неверное расписание сообщает поле и допустимую форму; изменение требует version precondition.
Область: `crates/herder/src/scheduler/config.rs`.

**R024. Выполнение расписаний при рестарте и DST — 60 мин.**
Вход: R023, R021. Результат: Один executor запуска, no-overlap по умолчанию и отсутствие replay просроченных jobs.
Приёмка: DST, clock shift, pause во время admission и restart не дают дубликатов.
Область: `crates/herder/src/scheduler/run.rs`.

**R025. Autopilot state и запуск одного продолжения — 60 мин.**
Вход: R022, R021. Результат: Цель/enable/disable/status и интеграция judge; одинаковый путь для hook/observer.
Приёмка: Два события конца одного turn дают одно продолжение; завершённая цель и human stop его запрещают.
Область: `crates/herder/src/autopilot/`.

**R026. Session recent по умолчанию и update — 60 мин.**
Вход: R003, R006, R014. Результат: Последние user/assistant отдельно, turn/time/completeness; compact явно; поддерживаемые settings.
Приёмка: Удалённое чтение сохраняет обе роли; старый ответ не выдаётся за ответ на новый запрос.
Область: `crates/herder/src/application/session.rs`.

**R027. Единый transcript формат и cursor — 60 мин.**
Вход: R014, R007. Результат: Роли, content blocks, native fields, snapshot cursor и исходный формат.
Приёмка: Cursor другой сессии отвергается; последняя страница и partial проверяются явно.
Область: `crates/herder/src/transcript/`.

**R028. Инкрементальный индекс и проекты — 60 мин.**
Вход: R010, R027. Результат: Ограниченные порции ingest, FTS, профильные source cursors и catalog проектов.
Приёмка: Изменение одной сессии обновляет её индекс без полного scan; reads не блокируются записью.
Область: `crates/herder/src/search/store.rs`.

**R029. Поиск и списки с честным coverage — 45 мин.**
Вход: R028, R017. Результат: list_sessions/search/nodes с pagination, freshness и недоступными источниками.
Приёмка: Неответившая нода указана; заголовки и сообщения не смешиваются по обещанной полноте.
Область: `crates/herder/src/application/read.rs`.

**R030. Модели и квоты конкретного instance — 45 мин.**
Вход: R003, R007. Результат: Общий catalog/query capabilities, unknown quota и native metadata.
Приёмка: Каталоги двух профилей изолированы; неизвестная квота не равна нулю или unlimited.
Область: `crates/herder/src/application/models.rs`.

**R031. Coordination notes и scoped delivery context — 45 мин.**
Вход: R010, R020, R013. Результат: Scoped заметки координации; фактические участники/родство читаются из общего context, а не восстанавливаются из текста заметок.
Приёмка: Истёкшая/чужая заметка не инжектируется; нельзя изменить чужую запись.
Область: `crates/herder/src/application/notes.rs`.

**R032. Рабочие пути, декларации и reservations — 60 мин.**
Вход: R003, R010, R013, R143. Результат: Work hosts/paths и declarations; ownership/reservations через каноническую файловую библиотеку. SQLite содержит только восстанавливаемую проекцию ownership.
Приёмка: Декларация не выдаётся за lease; резервация конфликтующего пути видна обоим владельцам.
Область: `crates/herder/src/application/workspace.rs`.

**R033. Settings desired/applied и CAS — 60 мин.**
Вход: R010, R013, R017. Результат: Общие/локальные значения, revisions, deviations и administrative automation hold.
Приёмка: Stale update не перетирает новую настройку; недоступная нода остаётся unconfirmed.
Область: `crates/herder/src/application/settings.rs`.

**R034. Нативные permission requests — 45 мин.**
Вход: R003, R013, R014. Результат: Точный pending request, allow/deny и поддерживаемая policy.
Приёмка: Истёкший request не подтверждает другой; вызывающий без полномочий получает отказ.
Область: `crates/herder/src/application/permission.rs`.

**R035. MCP input_required и внешний human_request — 60 мин.**
Вход: R011, R022, R013. Результат: Стандартный запрос ввода внутри Task; external question correlation для Notice Place.
Приёмка: Ответ относится к одной сессии и возобновляет её один раз; нет двойного lifecycle.
Область: `crates/herder/src/application/human.rs`.

**R036. Rust native CI client и детерминированный endpoint — 60 мин.**
Вход: R004, R011. Результат: Runner вызывает новый MCP; настоящие harness запускаются с отдельными профилями и локальной моделью.
Приёмка: Receipt содержит target IDs, число вызовов и boundary trace; mock adapter не выдаётся за native.
Область: `crates/herder/tests/native/`.

### Адаптер Codex

**R037. Codex: подключение отдельного профиля — 60 мин.**
Вход: R003, R004. Результат: Реализовать app-server JSON-RPC; explicit profile/endpoint, native version и capabilities.
Приёмка: Handshake одного instance не открывает другой профиль; unavailable объясняет исправление.
Область: `crates/herder/src/adapters/codex/connection.rs`.

**R038. Codex: список сессий и последние сообщения — 60 мин.**
Вход: R037, R026. Результат: Native IDs, status, recent user/assistant, timestamps и точный источник.
Приёмка: Две сессии возвращают свои сообщения; отсутствующая история явно unavailable.
Область: `crates/herder/src/adapters/codex/read.rs`.

**R039. Codex: создание и доставка сообщения — 60 мин.**
Вход: R037, R019, R020. Результат: Native create/send/steer/queue где supported; native receipt привязан к request key.
Приёмка: Один вызов → одно native admission; неподдерживаемый mode не подменяется.
Область: `crates/herder/src/adapters/codex/write.rs`.

**R040. Codex: полный transcript и ingest — 60 мин.**
Вход: R038, R027, R028. Результат: Постраничный native export, snapshot completeness и feed общего индекса.
Приёмка: Две полные истории с конечным cursor; нельзя подмешать чужие страницы.
Область: `crates/herder/src/adapters/codex/transcript.rs`.

**R041. Codex: остановка и заявленные управляющие capabilities — 60 мин.**
Вход: R039, R021, R034, R030. Результат: Native interruption, model/settings и permission surface только где реально доступны.
Приёмка: Каждая заявленная capability подтверждена; unsupported не маскируется success.
Область: `crates/herder/src/adapters/codex/control.rs`.

**R042. Codex: установленный стенд и реальный canary — 45 мин.**
Вход: R040, R041, R036, R029. Результат: Через обычный MCP создать/найти две сессии, доставить, прочитать recent/transcript/search.
Приёмка: Exact IDs, admission counts, coverage и artifact revision; fixture не закрывает real browser lane.
Область: `crates/herder/src/adapters/codex/native_acceptance.rs`.

### Адаптер Claude

**R043. Claude: подключение отдельного профиля — 60 мин.**
Вход: R003, R004. Результат: Реализовать штатный CLI/stream JSON; explicit profile/endpoint, native version и capabilities.
Приёмка: Handshake одного instance не открывает другой профиль; unavailable объясняет исправление.
Область: `crates/herder/src/adapters/claude/connection.rs`.

**R044. Claude: список сессий и последние сообщения — 60 мин.**
Вход: R043, R026. Результат: Native IDs, status, recent user/assistant, timestamps и точный источник.
Приёмка: Две сессии возвращают свои сообщения; отсутствующая история явно unavailable.
Область: `crates/herder/src/adapters/claude/read.rs`.

**R045. Claude: создание и доставка сообщения — 60 мин.**
Вход: R043, R019, R020. Результат: Native create/send/steer/queue где supported; native receipt привязан к request key.
Приёмка: Один вызов → одно native admission; неподдерживаемый mode не подменяется.
Область: `crates/herder/src/adapters/claude/write.rs`.

**R046. Claude: полный transcript и ingest — 60 мин.**
Вход: R044, R027, R028. Результат: Постраничный native export, snapshot completeness и feed общего индекса.
Приёмка: Две полные истории с конечным cursor; нельзя подмешать чужие страницы.
Область: `crates/herder/src/adapters/claude/transcript.rs`.

**R047. Claude: остановка и заявленные управляющие capabilities — 60 мин.**
Вход: R045, R021, R034, R030. Результат: Native interruption, model/settings и permission surface только где реально доступны.
Приёмка: Каждая заявленная capability подтверждена; unsupported не маскируется success.
Область: `crates/herder/src/adapters/claude/control.rs`.

**R048. Claude: установленный стенд и реальный canary — 45 мин.**
Вход: R046, R047, R036, R029. Результат: Через обычный MCP создать/найти две сессии, доставить, прочитать recent/transcript/search.
Приёмка: Exact IDs, admission counts, coverage и artifact revision; fixture не закрывает real browser lane.
Область: `crates/herder/src/adapters/claude/native_acceptance.rs`.

### Адаптер OpenCode

**R049. OpenCode: подключение отдельного профиля — 60 мин.**
Вход: R003, R004. Результат: Реализовать HTTP API и events; explicit profile/endpoint, native version и capabilities.
Приёмка: Handshake одного instance не открывает другой профиль; unavailable объясняет исправление.
Область: `crates/herder/src/adapters/opencode/connection.rs`.

**R050. OpenCode: список сессий и последние сообщения — 60 мин.**
Вход: R049, R026. Результат: Native IDs, status, recent user/assistant, timestamps и точный источник.
Приёмка: Две сессии возвращают свои сообщения; отсутствующая история явно unavailable.
Область: `crates/herder/src/adapters/opencode/read.rs`.

**R051. OpenCode: создание и доставка сообщения — 60 мин.**
Вход: R049, R019, R020. Результат: Native create/send/steer/queue где supported; native receipt привязан к request key.
Приёмка: Один вызов → одно native admission; неподдерживаемый mode не подменяется.
Область: `crates/herder/src/adapters/opencode/write.rs`.

**R052. OpenCode: полный transcript и ingest — 60 мин.**
Вход: R050, R027, R028. Результат: Постраничный native export, snapshot completeness и feed общего индекса.
Приёмка: Две полные истории с конечным cursor; нельзя подмешать чужие страницы.
Область: `crates/herder/src/adapters/opencode/transcript.rs`.

**R053. OpenCode: остановка и заявленные управляющие capabilities — 60 мин.**
Вход: R051, R021, R034, R030. Результат: Native interruption, model/settings и permission surface только где реально доступны.
Приёмка: Каждая заявленная capability подтверждена; unsupported не маскируется success.
Область: `crates/herder/src/adapters/opencode/control.rs`.

**R054. OpenCode: установленный стенд и реальный canary — 45 мин.**
Вход: R052, R053, R036, R029. Результат: Через обычный MCP создать/найти две сессии, доставить, прочитать recent/transcript/search.
Приёмка: Exact IDs, admission counts, coverage и artifact revision; fixture не закрывает real browser lane.
Область: `crates/herder/src/adapters/opencode/native_acceptance.rs`.

### Адаптер ZCode

**R055. ZCode: подключение отдельного профиля — 60 мин.**
Вход: R003, R004. Результат: Реализовать нативный session/queue transport; explicit profile/endpoint, native version и capabilities.
Приёмка: Handshake одного instance не открывает другой профиль; unavailable объясняет исправление.
Область: `crates/herder/src/adapters/zcode/connection.rs`.

**R056. ZCode: список сессий и последние сообщения — 60 мин.**
Вход: R055, R026. Результат: Native IDs, status, recent user/assistant, timestamps и точный источник.
Приёмка: Две сессии возвращают свои сообщения; отсутствующая история явно unavailable.
Область: `crates/herder/src/adapters/zcode/read.rs`.

**R057. ZCode: создание и доставка сообщения — 60 мин.**
Вход: R055, R019, R020. Результат: Native create/send/steer/queue где supported; native receipt привязан к request key.
Приёмка: Один вызов → одно native admission; неподдерживаемый mode не подменяется.
Область: `crates/herder/src/adapters/zcode/write.rs`.

**R058. ZCode: полный transcript и ingest — 60 мин.**
Вход: R056, R027, R028. Результат: Постраничный native export, snapshot completeness и feed общего индекса.
Приёмка: Две полные истории с конечным cursor; нельзя подмешать чужие страницы.
Область: `crates/herder/src/adapters/zcode/transcript.rs`.

**R059. ZCode: остановка и заявленные управляющие capabilities — 60 мин.**
Вход: R057, R021, R034, R030. Результат: Native interruption, model/settings и permission surface только где реально доступны.
Приёмка: Каждая заявленная capability подтверждена; unsupported не маскируется success.
Область: `crates/herder/src/adapters/zcode/control.rs`.

**R060. ZCode: установленный стенд и реальный canary — 45 мин.**
Вход: R058, R059, R036, R029. Результат: Через обычный MCP создать/найти две сессии, доставить, прочитать recent/transcript/search.
Приёмка: Exact IDs, admission counts, coverage и artifact revision; fixture не закрывает real browser lane.
Область: `crates/herder/src/adapters/zcode/native_acceptance.rs`.

### Адаптер Qoder

**R061. Qoder: подключение отдельного профиля — 60 мин.**
Вход: R003, R004. Результат: Реализовать штатный CLI/session transport; explicit profile/endpoint, native version и capabilities.
Приёмка: Handshake одного instance не открывает другой профиль; unavailable объясняет исправление.
Область: `crates/herder/src/adapters/qoder/connection.rs`.

**R062. Qoder: список сессий и последние сообщения — 60 мин.**
Вход: R061, R026. Результат: Native IDs, status, recent user/assistant, timestamps и точный источник.
Приёмка: Две сессии возвращают свои сообщения; отсутствующая история явно unavailable.
Область: `crates/herder/src/adapters/qoder/read.rs`.

**R063. Qoder: создание и доставка сообщения — 60 мин.**
Вход: R061, R019, R020. Результат: Native create/send/steer/queue где supported; native receipt привязан к request key.
Приёмка: Один вызов → одно native admission; неподдерживаемый mode не подменяется.
Область: `crates/herder/src/adapters/qoder/write.rs`.

**R064. Qoder: полный transcript и ingest — 60 мин.**
Вход: R062, R027, R028. Результат: Постраничный native export, snapshot completeness и feed общего индекса.
Приёмка: Две полные истории с конечным cursor; нельзя подмешать чужие страницы.
Область: `crates/herder/src/adapters/qoder/transcript.rs`.

**R065. Qoder: остановка и заявленные управляющие capabilities — 60 мин.**
Вход: R063, R021, R034, R030. Результат: Native interruption, model/settings и permission surface только где реально доступны.
Приёмка: Каждая заявленная capability подтверждена; unsupported не маскируется success.
Область: `crates/herder/src/adapters/qoder/control.rs`.

**R066. Qoder: установленный стенд и реальный canary — 45 мин.**
Вход: R064, R065, R036, R029. Результат: Через обычный MCP создать/найти две сессии, доставить, прочитать recent/transcript/search.
Приёмка: Exact IDs, admission counts, coverage и artifact revision; fixture не закрывает real browser lane.
Область: `crates/herder/src/adapters/qoder/native_acceptance.rs`.

### Адаптер Hermes

**R067. Hermes: подключение отдельного профиля — 60 мин.**
Вход: R003, R004. Результат: Реализовать native session transport и профильная история; explicit profile/endpoint, native version и capabilities.
Приёмка: Handshake одного instance не открывает другой профиль; unavailable объясняет исправление.
Область: `crates/herder/src/adapters/hermes/connection.rs`.

**R068. Hermes: список сессий и последние сообщения — 60 мин.**
Вход: R067, R026. Результат: Native IDs, status, recent user/assistant, timestamps и точный источник.
Приёмка: Две сессии возвращают свои сообщения; отсутствующая история явно unavailable.
Область: `crates/herder/src/adapters/hermes/read.rs`.

**R069. Hermes: создание и доставка сообщения — 60 мин.**
Вход: R067, R019, R020. Результат: Native create/send/steer/queue где supported; native receipt привязан к request key.
Приёмка: Один вызов → одно native admission; неподдерживаемый mode не подменяется.
Область: `crates/herder/src/adapters/hermes/write.rs`.

**R070. Hermes: полный transcript и ingest — 60 мин.**
Вход: R068, R027, R028. Результат: Постраничный native export, snapshot completeness и feed общего индекса.
Приёмка: Две полные истории с конечным cursor; нельзя подмешать чужие страницы.
Область: `crates/herder/src/adapters/hermes/transcript.rs`.

**R071. Hermes: остановка и заявленные управляющие capabilities — 60 мин.**
Вход: R069, R021, R034, R030. Результат: Native interruption, model/settings и permission surface только где реально доступны.
Приёмка: Каждая заявленная capability подтверждена; unsupported не маскируется success.
Область: `crates/herder/src/adapters/hermes/control.rs`.

**R072. Hermes: установленный стенд и реальный canary — 45 мин.**
Вход: R070, R071, R036, R029. Результат: Через обычный MCP создать/найти две сессии, доставить, прочитать recent/transcript/search.
Приёмка: Exact IDs, admission counts, coverage и artifact revision; fixture не закрывает real browser lane.
Область: `crates/herder/src/adapters/hermes/native_acceptance.rs`.

### Адаптер Fast Agent

**R073. Fast Agent: подключение отдельного профиля — 60 мин.**
Вход: R003, R004. Результат: Реализовать native session transport; explicit profile/endpoint, native version и capabilities.
Приёмка: Handshake одного instance не открывает другой профиль; unavailable объясняет исправление.
Область: `crates/herder/src/adapters/fast_agent/connection.rs`.

**R074. Fast Agent: список сессий и последние сообщения — 60 мин.**
Вход: R073, R026. Результат: Native IDs, status, recent user/assistant, timestamps и точный источник.
Приёмка: Две сессии возвращают свои сообщения; отсутствующая история явно unavailable.
Область: `crates/herder/src/adapters/fast_agent/read.rs`.

**R075. Fast Agent: создание и доставка сообщения — 60 мин.**
Вход: R073, R019, R020. Результат: Native create/send/steer/queue где supported; native receipt привязан к request key.
Приёмка: Один вызов → одно native admission; неподдерживаемый mode не подменяется.
Область: `crates/herder/src/adapters/fast_agent/write.rs`.

**R076. Fast Agent: полный transcript и ingest — 60 мин.**
Вход: R074, R027, R028. Результат: Постраничный native export, snapshot completeness и feed общего индекса.
Приёмка: Две полные истории с конечным cursor; нельзя подмешать чужие страницы.
Область: `crates/herder/src/adapters/fast_agent/transcript.rs`.

**R077. Fast Agent: остановка и заявленные управляющие capabilities — 60 мин.**
Вход: R075, R021, R034, R030. Результат: Native interruption, model/settings и permission surface только где реально доступны.
Приёмка: Каждая заявленная capability подтверждена; unsupported не маскируется success.
Область: `crates/herder/src/adapters/fast_agent/control.rs`.

**R078. Fast Agent: установленный стенд и реальный canary — 45 мин.**
Вход: R076, R077, R036, R029. Результат: Через обычный MCP создать/найти две сессии, доставить, прочитать recent/transcript/search.
Приёмка: Exact IDs, admission counts, coverage и artifact revision; fixture не закрывает real browser lane.
Область: `crates/herder/src/adapters/fast_agent/native_acceptance.rs`.

### Адаптер MiniMax Code

**R079. MiniMax Code: подключение отдельного профиля — 60 мин.**
Вход: R003, R004. Результат: Реализовать штатный ACP/CLI; explicit profile/endpoint, native version и capabilities.
Приёмка: Handshake одного instance не открывает другой профиль; unavailable объясняет исправление.
Область: `crates/herder/src/adapters/minimax/connection.rs`.

**R080. MiniMax Code: список сессий и последние сообщения — 60 мин.**
Вход: R079, R026. Результат: Native IDs, status, recent user/assistant, timestamps и точный источник.
Приёмка: Две сессии возвращают свои сообщения; отсутствующая история явно unavailable.
Область: `crates/herder/src/adapters/minimax/read.rs`.

**R081. MiniMax Code: создание и доставка сообщения — 60 мин.**
Вход: R079, R019, R020. Результат: Native create/send/steer/queue где supported; native receipt привязан к request key.
Приёмка: Один вызов → одно native admission; неподдерживаемый mode не подменяется.
Область: `crates/herder/src/adapters/minimax/write.rs`.

**R082. MiniMax Code: полный transcript и ingest — 60 мин.**
Вход: R080, R027, R028. Результат: Постраничный native export, snapshot completeness и feed общего индекса.
Приёмка: Две полные истории с конечным cursor; нельзя подмешать чужие страницы.
Область: `crates/herder/src/adapters/minimax/transcript.rs`.

**R083. MiniMax Code: остановка и заявленные управляющие capabilities — 60 мин.**
Вход: R081, R021, R034, R030. Результат: Native interruption, model/settings и permission surface только где реально доступны.
Приёмка: Каждая заявленная capability подтверждена; unsupported не маскируется success.
Область: `crates/herder/src/adapters/minimax/control.rs`.

**R084. MiniMax Code: установленный стенд и реальный canary — 45 мин.**
Вход: R082, R083, R036, R029. Результат: Через обычный MCP создать/найти две сессии, доставить, прочитать recent/transcript/search.
Приёмка: Exact IDs, admission counts, coverage и artifact revision; fixture не закрывает real browser lane.
Область: `crates/herder/src/adapters/minimax/native_acceptance.rs`.

### Адаптер ChatGPT

**R085. ChatGPT: подключение отдельного профиля — 60 мин.**
Вход: R003, R004. Результат: Реализовать авторизованный browser connection; explicit profile/endpoint, native version и capabilities.
Приёмка: Handshake одного instance не открывает другой профиль; unavailable объясняет исправление.
Область: `crates/herder/src/adapters/chatgpt/connection.rs`.

**R086. ChatGPT: список сессий и последние сообщения — 60 мин.**
Вход: R085, R026. Результат: Native IDs, status, recent user/assistant, timestamps и точный источник.
Приёмка: Две сессии возвращают свои сообщения; отсутствующая история явно unavailable.
Область: `crates/herder/src/adapters/chatgpt/read.rs`.

**R087. ChatGPT: создание и доставка сообщения — 60 мин.**
Вход: R085, R019, R020. Результат: Native create/send/steer/queue где supported; native receipt привязан к request key.
Приёмка: Один вызов → одно native admission; неподдерживаемый mode не подменяется.
Область: `crates/herder/src/adapters/chatgpt/write.rs`.

**R088. ChatGPT: полный transcript и ingest — 60 мин.**
Вход: R086, R027, R028. Результат: Постраничный native export, snapshot completeness и feed общего индекса.
Приёмка: Две полные истории с конечным cursor; нельзя подмешать чужие страницы.
Область: `crates/herder/src/adapters/chatgpt/transcript.rs`.

**R089. ChatGPT: остановка и заявленные управляющие capabilities — 60 мин.**
Вход: R087, R021, R034, R030. Результат: Native interruption, model/settings и permission surface только где реально доступны.
Приёмка: Каждая заявленная capability подтверждена; unsupported не маскируется success.
Область: `crates/herder/src/adapters/chatgpt/control.rs`.

**R090. ChatGPT: установленный стенд и реальный canary — 45 мин.**
Вход: R088, R089, R036, R029. Результат: Через обычный MCP создать/найти две сессии, доставить, прочитать recent/transcript/search.
Приёмка: Exact IDs, admission counts, coverage и artifact revision; fixture не закрывает real browser lane.
Область: `crates/herder/src/adapters/chatgpt/native_acceptance.rs`.

### Адаптер Z AI

**R091. Z AI: подключение отдельного профиля — 60 мин.**
Вход: R003, R004. Результат: Реализовать авторизованный browser connection; explicit profile/endpoint, native version и capabilities.
Приёмка: Handshake одного instance не открывает другой профиль; unavailable объясняет исправление.
Область: `crates/herder/src/adapters/zai/connection.rs`.

**R092. Z AI: список сессий и последние сообщения — 60 мин.**
Вход: R091, R026. Результат: Native IDs, status, recent user/assistant, timestamps и точный источник.
Приёмка: Две сессии возвращают свои сообщения; отсутствующая история явно unavailable.
Область: `crates/herder/src/adapters/zai/read.rs`.

**R093. Z AI: создание и доставка сообщения — 60 мин.**
Вход: R091, R019, R020. Результат: Native create/send/steer/queue где supported; native receipt привязан к request key.
Приёмка: Один вызов → одно native admission; неподдерживаемый mode не подменяется.
Область: `crates/herder/src/adapters/zai/write.rs`.

**R094. Z AI: полный transcript и ingest — 60 мин.**
Вход: R092, R027, R028. Результат: Постраничный native export, snapshot completeness и feed общего индекса.
Приёмка: Две полные истории с конечным cursor; нельзя подмешать чужие страницы.
Область: `crates/herder/src/adapters/zai/transcript.rs`.

**R095. Z AI: остановка и заявленные управляющие capabilities — 60 мин.**
Вход: R093, R021, R034, R030. Результат: Native interruption, model/settings и permission surface только где реально доступны.
Приёмка: Каждая заявленная capability подтверждена; unsupported не маскируется success.
Область: `crates/herder/src/adapters/zai/control.rs`.

**R096. Z AI: установленный стенд и реальный canary — 45 мин.**
Вход: R094, R095, R036, R029. Результат: Через обычный MCP создать/найти две сессии, доставить, прочитать recent/transcript/search.
Приёмка: Exact IDs, admission counts, coverage и artifact revision; fixture не закрывает real browser lane.
Область: `crates/herder/src/adapters/zai/native_acceptance.rs`.

### Адаптер Browser Chat

**R097. Browser Chat: подключение отдельного профиля — 60 мин.**
Вход: R003, R004. Результат: Реализовать объявленный browser endpoint; explicit profile/endpoint, native version и capabilities.
Приёмка: Handshake одного instance не открывает другой профиль; unavailable объясняет исправление.
Область: `crates/herder/src/adapters/browser_chat/connection.rs`.

**R098. Browser Chat: список сессий и последние сообщения — 60 мин.**
Вход: R097, R026. Результат: Native IDs, status, recent user/assistant, timestamps и точный источник.
Приёмка: Две сессии возвращают свои сообщения; отсутствующая история явно unavailable.
Область: `crates/herder/src/adapters/browser_chat/read.rs`.

**R099. Browser Chat: создание и доставка сообщения — 60 мин.**
Вход: R097, R019, R020. Результат: Native create/send/steer/queue где supported; native receipt привязан к request key.
Приёмка: Один вызов → одно native admission; неподдерживаемый mode не подменяется.
Область: `crates/herder/src/adapters/browser_chat/write.rs`.

**R100. Browser Chat: полный transcript и ingest — 60 мин.**
Вход: R098, R027, R028. Результат: Постраничный native export, snapshot completeness и feed общего индекса.
Приёмка: Две полные истории с конечным cursor; нельзя подмешать чужие страницы.
Область: `crates/herder/src/adapters/browser_chat/transcript.rs`.

**R101. Browser Chat: остановка и заявленные управляющие capabilities — 60 мин.**
Вход: R099, R021, R034, R030. Результат: Native interruption, model/settings и permission surface только где реально доступны.
Приёмка: Каждая заявленная capability подтверждена; unsupported не маскируется success.
Область: `crates/herder/src/adapters/browser_chat/control.rs`.

**R102. Browser Chat: установленный стенд и реальный canary — 45 мин.**
Вход: R100, R101, R036, R029. Результат: Через обычный MCP создать/найти две сессии, доставить, прочитать recent/transcript/search.
Приёмка: Exact IDs, admission counts, coverage и artifact revision; fixture не закрывает real browser lane.
Область: `crates/herder/src/adapters/browser_chat/native_acceptance.rs`.

### Приёмка ядра

**R103. Два Codex и два Claude на одной ноде — 60 мин.**
Вход: R042, R048, R017. Результат: Два профиля каждого типа, повтор native IDs в contract fixture и реальные отдельные сессии.
Приёмка: Доставка, чтение, квоты и stop не пересекают профили.
Область: `crates/herder/tests/multi_instance.rs`.

**R104. Две ноды с произвольными адресами — 60 мин.**
Вход: R042, R054, R017. Результат: Изолированная пара узлов с configurable endpoints и удалёнными resources/Tasks.
Приёмка: Нет зашитых hostname; unreachable/error сохраняется сквозь маршрут.
Область: `crates/herder/tests/remote.rs`.

**R105. Fault injection на границах native admission — 60 мин.**
Вход: R042, R012. Результат: Сбои до admission, после admission до receipt и после completion до ответа.
Приёмка: UNKNOWN сверяется; завершённый запрос не повторяется после рестарта.
Область: `crates/herder/tests/restart.rs`.

### Клиенты

**R106. Нативные hooks и плагины: новый transport — 60 мин.**
Вход: R025, R042. Результат: Общий hook client к новому контракту; адаптеры hooks не содержат второй scheduler.
Приёмка: Повтор end-turn event не порождает два продолжения; поддерживаемые profiles не смешиваются.
Область: `integrations/`.

**R107. Web UI: сессии, последние сообщения и transcript — 60 мин.**
Вход: R026, R029, R014. Результат: Типизированный клиент новых DTO; recent и remote resources отображаются без потерь.
Приёмка: Открытие и reload реальной сессии показывает обе роли и явный partial.
Область: `src/web-ui/session/`.

**R108. Web UI: доставить, остановить, изменить настройки — 60 мин.**
Вход: R107, R021, R033, R011. Результат: Действия UI используют общий application API и стандартные Tasks.
Приёмка: UI показывает admission отдельно от completion; stale settings не перетираются.
Область: `src/web-ui/control/`.

**R109. CLI к новому application API — 45 мин.**
Вход: R005, R011. Результат: Подкоманды discovery/session/deliver/export/settings с теми же типами и ошибками.
Приёмка: CLI не содержит старых HTTP route aliases и показывает исправление вызова.
Область: `crates/herder/src/cli/`.

**R110. Hub и MCP-подключение нового сервера — 60 мин.**
Вход: R004, R011, R016, R015. Результат: Обновить объявленный протокол/каталог и прохождение расширений через gateway.
Приёмка: Errors, task handles, skills и subscriptions доходят до реального клиента без потери полей.
Область: `consumer-change: Hub connector`.

**R111. LHC: общие команды и Git audit у владельца workflow — 60 мин.**
Вход: R032, R031, R109, R145, R147. Результат: LHC использует общий workspace release/checkout и автономный recovery при отказе MCP; Git audit остаётся у LHC. Свободное владение занимается без назначения человеком.
Приёмка: При выключенном MCP агент видит canonical JSON, занимает свободную роль и продолжает; неверный путь не даёт ложного owner.
Область: `consumer-change: Last Human Commit`.

**R112. Notice Place: вопрос и ответ той же сессии — 60 мин.**
Вход: R035, R106. Результат: Внешний вопрос использует новую корреляцию и общую доставку.
Приёмка: Изолированный вопрос создаёт одну карточку; ответ продолжает ту же сессию один раз.
Область: `consumer-change: Notice Place`.

**R113. UserIO: ссылки и результаты новой сессии — 45 мин.**
Вход: R035, R014. Результат: Потребитель читает доступные result refs и exact session identity.
Приёмка: Тестовый потребитель не трактует accepted как отправленный/завершённый результат.
Область: `consumer-change: UserIO`.

**R114. Board: задачи и новые session refs — 60 мин.**
Вход: R019, R020, R011. Результат: Интеграция создания/продолжения с durable refs и новым результатом.
Приёмка: Двойное действие UI не создаёт две сессии; ответ связан с исходной карточкой.
Область: `consumer-change: ExManager board`.

**R115. Секретарь: общий deliver вместо browser_wake — 45 мин.**
Вход: R102, R024. Результат: Шаблон E-Frontier находится у потребителя; Herder получает обычный target/message.
Приёмка: Продуктовый сценарий не требует специальной команды Herder.
Область: `consumer-change: secretary`.

**R116. Короткие Skills и рабочие примеры — 45 мин.**
Вход: R016, R009. Результат: Skills содержат единый маршрут session(context) → list_sessions(project) → workspace(claim) → deliver(reply_to); recovery после compaction и исправимые ошибки.
Приёмка: Skills обнаруживаются и читаются клиентом; активация проверяется отдельно.
Область: `skills/`.

### Понятность

**R117. Gemma: выбор инструментов и recent чтение — 45 мин.**
Вход: R116, R107, R110. Результат: Свежие контексты с задачами без исходников и без подсказанного workflow.
Приёмка: Модель находит actual user+assistant и не придумывает содержимое; trace и usage сохранены.
Область: `crates/herder/tests/usability/`.

**R118. Gemma: исправление ошибочного вызова — 45 мин.**
Вход: R117, R009. Результат: Неверные поля, target, capability, cursor и busy/STOP через реальный MCP.
Приёмка: Эталонные ошибки исправляются по ответу; UNKNOWN и denied не приводят к опасному retry.
Область: `crates/herder/tests/usability/errors/`.

### Данные

**R119. Одноразовый импорт Herder state — 60 мин.**
Вход: R010, R018, R033, R133, R134. Результат: Одноразовый импорт holds/intents/settings, достоверного lineage и имеющейся sender evidence. Неизвестное происхождение не угадывается; новый ledger не объявляет импорт полным.
Приёмка: Неоднозначная identity отклоняется с отчётом; импорт не запускает автоматизацию.
Область: `crates/herder/src/import/`.

**R120. Репетиция импорта и reconciliation — 60 мин.**
Вход: R119, R105. Результат: Тестовый набор terminal/in-flight/UNKNOWN/held записей проходит импорт.
Приёмка: Counts/refs/outcomes сохранены; terminal не переисполняется, UNKNOWN не теряется.
Область: `crates/herder/tests/import.rs`.

**R121. Проверенный откат после новых записей — 60 мин.**
Вход: R120, R149. Результат: Rollback сверяет новые journal/holds и canonical JSON ownership; не восстанавливает старый fence/owner из DB snapshot и не включает прежний fallback writer.
Приёмка: Откат после одной новой доставки не отправляет её повторно и не снимает holds.
Область: `crates/herder/tests/rollback.rs`.

### Поставка

**R122. Linux amd64/arm64: release binary — 45 мин.**
Вход: R001. Результат: Воспроизводимая сборка бинарника, embedded UI/skills, digest и version manifest.
Приёмка: Артефакт запускается в чистой среде без Node/Python для Herder daemon.
Область: `release/linux/`.

**R123. macOS arm64/amd64: release binary — 45 мин.**
Вход: R001. Результат: Нативные release сборки и проверка process/filesystem abstraction.
Приёмка: Binary и embedded assets читаются; native runtime не зависит от linux-only paths.
Область: `release/macos/`.

**R124. Переносимый installer и declared launch config — 60 мин.**
Вход: R122, R123, R002, R144, R147. Результат: Installer доставляет daemon, отдельный recovery binary, локальный Skill/RECOVERY.md и manifest каждому разрешённому клиенту; проверяет независимый доступ к authority.
Приёмка: Установка в нестандартный путь работает; чужие данные и сервисы не затрагиваются.
Область: `release/install/`.

### Удаление legacy

**R125. Удалить старый TypeScript daemon и callable aliases — 60 мин.**
Вход: R108, R109, R110, R106, R042, R048, R054, R060, R066, R072, R078, R084, R090, R096, R102. Результат: Удалить заменённые runtime paths, registrations, job API и compatibility forwarding.
Приёмка: Новый artifact не запускает старый daemon; прямые вызовы прежних имён не выполняются.
Область: `legacy-removal: server and MCP`.

**R126. Убрать устаревшие инструкции и service launchers — 45 мин.**
Вход: R125, R111, R112, R113, R114, R115. Результат: Активные manifests/hooks/docs/package scripts используют только новый контракт.
Приёмка: Legacy встречается только в архивной истории; нет работающих client calls на старый API.
Область: `legacy-removal: active clients and packaging`.

### Приёмка

**R127. Весь native CI на одном release candidate — 60 мин.**
Вход: R126, R104, R105, R103, R118, R121, R124, R140, R141, R148, R149. Результат: Immutable candidate проходит все обязательные adapter/consumer lanes.
Приёмка: Одна версия артефакта во всех receipts; blocked lane не превращается в PASS.
Область: `crates/herder/tests/release/`.

**R128. Нагрузка, отмена и медленные подписчики — 60 мин.**
Вход: R127. Результат: Фиксированный корпус сессий, bounded queues, concurrent clients и background indexing.
Приёмка: Нет busy polling/неограниченных буферов; latency/RSS/CPU записаны, native commands не голодают.
Область: `crates/herder/tests/performance/`.

### Поставка

**R129. Linux: установить candidate и проверить потребителя — 60 мин.**
Вход: R128. Результат: Target из параметров выпуска, preflight только перед mutation, lease/CAS, новая установка.
Приёмка: Artifact→runtime→реальный create/deliver/recent/export/search доказаны на целевой ноде.
Область: `release/accept-linux/`.

**R130. macOS: установить candidate и проверить потребителя — 60 мин.**
Вход: R128. Результат: Параметризованная установка, permissions и штатный запуск на целевом Mac.
Приёмка: После reload/restart настоящий consumer читает новые сессии и transcript.
Область: `release/accept-macos/`.

### Приёмка

**R131. Независимый пользовательский сценарий — 60 мин.**
Вход: R129, R130. Результат: Свежий tester без исходников использует обычный клиент: discover→create→deliver→read→stop.
Приёмка: Свежий агент восстанавливает creator/senders после compaction, разрешает конфликт checkout и при сломанном MCP по локальному Skill занимает свободный release без назначения человеком. Multi-instance/remote работают.
Область: `acceptance/independent/`.

### Поставка

**R132. Публикация main, runbook и очистка своих временных сред — 45 мин.**
Вход: R131. Результат: Owned commits опубликованы; documented config/install/rollback; очистка только принятых task-owned копий.
Приёмка: Remote main, release manifests и consumer evidence согласованы; открытых обязательных дефектов нет.
Область: `release/handoff/`.

## Правила исполнения

- Подробные ограниченные задачи уже записаны для всего цикла. Многочасовых исполнимых стадий нет.
- Оценки — плановые, не обещание уложить неизвестную native интеграцию в час. При конкретном блокере в протоколе лист делится по подтверждённым границам до исполнения; общий объём не маскируется.
- Неподдерживаемая операция адаптера возвращает explicit unsupported; объявленная capability требует native proof.
- Harness с внешним браузерным входом не считается проверенным по fixture. Если нет авторизованной тестовой сессии, его acceptance остаётся открытым.
- Linux/macOS — целевые платформы этой поставки. Любая инфраструктура означает произвольную топологию, адреса, пути и число экземпляров на поддерживаемых ОС; поддержка всех существующих ОС не заявляется.
- На дополнительной ноде установка повторяет соответствующий лист как отдельное задание <=60 минут. Число target deployments — вход выпуска, не параметр архитектуры.
- Обнаруженные дефекты исправляются отдельными bounded задачами; приёмка не закрывается по проценту готовности.
- Принимаются только owned изменения. Чужой WIP и native histories сохраняются. Нет массового reset/stash/delete.
- Rust выбран для daemon/core/CLI/adapters. Web UI остаётся браузерным кодом; native harness остаётся внешним процессом.
- Публичных команд 17; jobs/operation API не создаётся. Tasks, subscriptions, Skills — стандарт MCP.
- Текущий ход только меняет план. Реализация, отправка поручений и выкладка не начаты.

## Долговечная координация и восстановление контекста

Номера новых задач не задают очередь: связи depends_on включают их в ядро и итоговую приёмку.

**R133. Создатель и native parent как долговечные разные связи — 45 мин.**
Вход: R003, R010, R013. Результат: Схема relationships, provenance и authenticated caller binding; created_by фиксируется в create intent до native dispatch.
Приёмка: Создатель другой ноды/среды переживает рестарт; native parent и последний отправитель не перезаписывают created_by; unknown не угадывается.
Область: `crates/herder/src/store/relationships.rs`.

**R134. Журнал корреспонденции и ответ по message_ref — 60 мин.**
Вход: R020, R133. Результат: Persist sender/recipient/in_reply_to, content ref, native receipt; reply_to маршрутизируется сервером и проверяется авторизация.
Приёмка: B отвечает C после утраты transcript; повтор request_key не дублируется; подмена sender и конфликт target/reply_to отклонены до side effect.
Область: `crates/herder/src/application/correspondence.rs`.

**R135. Session context и чтение сообщений после компакции — 60 мин.**
Вход: R134, R136, R026. Результат: session(context/messages): self, creator, children, correspondents, paged inbox/outbox, peers, paths, conflicts, готовые следующие вызовы.
Приёмка: Без transcript доступны точные адреса и сообщения; bounded output имеет cursors и coverage; чтение не меняет состояние доставки.
Область: `crates/herder/src/application/session_context.rs`.

**R136. Участники проекта во всех рабочих деревьях — 60 мин.**
Вход: R029, R032, R133. Результат: project_ref объединяет подтверждённые checkout identities; snapshot показывает цели, scopes, worktree, host, freshness и недоступные источники.
Приёмка: Разные деревья одного проекта видны вместе; одинаковые basename чужих репозиториев не объединяются; offline не означает nobody.
Область: `crates/herder/src/application/project_context.rs`.

**R137. Атомарный claim общего checkout — 60 мин.**
Вход: R032, R136. Результат: Единый workspace authority, CAS claim/renew/release и fencing; конфликт с адресом владельца и инструкцией создать отдельный worktree.
Приёмка: Два одновременных claim дают одного победителя; partition не создаёт второго; TTL не объявляет живой процесс остановленным.
Область: `crates/herder/src/application/workspace_claim.rs`.

**R138. Карточка координации при старте и восстановлении контекста — 45 мин.**
Вход: R135, R106. Результат: Общий context projector и native bridge используют context generation; snapshot при новом контексте, bounded delta при изменениях; capability для unsupported hooks.
Приёмка: Неизменный fingerprint не подавляет snapshot после compaction; инъекция не снимает STOP и не запускает новый ход.
Область: `crates/herder/src/application/context_projection.rs`.

**R139. Курсор корреспонденции и восстановление подписок — 60 мин.**
Вход: R134, R015. Результат: Связать journal с MCP resources/subscriptions; resync cursor, retention/tombstone и различие persisted/injected/answered.
Приёмка: Разрыв подписки и рестарт не теряют адреса; удалённый по retention текст явно недоступен; resource read не пересылает UNKNOWN.
Область: `crates/herder/src/application/communication_events.rs`.

**R140. Native сценарий общения после компакции — 60 мин.**
Вход: R138, R139, R042, R054. Результат: На стенде A создаёт B, C пишет B; очистить model context, перезапустить Herder, восстановить адреса и ответить правильному отправителю.
Приёмка: Реальный клиент показывает A как создателя и отдельного C как отправителя; receipt подтверждает один ответ C; отсутствие native compact hook явно отражено.
Область: `tests/native/coordination_recovery/`.

**R141. Гонка checkout и неполная межнодовая видимость — 60 мин.**
Вход: R137, R103, R104. Результат: Детерминированная гонка двух claim, два instances, недоступная нода и real consumer отказ с переходом в отдельное дерево.
Приёмка: Один владелец checkout; loser получает исправимый вызов; scopes соседей видны; incomplete snapshot не утверждает одиночество.
Область: `tests/native/workspace_coordination/`.

## Каноническое файловое владение и работа без MCP

**R142. Адрес канонического storage и локальный manifest — 45 мин.**
Вход: R002. Результат: Typed storage_id/authority/root и schema; manifest/project marker с независимым local/SSH маршрутом, без секретов.
Приёмка: Отсутствующий owner в правильном storage отличается от неверного root/project, доступа и другой машины; manifest читается без MCP.
Область: `crates/herder/src/recovery/manifest.rs`.

**R143. Канонический JSON ownership и crash recovery — 60 мин.**
Вход: R142. Результат: File ownership library: стабильный OS-lock, owner/state, generation, prepared transitions, fsync/rename, request_key и reconcile.
Приёмка: Concurrent claim имеет одного победителя; kill на границах записи восстанавливается; ENOENT не обнуляет durable fence.
Область: `crates/herder/src/recovery/ownership.rs`.

**R144. Автономный herder-recovery CLI — 60 мин.**
Вход: R143. Результат: Отдельный небольшой binary: status/claim/renew/release/reconcile поверх той же библиотеки; local/SSH invocation и структурированные ошибки.
Приёмка: Работает при выключенных daemon/MCP и недоступной Herder DB; повтор claim с прежним request_key возвращает прежний исход.
Область: `crates/herder-recovery/`.

**R145. Release guard и общий ownership для MCP и CLI — 60 мин.**
Вход: R143, R137. Результат: workspace resource kind release/checkout; MCP читает тот же JSON. Release wrapper удерживает execution guard, проверяет fence/revision и читает receipt без MCP.
Приёмка: MCP и CLI не дают двух владельцев; живой release не перехватывается по TTL; stale fence/UNKNOWN не запускают повторный эффект.
Область: `crates/herder/src/application/release_guard.rs`.

**R146. JSON snapshot контекста для чтения без MCP — 45 мин.**
Вход: R135, R142. Результат: Атомарные scoped snapshots identity/creator/peers/workspaces/routes с freshness/revision/coverage и ACL; без credentials/закрытых сообщений.
Приёмка: После падения daemon доступны последние адреса и их давность; snapshot не выдаётся за canonical owner или receipt.
Область: `crates/herder/src/recovery/context_snapshot.rs`.

**R147. Recovery Skill и краткий locator в MCP — 45 мин.**
Вход: R016, R144, R146. Результат: Один исходник Skill и локального RECOVERY.md; подставленный locator в server/workspace/nodes descriptions и client bootstrap; версия/хеш.
Приёмка: Агент знает путь до первого MCP-вызова; при отключённом MCP находит инструкцию и корректный claim без чтения исходников.
Область: `skills/herder-recovery/`.

**R148. Приёмка при полностью выключенном Herder — 60 мин.**
Вход: R145, R147, R111, R124. Результат: Свежий агент выполняет тестовый release по файловому пути при выключенном daemon; одновременно MCP/CLI гонка и рестарт; receipt readback.
Приёмка: Ноль вопросов человеку о свободном владельце; один claim; восстановленный MCP видит файлового owner; fault cases не создают ложного владельца.
Область: `tests/native/recovery_storage/`.

**R149. Cutover владельцев и удаление старых fallback writers — 45 мин.**
Вход: R119, R144, R145. Результат: Одноразово перенести достоверное ownership в JSON при остановленных writers; retired Git/DB fallback paths отклоняют writes; import/rollback сохраняет fence.
Приёмка: После переключения один источник ownership; старый daemon/consumer не создаёт параллельного владельца; незавершённый release сверяется без replay.
Область: `release/ownership-cutover/`.

