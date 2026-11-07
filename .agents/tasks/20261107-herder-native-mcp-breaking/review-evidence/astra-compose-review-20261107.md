# Проверка композиции Astra — 07.11.2026 09:57 UTC

Проверены исходники кандидатов; независимый reviewer — существующий Nietzsche. Новые native/model вызовы не выполнялись.

## Остановка

`e3fdac67` получил REVISE: MCP stop сначала использовал неблокирующий resolve_session и при занятом handoff gate возвращал scope_unavailable/effect=none, не сохранив hold.

Дельта `dde52b0b` — SUPPORTED. stop_exact_session ожидает канонический gate, затем под ним проверяет точный node/instance, binding, authority generation и обязательные scopes и сохраняет hold. Импортированная mapping без scoped authority не принимается. После возможного handoff ответ требует interrupt/reconcile и не обещает подтверждённую отмену. Автор сохранил RED/GREEN wire regression; источник и независимый review не означают установленную consumer-проверку.

## Создание и первый prompt

`42e547c1` — REVISE для публичного fresh create. No-replay сценарии с заранее выданными grants поддержаны, но общий путь пока не работает для нового session ref.

Fixture grants() заранее даёт Write на Session("issued"), а Issuer всегда возвращает "issued". В production функции create_with_prompt исходный grants передаётся неизменным в deliver_scoped. При единственном instance-create grant новый ref создаётся и сохраняется, однако prompt получает Unauthorized до snapshot/send. Конкретная причина теряется в DeliveryUnknownOrBlocked.

Нужен явный переход доверенной policy: после проверенного create/binding выдавать exact session permission и загружать её также после recovery. Creator lineage сам по себе не является grant. Запрещено расширять permission до чужих sessions.

Регрессия: непредопределённый session ref, только instance grant; RED creates=1/sends=0. После policy перехода повтор исходного запроса: creates=1/sends=1. Следующий повтор не увеличивает счётчики. Доказанный отказ до отправки должен отличаться от UNKNOWN. Tesla получил адресную правку; Terra получила ограничение интеграции.

## OpenCode

`ba67c7ec` отклоняет Current до POST, поскольку native API не предоставляет атомарную проверку expected_turn; Queue сохранён. `395eb202` классифицирует невалидные request key/specification/parentID как DefinitelyNotSent. После возможного POST ответ остаётся Unknown. Source delta просмотрена Astra, автор сообщает 8/8 fixture tests. Реальный V065LIVE повторять не требуется и не разрешено повторным UNKNOWN recovery.

## Контроль исполнения

Проверены отдельно Terra, translator, resources, Codex, OpenCode, ZCode, browser, legacy CI и Tesla. Для OpenCode V066A получен явный отказ как outside intake, лист waiting; повторное сообщение не отправлено. Resources возобновлён на V033B, Tesla на COMPOSE/Tasks. ZCode V075A и browser V093B активны. Единственный следующий wake wait_1c84ce639ceae5e8029b19b7e73204eb подтверждён waiting на 2026-11-07T10:18:49.705Z; дубль не создан.

Публичное зеркало плана остаётся неподтверждённым после известного превышения лимита payload. Канонический локальный план пересобран, leaves согласованы. Это не утверждение о готовности продукта.

## Последующие адресные проверки, 10:03 UTC

`9ca0408c` общий transcript_index переиспользуется всеми adapters; текущий контракт page требует правки. update_session заменяет весь снимок, а одинаковый snapshot_id пропускается: вызов на первой local странице теряет последующие. Browser исправляет guard и контракт собранного snapshot; ZCode V075B должен собрать bounded batch и только затем вызвать общий feed один раз. Export lib.rs из browser commit применять только интегратором, без дублирования search module.

`e13487a6` ZCode transcript получил независимый REVISE: отсутствие native truncation flags не доказывает полноту при коротком batch; сохранять partial до подтверждённого provider signal. Источник row.info.content должен отличаться от row.content в source_field. Identity, локальная cursor/snapshot привязка и отсутствие выдуманного turn ref поддержаны source review. Synthetic fixture не является captured/live доказательством. ZCode получил обе адресные правки.

`a356fa44` settings получил REVISE Astra: ParsedSettingPatch.revision игнорируется, apply_patch принимает независимый expected_revision. Нужен один authoritative CAS revision либо отказ при несовпадении до save/apply. Worker также должен документировать сериализацию целевой настройки для всей последовательности save→native→mark в production порте. Авторские 6/6 fake tests не проверяли этот mismatch.

## Принятые дельты, 10:07 UTC

`3d99b1c1` — независимый SUPPORTED как source policy-port поверх 42e547c1. Nietzsche выполнил offline locked scoped_stop_gate create_prompt_: 3 passed, 0 failed. Policy вызывается после подтверждённого create/recovery, возвращённый grant проверяется по exact principal/session/Write. Чужой grant не принимается. После no-grant creates=1/sends=0, после exact grant тот же запрос creates=1/sends=1, повтор не увеличивает счётчики. UNKNOWN не становится no-send при отзыве права. Production policy/ingress ещё не доказаны. Diagnostic effect=none относится только к prompt, session уже создана; это важно для Tasks.

`0c3ce215` — source delta просмотра Astra принята: общий feed переименован index_transcript_snapshot и отклоняет next_cursor до записи, native truncated сохраняется. Полная сборка local batch остаётся обязанностью caller; ZCode делает её в V075B. lib.rs регистрацию переносит только Terra.

`f6317184` поверх a356fa44 — source delta просмотра Astra принята: отдельный expected_revision удалён, ParsedSettingPatch.revision единственная CAS версия; авторские 7/7 tests и RED сохранены. Production SettingsPort должен сериализовать весь цикл по target, реальная persistence/apply ещё не доказаны. Resources продолжает готовые V027A/B на существующем store.
