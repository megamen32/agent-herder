Граф задач: Agent Herder v1 — переиспользование и короткая очередь исполнения
Ревизия плана: ac3adb797632
Это снимок плана, а не панель управления: фактическое состояние работы приходит из API владельцев, а не из пересказа агента в графе.
Цель: Довести новый общий Agent Herder до установленного результата, переиспользуя старые adapters и готовые source/CI; сначала OpenCode, затем ChatGPT и Z.ai, после них ZCode и последним Codex.
Бизнес-результат: 14 общих инструментов, один Rust core/authority/Task lifecycle, языконезависимый AHAP с reuse старых adapters; удаляемый translator; durable context и offline ресурсы; direct CDP; сохранение данных и installed acceptance пяти сред.
Как проверим: Один immutable v1 candidate: Codex/OpenCode/ZCode/ChatGPT/Z.ai native lanes; реальные consumers; два Codex/OpenCode/browser profiles и две ноды; creator/sender после compaction; UNKNOWN no replay и HumanStop; offline claim/release receipt при выключенном MCP; migration/legacy removal; Linux/macOS installed acceptance. Остальные adapters не входят в v1.
Декомпозиция: 578 листьев · 10 параллельно · 21 волна · слотов: 10
Прогресс (по листьям графа): 200/578 готово (34.6%) · в работе 1 · заблокировано 7 · ждёт листа 5 · ждёт исполнителя 2 · осталось 36
Кандидаты по зависимостям и вместимости: V017, V027
Подтверждённый допуск к запуску: нет
Смета плана: $7.18 (provisional) за 137 из 578 листьев
frontier $7.18 (provisional) — 100.0% всех долларов плана
остатку к запуску $1.86 (provisional)
бюджет не задан
без цены 99: CTRLWAKE, FASTINIT, FASTOCABI, QBROWSERJOIN, QCODEXJOIN, QDEPENDENCYWAKE, QDESIGN, QLHCCONTINUE, QLHCNATIVEOBS, QLHCREVIEW, QPLAN, QQUOTARECEIPT, QZCODEJOIN, V001, V010A3, V010AUTH1, V010BIND1, V010HTTP2, V010HTTP3, V010HTTPAUTH1, V010ISSUER1, V010READ1, V025GATE1, V025GUARD1, V063C, V065AHAP, V072RUNNER-GROUP, V079C, V081AHAP, V081CDPBASE, V089TEXT, FASTCORE22, FASTOC22, QAHAPPORT, QBROWSERSCOPE, QCONTROLINSTALL, QLHCINSTALLED, QOCJOIN, QZAICASE, V002, V004, V025CREATETASK, V025LAUNCH, V025PROMPT, V025TASKRECON, V079D, V081CDPDOM, V088C, QAHAPLAUNCH, QMACREUSE, QOCPREFLIGHT, QOCPROBEJSON, QZRECEIPT, V003, V005, V025CREATEINPUT, QOCREGRESSION, QOCTYPEJOIN, QZAIFACTORY, V006, V008, I001, V007, V011A, F001, QOCEXPORT, V011B, QOCV1CI, V011, V031C, R003A, V010A1, V064PORT, V073PORT, V030MIG, V040BCONSUMER, V064LIVE, V065PORT, QBROWSERCLAIM, V055C, V065LIVE, V075FEED, QCHATCASE, V055D, V072C, V090SCOPE, V055A1, V072D, V072RUNNER, V055A2, V072E, V055A3, V055PIPE, V055BOUND, V025PORT, V055CREATE, V055STOP, V025OWNER, V025READHOLD
снимок b3044531c367 от 2026-11-07T18:27:29Z · возраст 4 ч 49 мин · скорость токенов: frontier provisional
Листьев в графе: 578 · слотов: 10 · волн: 21
Параллельность: сейчас 1 из 10 слотов, пик по плану 10
Исполнители: занято 1 из 10 слотов · ждёт листа: 5 (T004, T005, T010, V044B, …) · ждёт исполнителя: 2 (T003, V031C) · готово к запуску: 2 (V017, V027)
Прогноз: известная активная часть 1 ч 30 мин (от 1 ч), финиш неизвестен из-за внешнего ожидания. отсчёт от последнего события 2026-11-08T02:16+03:00 · простой 0 мин · неточно: срок внешнего ожидания не подтверждён
Критический путь: Закрепить SDK и собрать минимальный wire probe → Конфигурация Node и HarnessInstance → Типы адресов и capabilities → Привязать caller и области доступа → Описать storage authority и global, project, node scope → Проверять независимый resource marker и разрешённый offline маршрут → Отличить отсутствие owner от wrong root, mount loss и EACCES → Создать стабильный guard и атомарный claim с nonce → Выполнять renew и release с проверкой текущего claim_id → Проверить гонку MCP и CLI с одним победителем → Добавить offline status и claim через общую библиотеку → Добавить renew и release без daemon и SQLite → Прочитать потерянный результат по nonce без повторного занятия → Взять execution lock конкретной цели перед проверкой owner → Проверить текущий claim и deployed revision под lock → Отклонить старого владельца и второй маршрут runner → Записать request_key и durable receipt до spawn → Передать удержание execution lock процессу изменения → Проверить смерть родителя и UNKNOWN без повторного запуска → Воспроизвести смену owner во время принятого release → Отклонить задержанный запрос прежнего владельца → Подтвердить максимум один эффект и сверку UNKNOWN
Блокеры:
  - Почему ждём: Self-test wait_51988f58b1ae0c2991bea8f245b9743a immediately delivery_failed: exact turn captured but native completion unavailable/idle. QLHCNATIVEOBS + installed readback required.
    Кто делает: Astra
    Следующий шаг: Прямой запрос владельца проверить на Astra выполнен как живой RED. Herder73e7 и LHC1.17.1 installed; failedwait не повторяется. Hourlywait_dc371... waiting18:31UTC; duplicate schedule не создавался. EvidenceQLHCCONTINUE/self-wake-failed.json.
    Нужен ли человек: Пока неизвестно. Действие человека не уточнено.
  - Почему ждём: Нет делегированного изолированного ChatGPT test profile; доступный Chrome относится к обычному профилю владельца.
    Кто делает: roomhacker
    Следующий шаг: V079D live ChatGPT attach/read не выполнен ради сохранения ChatGPT stop и пользовательского профиля. Scoped source implementation in commit 8beedf96573cc6f32c3837130b748bdb34c03d0f; общий post-navigation fix in c22780f1315c4e75556d271964cf02007687ed13. V088C завершён на собственном Z.ai target.
    Нужен ли человек: Пока неизвестно. Действие человека не уточнено.
  - Почему ждём: Возобновление Terra отклонено codex_quota_guard:quota_unknown; tool result admissionUnknown/nonRetryable.
    Кто делает: Terra
    Следующий шаг: Прочитан durable receipt ~/.local/state/agent-herder/codex-delivery-receipts.json.buckets/de.json по точному SHA256(thread+NUL+inputId): сохранён UNKNOWN с CodexQuotaBlockedError до отправки. QQUOTARECEIPT исправляет классификацию будущих отказов; старый receipt не изменяется/не replay. Terra остаётся idle, guard не обходить.
    Нужен ли человек: Пока неизвестно. Действие человека не уточнено.
  - Почему ждём: Task returned structured outcome_unknown/retry=forbidden. Exact create request may not be replayed.
    Кто делает: roomhacker
    Следующий шаг: Diagnose the pinned adapter's create route without mutation, publish a reviewed corrected artifact, then request/obtain a separately authorized fresh case.
    Нужен ли человек: Пока неизвестно. Действие человека не уточнено.
  - Почему ждём: Полный FTS scan при update; схема и production ingestion требуют интеграции
    Кто делает: Tesla
    Следующий шаг: Индексируемая связь canonical session→FTS rowid со schema/version fence у Terra, затем production feed и consumer proof.
    Нужен ли человек: Пока неизвестно. Действие человека не уточнено.
  - Почему ждём: The isolated native session writer subprocess timed out after a mutation sequence began; exact accepted state is unknown and the temporary server/session receipt was not captured.
    Кто делает: roomhacker
    Следующий шаг: Следующий шаг не указан.
    Нужен ли человек: Пока неизвестно. Действие человека не уточнено.
  - Почему ждём: V072D produced no recoverable native session IDs, and its mutation outcome is UNKNOWN; the independent Rust read cannot target a specific session without those IDs.
    Кто делает: roomhacker
    Следующий шаг: Следующий шаг не указан.
    Нужен ли человек: Пока неизвестно. Действие человека не уточнено.
Листья плана (578):
  - CTRLWAKE · ✅ Готово · (Восстановить регистрацию единственного часового пробуждения Astra) · оценка 15 мин · усилие 20 мин по часам · по часам 20 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Узкий legacy-runtime blocker контроля: нерелевантные token events и повторные timer sweep накапливают дорогие native probes в serial queue. Source fix без смены lifecycle и без replay зарегистрированного UNKNOWN.
      Приёмка: Быстрый RED/GREEN доказывает отсутствие очереди из нерелевантных событий и коалесцирование timer sweeps; HumanStop, exact dependency and UNKNOWN tests pass. Source publication и runtime installation/readback существующего requestId отдельно; duplicate scheduler не создавать.
      Затрагиваемые файлы: `src/resume-after.ts`, `tests/resume-after.test.ts`
      Результат: Source6195e46b/mainb00c778d: event filter+coalesced sweep, RED43vs3/33vs1, GREEN66 tests. Legacy CI installed release bafb71f5 on live agent-herder.service PID2954443, old PID982842 absent; installed JS inspected for both fixes. Full own-wait registry only two historical resumed, exact current absent. Same original requestId retry accepted and separately status-read back waiting: wait_1c84ce639ceae5e8029b19b7e73204eb scheduled2026-11-07T10:18:49.705Z. Exactly one pending next wake; no second scheduler. Evidence review-evidence/astra-resume-queue/runtime-readback.json. Actual future delivery not yet due.
  - D001 · ✅ Готово · (Перестроить зависимости и детализировать очередь до 15 минут) · оценка 10 мин–15 мин · усилие 9 мин по часам · по часам 9 мин · волна 1 · зависит: — · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Пересмотреть будущие V-листья без изменения выполненных и назначенных работ; выделить конкретные шаги и ранний native результат.
      Приёмка: Карта старый V → новые шаги сохраняет исходные обязательства; все новые исполнимые листья <=15 минут, DAG без ложных зависимостей.
      Затрагиваемые файлы: `/home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-herder-native-mcp-breaking/leaves`, `/home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-herder-native-mcp-breaking/WORKPLAN.md`, `/home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-herder-native-mcp-breaking/ESTIMATES.md`
      Результат: 150 будущих V-задач разбиты на конкретные шаги; 316 новых записей включая этапы/ресурсы/ранние поставки созданы каноническим CLI. check: листья согласованы. Исходная история сохранена history/15m-revision/before.json; done и V003/V007/V011 не изменялись. Документы ресурсов и публикация ещё впереди.
  - E003 · ⌛ Ожидание · (Выпустить ресурсы и offline CLI на изолированном стенде) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Нет полного пакета доказательств AC07 AC08 AC09 AC10 AC11. Обязательство не отложено и не выполнено; будущие интеграционные шаги раскрываются по готовности входов. · волна 1 · зависит: — · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Обязательный незавершённый этап S02; точные критерии AC07 AC08 AC09 AC10 AC11 в ACCEPTANCE-COVERAGE.json. Эта карточка только принимает готовый пакет результатов этапа. Перед реализацией его остаток раскрывается в owned шагах ≤15мин по уже существующим source/evidence. Не исполнять старую deferred декомпозицию и не считать source-only полным результатом.
      Приёмка: Установить dev артефакт и local manifest; при выключенном тестовом MCP прочитать и занять зарегистрированный глобальный ресурс, затем сверить owner через MCP.
      Затрагиваемые файлы: `release/dev-resources/`
      Сохранённый статус: waiting
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:08:26+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b2b2-5685-7b52-a2bb-05eb931cafa4
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; внешнее ожидание (external_waiting)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - E004 · ⌛ Ожидание · (Выпустить расписание и автопилот на тестовой сессии) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Нет полного пакета доказательств AC13. Обязательство не отложено и не выполнено; будущие интеграционные шаги раскрываются по готовности входов. · волна 1 · зависит: — · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Обязательный незавершённый этап S03; точные критерии AC13 в ACCEPTANCE-COVERAGE.json. Эта карточка только принимает готовый пакет результатов этапа. Перед реализацией его остаток раскрывается в owned шагах ≤15мин по уже существующим source/evidence. Не исполнять старую deferred декомпозицию и не считать source-only полным результатом.
      Приёмка: Установить dev артефакт; один schedule и один autopilot проходят общий admission, HumanStop прекращает новые ходы.
      Затрагиваемые файлы: `release/dev-automation/`
      Сохранённый статус: waiting
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:08:30+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b2b2-5685-7b52-a2bb-05eb931cafa4
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; внешнее ожидание (external_waiting)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - E005 · ⌛ Ожидание · (Выпустить CLI и Web UI с проверенными несколькими instance) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Нет полного пакета доказательств AC04 AC05 AC06 AC12. Обязательство не отложено и не выполнено; будущие интеграционные шаги раскрываются по готовности входов. · волна 1 · зависит: — · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Обязательный незавершённый этап S08; точные критерии AC04 AC05 AC06 AC12 в ACCEPTANCE-COVERAGE.json. Эта карточка только принимает готовый пакет результатов этапа. Перед реализацией его остаток раскрывается в owned шагах ≤15мин по уже существующим source/evidence. Не исполнять старую deferred декомпозицию и не считать source-only полным результатом.
      Приёмка: Установить dev artifact. Через обычный UI после reload видны user/assistant и разные instance; сохранены уже полученные проверки изоляции.
      Затрагиваемые файлы: `release/dev-consumers/`
      Сохранённый статус: waiting
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:08:36+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b2b2-5685-7b52-a2bb-05eb931cafa4
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; внешнее ожидание (external_waiting)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - E006 · ⌛ Ожидание · (Выпустить обновлённые consumer маршруты и Skills) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Нет полного пакета доказательств AC15. Обязательство не отложено и не выполнено; будущие интеграционные шаги раскрываются по готовности входов. · волна 1 · зависит: — · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Обязательный незавершённый этап S09; точные критерии AC15 в ACCEPTANCE-COVERAGE.json. Эта карточка только принимает готовый пакет результатов этапа. Перед реализацией его остаток раскрывается в owned шагах ≤15мин по уже существующим source/evidence. Не исполнять старую deferred декомпозицию и не считать source-only полным результатом.
      Приёмка: Активировать проверенные consumer версии в их разрешённом тестовом маршруте; сверить API digest и одну доступную навигацию. Без повторения внешних отправок.
      Затрагиваемые файлы: `release/dev-integrations/`
      Сохранённый статус: waiting
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:08:37+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b2b2-5685-7b52-a2bb-05eb931cafa4
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; внешнее ожидание (external_waiting)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - E007 · ⌛ Ожидание · (Выпустить importer и rollback на восстановленном снимке) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Нет полного пакета доказательств AC16. Обязательство не отложено и не выполнено; будущие интеграционные шаги раскрываются по готовности входов. · волна 1 · зависит: — · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Обязательный незавершённый этап S10; точные критерии AC16 в ACCEPTANCE-COVERAGE.json. Эта карточка только принимает готовый пакет результатов этапа. Перед реализацией его остаток раскрывается в owned шагах ≤15мин по уже существующим source/evidence. Не исполнять старую deferred декомпозицию и не считать source-only полным результатом.
      Приёмка: Установить candidate на изолированный импортированный state, прочитать holds, lineage и UNKNOWN без native send.
      Затрагиваемые файлы: `release/dev-migration/`
      Сохранённый статус: waiting
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:08:38+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b2b2-5685-7b52-a2bb-05eb931cafa4
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; внешнее ожидание (external_waiting)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - E008 · ⌛ Ожидание · (Опубликовать проверенные платформенные dev артефакты) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Нет полного пакета доказательств AC17. Обязательство не отложено и не выполнено; будущие интеграционные шаги раскрываются по готовности входов. · волна 1 · зависит: — · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Обязательный незавершённый этап S11; точные критерии AC17 в ACCEPTANCE-COVERAGE.json. Эта карточка только принимает готовый пакет результатов этапа. Перед реализацией его остаток раскрывается в owned шагах ≤15мин по уже существующим source/evidence. Не исполнять старую deferred декомпозицию и не считать source-only полным результатом.
      Приёмка: Сохранить четыре manifest и места загрузки проверенных артефактов; не считать cross compile доказательством native запуска.
      Затрагиваемые файлы: `release/dev-artifacts/`
      Сохранённый статус: waiting
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:08:40+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b2b2-5685-7b52-a2bb-05eb931cafa4
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; внешнее ожидание (external_waiting)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - E009 · ⌛ Ожидание · (Опубликовать финальный RC с единым manifest) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Нет полного пакета доказательств AC01 AC18. Обязательство не отложено и не выполнено; будущие интеграционные шаги раскрываются по готовности входов. · волна 1 · зависит: — · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Обязательный незавершённый этап S12; точные критерии AC01 AC18 в ACCEPTANCE-COVERAGE.json. Эта карточка только принимает готовый пакет результатов этапа. Перед реализацией его остаток раскрывается в owned шагах ≤15мин по уже существующим source/evidence. Не исполнять старую deferred декомпозицию и не считать source-only полным результатом.
      Приёмка: Опубликовать именно проверенный неизменный RC и сопоставить digest с native и consumer доказательствами; production cutover отдельно.
      Затрагиваемые файлы: `release/rc-publication/`
      Сохранённый статус: waiting
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:08:41+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b2b2-5685-7b52-a2bb-05eb931cafa4
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; внешнее ожидание (external_waiting)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - FASTINIT · ✅ Готово · (Исправить отказ protected profile до первой native мутации) · оценка 5 мин–15 мин · усилие не измерено · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Вход Luna retained v9: FAILED_PREMUTATION invalid/untrustedprofile, modelcounter0, api_family=api-session. Проверить в namespace uid/mode/canonical ancestors executable/script/profile. Node hostroot может быть unmapped65534; использовать owner-owned readonly artifact, не ослаблять guard. Сохранить GET /api/config и /config shape/status того же binarydigest, устранить противоречие source-only protocol assumption.
      Приёмка: Тот же core initialize проходит на защищённых путях; preflight отчёт с exact binary/route и modelcounter0. Только готовый source/stand reuse, no create/send. Новый native case отдельно V065AHAPCIRUN.
      Затрагиваемые файлы: `tests/native/ahap_opencode_stand.py`, `tests/native/test_ahap_opencode_stand.py`
      Результат: Опубликовано ca4c3907 + stand70fba336. Actual retained preflight PREFLIGHT_READY/tools/list, namespace euid0/Node+ancestors uid0, model_requests0/native_mutations0; exact probe statuses/shapes и binary SHA в /home/roomhacker/herder-artifacts/evidence/ahap-stand-20261107/preflight-receipt-final.log. API family label не доказывает session/message совместимость; native case отдельно.
  - FASTOCABI · ✅ Готово · (Сопоставить готовый adapter с API OpenCode 2.2.4 до первой отправки) · оценка 5 мин–15 мин · усилие не измерено · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Вход: main94e7d98c runner pinv2→/api, artifact OpenCode2.2.4; existing opencode_receipt.py поддерживает /session. Использовать готовую ветку старого TS client для API конкретного binary. Read-only preflight выбирает единственный pinned route до create; никаких POST fallback/retries.
      Приёмка: Точные create/send/read методы и IDs существующего client для2.2.4; минимальная runner delta и offline fixture либо точный недостающий seam. Native case только Luna.
      Затрагиваемые файлы: `packages/agent-resume/src/harness/opencode/client.ts`, `tests/native/opencode_receipt.py`, `tests/opencode-v2-protocol.test.ts`
      Результат: OpenCode owner+Terra source verified: 94e7 runner v2 uses /api, 2.2.4 requires /session and /message payload modelID+parts; v1 prompt_async is also incompatible. Existing opencode_receipt.py is working request/readback reference. No native send; old artifact incompatible, native case held until explicit patch.
  - QBROWSERJOIN · ✅ Готово · (Принять готовую direct-CDP delta без нового transport) · оценка 10 мин–15 мин · усилие 2 мин по часам · по часам 2 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Готовые ed1acd95/429d39b0/385efc83/d0a71185/76bd8325, source42tests. Одна delta-review account scope/UNKNOWN, согласовать пересечение site-driver с CI, включить точные patches. No browser send.
      Приёмка: Review замечания устранены или конкретно зарегистрированы, точная source цепочка опубликована; native case отдельно.
      Результат: Точная direct-CDP цепочка и handshake fix 9c0c34f3 опубликованы и входят в origin/main c65715df; build:core, tsc и 43 focused tests прошли. Account/UNKNOWN source review: mutation проверяет pinned account, timeout/disconnect UNKNOWN; обнаружен и зарегистрирован B720e95cbcdcd484ab0f8 — read может вернуть данные после смены account, исправить до browser acceptance. CI site-driver overlap проверен, чужой WIP сохранён. Evidence evidence/QBROWSERJOIN/source-review-20261107.md; native browser не запускался.
  - QCODEXJOIN · ⌛ Ожидание · (Подключить рабочий Codex adapter через AHAP) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Приоритет OpenCode: V065AHAPCIRUN выявил UNKNOWN/HTTP405 и reopen QOCJOIN; Codex source после исправления OpenCode. Installed CI не имеет доказанного instance/provider selection; не создавать новый thread и не менять рабочий provider. · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Вход CI L100/L74, старый Codex adapter, не fork клиента. Только bounded composition через AHAP с exact identity/no replay. Codex native приёмка последняя; прежние отказавшие workers не будить.
      Приёмка: Source composition опубликован с focused proof; native кейс отдельноV060, установленный consumer отдельно.
      Сохранённый статус: waiting
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T19:25:50+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b341-e06b-7583-8fd4-352423ca22cb
      Плановая модель: неизвестно
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; внешнее ожидание (external_waiting)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - QDEPENDENCYWAKE · ✅ Готово · (Исправить наблюдение активного native turn для пробуждения родителя) · оценка 15 мин · усилие не измерено · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Существующий dependencywait ошибочно delivery_failed приactive exactnative Codexturn; использовать существующее active/terminal observation безновогоscheduler. Сначала source/runtime parity и RED test, guard/HumanStop/UNKNOWN не менять.
      Приёмка: Активный exactturn остаётсяwaiting; нужный terminal одинразвозобновляетparent, другойturn/idle безevidence неdone; недоступность неfakecomplete. RED/GREEN+scoped source main. Еслиsourcealreadyfixed определить exactmissing installedrevision, бездублякода/самостоятельногоdeploy.
      Затрагиваемые файлы: `src/resume-after.ts`, `src/resume-after-runtime.ts`, `tests/resume-after.test.ts`, `tests/resume-after-production-wiring.test.ts`
      Результат: Проверено на source, без изменений установленного runtime: актуальный source до фикса ошибочно не считал nativeLastTurn.status=inProgress активностью при session.status=idle, из-за чего exact turnId приводил к delivery_failed с idle-not-completion. RED: npx vitest run --root . --config vitest.config.ts tests/resume-after.test.ts -t 'exact native inProgress dependency' упал: expected waiting, received delivery_failed. Минимальный фикс в createResumeAfterRuntime учитывает nativeLastTurn inProgress/running как busy и сохраняет точный turnId; тест доказывает waiting до соответствующего turn.completed, затем ровно одну доставку даже при duplicate terminal event. Уже существующие проверки сохраняют idle-without-completion и mismatched/newer turn guards. GREEN: tests/resume-after.test.ts tests/resume-after-mcp.test.ts tests/resume-after-production-wiring.test.ts — 67/67 passed; npx tsc --noEmit и git diff --check passed. Scoped source commit dc9d8821..73e7aac6, final commit 73e7aac61431d97f3d172175a69385d7e96538bd (rebased over current origin/main), only src/resume-after-runtime.ts and tests/resume-after.test.ts; remote main readback matches. No real resume, no HumanStop/quota bypass, no runtime install/change.
  - QDESIGN · ✅ Готово · (Спроектировать тихий сбор прогресса из плана) · оценка 10 мин–15 мин · усилие 9 мин по часам · по часам 9 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Переиспользовать LHC leaf/progress_events. Worker writes canonical leaf; lead pulls bounded changed digest through Context Mode; only decision-required messages. Определить freshness/cursors/UNKNOWN/restart и минимальную реализацию без второго task store.
      Приёмка: Конкретный контракт записи/чтения, отказов и критичных уведомлений с минимальными изменениями в LHC/Herder; независимый критик проверил и замечания устранены.
      Результат: QUIET-COORDINATION.md + independent QUIET-CRITIQUE.md опубликованы main99d2f29a. После5поправок критикSUPPORTED(design). Проверен canonical writer/read, fields.note==progress_events.note; evidence/quiet-canonical-read.json. Existing quiet assignments переданы четырём сессиям с accepted receipts. Нового runtime digest/message filter/Context Mode execute нет; implementation и inactive-wake proof не заявляются.
  - QLHCCONTINUE · ✅ Готово · (Исправить и установить LHC completion wait и delivery timeout) · оценка 15 мин · усилие 22 мин по часам · по часам 22 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Прямое поручение владельца 07.11: доделать LHC child completion→parent continuation. Переиспользовать LHC1.17 assign/dispatch/reconcile и Herder resume_after; Aquinas проверяет минимальный разрыв в hooks, Astra live consumer и интеграцию. Отдельный scheduler не вводить.
      Приёмка: RED/GREEN, независимый review, опубликованный LHC1.17.1, actual installed hash/readback. Native parent continuation выделен в QLHCINSTALLED и не считается доказанным этим листом.
      Затрагиваемые файлы: `LastHumanCommit/src/common/tools/lhc_execution.py`, `LastHumanCommit/src/common/tools/lhc_entry.py`, `LastHumanCommit/tests`
      Результат: LHC1.17.1 publishedmain2988f0f8483a2a33a6fb762c86e597513b445d1a и installed штатнымwrapper с сохранением oldhookroutes. Исправлены staleidle/nativeinProgress потеряwake и слишкомкороткийHTTPdeliver timeout10→60s; reads10s, no retries. SourceRED3→GREEN11; transportRED2→GREEN6; independentreviewsPASS. Fullvalidation1045passed6skipped; generatedpackageparityPASS. Installed execution/transport/entry hashes match; old1.17.0expandedhookcommand запускается черезcanonicalcompatroute. Реальныйparentwake остаётся непринятым в QLHCINSTALLED; нужен QLHCNATIVEOBS readcontract. EvidenceQLHCCONTINUE, docs/parent-continuation-1.17.1.md.
  - QLHCNATIVEOBS · ✅ Готово · (Сохранить точный native turn в ответе Herder для LHC) · оценка 15 мин · усилие 1 ч 25 мин по часам · по часам 1 ч 25 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Live на установленном73e7aac6 session_info активнойCodexсессии отдаётidle/meta.sourceRoute безnativeLastTurn. Appwait подтверждаетexactinProgress. Найтипотерюnativeobservation, reuseexistingadapter.
      Приёмка: SourceRED/GREEN и реальныйsession_info содержатточныйturn/status, staleidle не заменяетactive; HumanStopсохранён. RuntimeinstallerCI.
      Результат: Source fix for observed native turn loss published to origin/main as 8495e1b72434acc119e926e764a59afb3dc0d934. Shared readExactCodexActiveSession now feeds both public agentInfoResult and resume_after readDependency. Fallback applies only to exact Codex idle with no current turn identity/permission/HumanStop/automation hold; holds checked before and after read; stopped, approval, conflicting metadata and mismatched active receipt remain unchanged. Tests: `npx vitest run tests/session-info-context.test.ts tests/codex-app-server.test.ts tests/resume-after.test.ts` — 3 files, 104 passed; `npx tsc --noEmit` passed; `git diff --check` passed. No runtime install and no live wait/send.
  - QLHCREVIEW · ⋯ В очереди · (Независимая проверка LHC продолжения на живой сессии) · оценка 15 мин · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Проверить scoped LHC fix и доказать реальную dispatch→childcompletion→parentwake цепочку. Выдача исключительно новым assign/dispatch без исторических фиктивныхattempts; readyрезультат требует ручной acceptance Astra.
      Приёмка: Readonly независимый review минимальногоfix; точные native dispatch/wake receipts, без UNKNOWN replay илиHumanStop bypass.
      Затрагиваемые файлы: `LastHumanCommit/tests/test_lhc_execution.py`
      Сохранённый статус: queued
      Назначение: result_ready; тип=subagent; attempt=astra-lhc-native-review-20261107T1807
      Автор последнего события: host_id=roomhacker-server-100 · harness=codex · session_id=01a1b2b2-5685-7b52-a2bb-05eb931cafa4; source=declared; at=2026-11-07T18:24:06+00:00
      Lead (заявлен): host_id=roomhacker-server-100 · harness=codex · session_id=01a1b2b2-5685-7b52-a2bb-05eb931cafa4
      Native parent (заявлен): host_id=roomhacker-server-100 · harness=codex · session_id=01a1b2b2-5685-7b52-a2bb-05eb931cafa4
      Исполнитель (заявлен): host_id=roomhacker-server-100 · harness=codex · session_id=01a1b693-0f8b-71e1-82ac-9d2d215239d1
      Прежняя привязка leaf.session: host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Плановая модель: неизвестно
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: completed; source=codex_app.wait_threads; at=2026-11-07T18:09:22+00:00
      Turn назначения: 01a1b732-02d8-7923-99eb-854b79210939; request=lhc:90036582c69052848182fd14f10b6854279ec6cc8e0c239d9169da25ac419962; delivery=accepted
      Наблюдаемый turn: 01a1b732-02d8-7923-99eb-854b79210939; worktree=/home/roomhacker/.codex/worktrees/herder-v1-implementation/agent-herder
      Пробуждение Lead: blocked; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; assignment_result_ready
      Незавершённые зависимости: нет
      Причина ожидания / доставки: wake: native_turn_mismatch
  - QPLAN · ✅ Готово · (Согласовать два плана вокруг пяти адаптеров) · оценка 10 мин–15 мин · усилие 15 мин по часам · по часам 15 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Прямой запрос владельца: использовать текущие результаты Herder и deterministic CI; зафиксировать раздельные owners и общую проверку пяти адаптеров без повторной реализации. Источники FAST-PATH, CI leaves/receipts, текущие session results.
      Приёмка: Два канонических плана содержат общий порядок, ближайшие executable leaves <=15мин и ссылки на переиспользуемые результаты; независимые работы не ждут unrelated adapter.
      Результат: Два канонических плана согласованы для5адаптеров; JOINT-EXECUTION.md обоих планов + FIVE-ADAPTER-ACCEPTANCE.json опубликованы main99d2f29a. Устаревшие running исправлены по receipts; FASTINIT/driver реально готовы, QOCJOIN у Теры running. CI L102/L103 не дублируются; CIGATE/installed этапы добавлены. Это план/назначения, не готовые5адаптеров.
  - QQUOTARECEIPT · ✅ Готово · (Сохранить точный отказ до отправки Codex turn/start) · оценка 15 мин · усилие 4 мин по часам · по часам 4 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: sendNativeMessage outercatch misclassifies CodexQuotaBlockedError as admissionUnknown. Reuse quotaRefusal; preserve guard and no replay old receipts.
      Приёмка: RED regression public sendMessage+receipt lookup; GREEN known notSubmitted flags, zero turn writes, true transportUNKNOWN remainsUNKNOWN; focused suite and scoped main publish. Runtime rollout separately owned.
      Затрагиваемые файлы: `src/adapters/codex-app-server.ts`, `tests/codex-quota-guard.test.ts`
      Результат: Published origin/main ffb714b52ef9afeef4dcd7be5b54c9d602dbd2fc; remote readback verified. Moved quotaRefusal to actual turn/start catch; removed misplaced post-admission handler. RED1failure, GREEN41tests, tsc exit0, scoped2paths. Evidence/QQUOTARECEIPT/{red,green,typecheck}.txt. Source complete; running daemon unchanged, old UNKNOWN receipt preserved; runtime installation remains separate.
  - QZCODEJOIN · ✅ Готово · (Подключить рабочий ZCode adapter из старого CI) · оценка 10 мин–15 мин · усилие 6 мин по часам · по часам 6 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Вход CI L45 dcb01f5e реальный ZCode3.17.2; использовать готовый adapter/native driver через AHAP, без повторного writer V072D UNKNOWN. Первая задача только bounded composition, native case отдельно V078.
      Приёмка: Один опубликованный source composition + focused contract, точный argv/evidence manifest; native acceptance не заявлен.
      Результат: Опубликован source composition commit 4cc4cd85093f22e2926dc44fae39e8458b1c3e04 на origin/main. Owned paths only: src/ahap-zcode-runner.ts, tests/ahap-zcode-runner.test.ts, acceptance/native/zcode/ahap-contract.json. Проверки на чистой базе после npm ci и npm run build:core: `./node_modules/.bin/vitest run --root . --config vitest.config.ts tests/ahap-zcode-runner.test.ts` — 4/4 passed; `./node_modules/.bin/tsc --noEmit --pretty false` — exit 0; `git diff --cached --check` — passed. Manifest argv: ["$AHAP_ZCODE_SERVER_NODE", "$AHAP_ZCODE_SERVER_ENTRY"], cwd=$AHAP_ZCODE_CWD; required env AHAP_VERSION=0.1, AHAP_HARNESS=zcode and the three absolute AHAP_ZCODE_* paths. Reuses existing ZcodeAdapter/native driver; ambiguous mutation UNKNOWN, no retry. Native case NOT RUN, remains V078; V072D/E UNKNOWN were not replayed. Foreign WIP in shared Luna checkout and other ZCode worktrees preserved.
  - T001 · ✅ Готово · (Закрепить schemas и границу удаляемого translator) · оценка 10 мин–15 мин · усилие 41 мин по часам · по часам 41 мин · волна 1 · зависит: — · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Реализовать только этот проверяемый шаг по COMPATIBILITY.md. Входы: . При неизвестном SDK/consumer маршруте сначала назвать минимальный пробел; не форкать Codex.
      Приёмка: Native каталог14 и отдельные compat_task/skill/changes; схемы/ошибки и exact caller contract согласованы с COMPATIBILITY.md.
      Затрагиваемые файлы: `crates/herder-compat/`, `acceptance/compat/`
      Результат: Создан отдельный crates/herder-compat и acceptance/compat: строгие compat_task/skill/changes DTO с отказом от произвольного execute/kwargs; generic proxy получает инструменты через upstream tools/list, без локального каталога; три helper публикуются только при соответствующих upstream capability. Зафиксированы версии 2025-06-18 downstream и 2026-07-28 upstream, безопасный diagnostic DTO и точная caller boundary в README. cargo check и contract test пройдены. Проверенная caller identity отсутствует в core и остаётся T003; текущий native endpoint Caller::Unknown.
  - V001 · ✅ Готово · (Закрепить SDK и собрать минимальный wire probe) · оценка 30 мин–45 мин · усилие 42 мин по часам · по часам 42 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Cargo.lock/toolchain и probe server/discover → tools/call на rmcp 3.9.0.
      Приёмка: Записаны версии/feature flags; процесс запускается и отдаёт обязательный resultType. Если compile не проходит, точный минимальный failure и пересмотр до адаптеров.
      Затрагиваемые файлы: `crates/herder/Cargo.toml`
      Результат: rmcp 3.9.0 и Rust 1.96.1 закреплены; отдельный stdio процесс прошёл server/discover и tools/call с resultType=complete. Код опубликован origin/main 213ad40d5e432f1e4a8432ea3d1eb174d4dc08af; запись review-evidence/v001-wire-probe.jsonl. Tasks, Skills, subscriptions, native client и persistence не проверены.
  - V010A3 · ✅ Готово · (Подключить один native read handler с target ACL) · оценка 10 мин–15 мин · усилие 15 мин по часам · по часам 15 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Соединить application с существующим native reader на изолированном instance, с точным ACL; не выдавать внедрённого principal за launcher proof.
      Приёмка: Разрешённое чтение реального изолированного instance, отказ чужому target до эффекта; явно указать ограничения issuer.
      Затрагиваемые файлы: `crates/herder/src/application/`, `crates/herder/src/mcp/transport.rs`
      Результат: 84de5fc7: session/recent через application и настоящий OpenCode reader на изолированном OpenCode 2.2.4; ACL, чужой ref и instance проверены; пустая тестовая история. Идентичность инъецирована, production resolver и launcher не доказаны.
  - V010AUTH1 · ✅ Готово · (Разделить target ACL и self binding в core) · оценка 15 мин · усилие 4 мин по часам · по часам 4 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Внешний verified principal может читать разрешённый target без self; self-зависимые операции отказывают при отсутствующем или неверном binding.
      Приёмка: Два principal, точные target grants, отсутствие и подмена self проверены, изоляция контекстов; локальный commit без Cargo/lib.
      Затрагиваемые файлы: `crates/herder/src/auth/identity.rs`, `crates/herder/src/mcp/transport.rs`
      Результат: Опубликован e8a9df96: connection identity с раздельными target ACL и optional self binding. Два wire-теста контракта, два transport-теста и stdio отказ прошли; issuer principal и реальный target handler не доказаны.
  - V010BIND1 · ✅ Готово · (Проверить границу identity и fail-closed обычного launcher) · оценка 15 мин · усилие не измерено · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Исследовать доверенный self binding и проверить изоляцию соединений без доверия metadata; при отсутствии источника доказать отказ и описать минимальный контракт.
      Приёмка: Два процесса не принимают подставленную identity и session; доказательства и граница доверия записаны; собственный результат в локальном коммите.
      Затрагиваемые файлы: `crates/herder/tests`
      Результат: Исследован launcher и translator WIP: доверенного per-connection session binding нет. Два реальных unbound stdio процесса отвергают подмену metadata/env и свои/чужие операции без эффекта. Контракт и тест в локальном ad4c5dce; позитивная аутентификация и изоляция авторизованных соединений не доказаны и требуют harness issuer.
  - V010HTTP2 · ✅ Готово · (Изолированный native HTTP с live OAuth authority) · оценка 15 мин · усилие 17 мин по часам · по часам 17 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Собственный crate streamable HTTP, проверка каждого запроса на доверенном канале к authority и native recent в изолированном тесте.
      Приёмка: Обычный HTTP MCP consumer читает recent, после revoke прежняя MCP-сессия отказывается до reader; документировать production gap.
      Затрагиваемые файлы: `crates/herder-http/`
      Результат: d95cdee6 поверх 529dc7b9: отдельный crate RMCP HTTP 2026, request-scoped проверка через приватный тестовый pipe к реальному McpOAuthTokenStore, native OpenCode recent и отказ чужому target. Revoke, stalled и stopped authority дали 401 на том же TCP peer, MCP session ID отсутствует по lifecycle. Production защищённый authority bridge, общий launcher и canonical OAuth ownership не подключены.
  - V010HTTP3 · ✅ Готово · (Fail-closed HTTP launcher и ограниченный authority adapter) · оценка 15 мин · усилие не измерено · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Реализовать исполняемый loopback launcher без доверенного issuer и адаптер для заранее аутентифицированного канала с timeout, cancellation и карантином.
      Приёмка: Без seam запросы отказывают; канал ограничен, таймаут/отмена закрывают его и не повторяют ответ; production issuer и resolver явно не подключены.
      Затрагиваемые файлы: `crates/herder-http/`
      Результат: 52fbdbbb: loopback-only launcher без issuer отказывает 401; bounded framed adapter для заранее authenticated UnixStream закрывает канал на timeout/cancellation/malformed/EOF. 5 tests GREEN; prior real-store HTTP + OpenCode regression GREEN. Production seam, issuer authentication и restart/revocation through production bridge ждут handoff.
  - V010HTTPAUTH1 · ✅ Готово · (Подготовить request-scoped OAuth gate для native application) · оценка 15 мин · усилие 4 мин по часам · по часам 4 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Разделить HTTP authority от длительного MCP соединения; проверять живую authority на каждом запросе до native application и определить стык с единственным существующим store.
      Приёмка: Доказать повторную проверку, отказ после отзыва до application, сохранить subject; обозначить точный неготовый HTTP и legacy стык.
      Затрагиваемые файлы: `crates/herder/src/mcp/transport.rs`, `crates/herder/tests`
      Результат: 3438693a: request-scoped OAuth gate; isolated real compiled McpOAuthTokenStore issues and revokes token, same gate checks again and denies before application. Test uses application spy and private test pipe. HTTP transport, trusted bridge to live store and real HTTP-to-native-recent acceptance remain open; exact seam in tests/oauth_ingress_handoff.md.
  - V010ISSUER1 · ✅ Готово · (Контракт внешнего OAuth issuer на каждый запрос) · оценка 15 мин · усилие 2 мин по часам · по часам 2 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Сохранить проверенный issuer subject как principal и не кэшировать authority; отсутствие ответа, отзыв или истечение должны отказывать; не создавать token store.
      Приёмка: Тесты issuer/audience/scope/expiry/revocation, повторная проверка старого соединения, self отсутствует; честно указать отсутствие HTTP подключения.
      Затрагиваемые файлы: `crates/herder/src/auth/identity.rs`, `crates/herder/tests`
      Результат: c3de4aec: внешний OAuthAuthority вызывается при каждом обращении helper; сохраняет subject, проверяет issuer/audience/scope/expiry, отказ и отзыв fail closed, self=None. Тесты с fake authority GREEN. Rust HTTP ingress и bridge к единственному token store отсутствуют; реальная per-request проверка не доказана.
  - V010READ1 · ✅ Готово · (Подключить защищённый native recent read) · оценка 15 мин · усилие 10 мин по часам · по часам 10 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Подключить session recent к OpenCode reader с точным доверенно разрешённым session ref/address и instance; проверить на изолированном native процессе.
      Приёмка: Разрешённое чтение проходит через application и реальный native reader; чужие ACL и instance не читают; launcher identity остаётся внешней.
      Затрагиваемые файлы: `crates/herder/src/application/recent.rs`, `crates/herder/tests`
      Результат: 84de5fc7: session/recent через application и OpenCode reader прочитал пустую созданную сессию isolated OpenCode 2.2.4, с injected principal и точным grant; другие principal/ref отказаны, чужой instance отклонён. Источник opaque ref и launcher identity пока внешние.
  - V025GATE1 · ✅ Готово · (Подготовить межпроцессный HumanStop gate) · оценка 15 мин · усилие 5 мин по часам · по часам 5 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Реализовать изолированный primitive стабильной файловой блокировки и barrier доказательство между процессами без подключения неподтверждённой schema authority.
      Приёмка: Процессы сериализуют один canonical gate; timeout/crash не выдают повторное право; схема и реальный native путь остаются заблокированы до handoff Dirac.
      Затрагиваемые файлы: `crates/herder/src/application/reconcile.rs`, `crates/herder/tests`
      Результат: fd9c631f: provisional OS file-lock primitive, isolated cross-process barrier fixture for stop-before-claim, stop-before-handoff and handoff-before-stop; toy SQLite and test socket only. No schema, canonical aliases or native submit wiring; await Dirac schema SHA. Existing safety gate e7aa450d blocks dispatch and three previous success tests.
  - V025GUARD1 · ✅ Готово · (Проверить HumanStop в атомарном admission) · оценка 15 мин · усилие 3 ч 53 мин по часам · по часам 3 ч 53 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Единый scoped HumanStop authority для fresh isolated create, immutable mapping/generation в SQLite, межпроцессный общий gate stop и native handoff; existing/imported без handoff denied.
      Приёмка: Barrier-тесты stop до claim, между claim/handoff, handoff до stop c interrupt/UNKNOWN/no replay и fresh create→deliver→read→stop→denied; без sleeps и live migration.
      Затрагиваемые файлы: `crates/herder/src/application/reconcile.rs`
      Результат: Scoped guard интегрирован в origin/main 61e51b66 после независимого SUPPORTED review ef7d145b; combined tests 130 passed, 1 live ignored. Ранее isolated Codex proof подтверждал create/deliver/read/interrupt/denied. Production bounded port, launcher и cutover вынесены в V025PROD; формальные RED/GREEN evidence для двух дефектов требуется оформить отдельно.
  - V051A · ✅ Готово · (Перенести существующую лжемодель и изолированный launcher) · оценка 10 мин–15 мин · усилие 1 мин по часам · по часам 1 мин · волна 1 · зависит: — · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Перенести существующую лжемодель и изолированный launcher. Частный результат исходного V051: Изолированные profiles, deterministic model endpoint для поддерживающих клиентов, receipt schema. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V010.
      Приёмка: Получен проверяемый результат: Перенести существующую лжемодель и изолированный launcher. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `tests/native/harness_runner.rs`
      Результат: Изолированный loopback fixture и временный HOME launcher опубликованы 69013ed6; smoke подтвердил models/responses/chat/stream и очистку профиля. Источник скопирован с SHA256 и provenance, source WIP не менялся. E001/E002 ещё не запускались.
  - V060 · ⌛ Ожидание · (Codex: Подтвердить stop, контекст и digest всей вертикали) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Нет полного пакета доказательств AC02 AC03 AC14. Обязательство не отложено и не выполнено; будущие интеграционные шаги раскрываются по готовности входов. · волна 5 · зависит: — · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Обязательный незавершённый этап S01; точные критерии AC02 AC03 AC14 в ACCEPTANCE-COVERAGE.json. Эта карточка только принимает готовый пакет результатов этапа. Перед реализацией его остаток раскрывается в owned шагах ≤15мин по уже существующим source/evidence. Не исполнять старую deferred декомпозицию и не считать source-only полным результатом.
      Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane. Это точка объединения всей цепочки V060A, V060B, V060.
      Затрагиваемые файлы: `acceptance/native/codex/`
      Сохранённый статус: waiting
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:08:23+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b2f9-b32b-7802-b7c4-75bbe1d8475c
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; внешнее ожидание (external_waiting)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - V063C · ✅ Готово · (OpenCode: Сверить native history с Rust reader) · оценка 15 мин · усилие 12 мин по часам · по часам 12 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Исправить доступ test runtime через защищённую конфигурацию и сравнить native HTTP history двух изолированных сессий с Rust recent_messages. Секреты не выводить.
      Приёмка: OpenCode native GET history и Rust reader дают одинаковые message IDs, роли и текст обеих тестовых сессий; unknown refs остаются unknown. Evidence JSON сохранён в .tmp/v063-runtime.
      Затрагиваемые файлы: `.tmp/v063-runtime/evidence.json`
      Результат: Authenticated isolated OpenCode 2.2.4 HTTP comparison passed for two task-owned sessions. Evidence: .tmp/v063-runtime/evidence.json. Native and Rust IDs/text match; partial=false; missing turn/reply correlation remains null. Sessions returned HTTP 204 on cleanup and both isolated processes stopped.
  - V065AHAP · ✅ Готово · (Связать OpenCode через существующий AHAP adapter) · оценка 10 мин–15 мин · усилие 1 ч 14 мин по часам · по часам 1 ч 14 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Подключить Rust core к существующему OpenCode adapter через AHAP 0.1; один authority/Task/stop, instance-pinned transport, no replay.
      Приёмка: Source/fake composition AHAP→OpenCode adapter, authoritative Tasks/holds, no replay; published immutable artifact. Native consumer отдельно V065AHAPCIRUN.
      Результат: main94e7d98c и4digests independently verified; source/fake review иtestsPASS. Source ABI warning2.2.4 /api vs/session требует runtimeпроверки: Luna v9 сообщилapi-session, но core initialize FAILED_PREMUTATION из-за profile, modelcounter0. Source/fake composition готова; native/production acceptance нет. FASTINIT устраняетточныйblocker, затем выбирается готоваяподходящаяветка.
  - V065AHAPCISETUP · ✅ Готово · (Подготовить отдельную проверку моста OpenCode с готовой лжемоделью) · оценка 10 мин–15 мин · усилие 4 мин по часам · по часам 4 мин · волна 1 · зависит: — · стоимость $0.0032 · модель 302ai/gpt-6-luna · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Параллельный worker Luna использует существующий tests/native launcher/model без изменения их owned файлов. Подготовить consumer entrypoint/fixture проверку для immutable Rust AHAP core + existing TS adapter runner + real OpenCode. Исходная CI01a1ac52 продолжает прежний CI+ChatGPT scope.
      Приёмка: Сохранён воспроизводимый launch contract, owned consumer entrypoint и offline checks; только модель подменяется. Existing launcher/model не продублированы и не изменены; real run отдельно после готовых artifacts.
      Затрагиваемые файлы: `tests/native/ahap_opencode_consumer.py`, `tests/native/test_ahap_opencode_consumer.py`
      Результат: Подготовлен consumer contract в main: commits 8c2cef91 и 5d662966. Второй закрепляет SHA-256 handoff digests для Rust core/TS runner/OpenCode и требует provenance с runner fix c3b5aa58 (a3a514fa alone отклоняется). Evidence result.json обновлён; 7 offline fixture tests, py_compile и diff check PASS. Immutable assembled artifact handoff ещё не получен; native case не запускался.
  - V069 · ⌛ Ожидание · (OpenCode: Подтвердить stop, контекст и digest всей вертикали) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Нет полного пакета доказательств AC04 AC05 AC14. Обязательство не отложено и не выполнено; будущие интеграционные шаги раскрываются по готовности входов. · волна 5 · зависит: — · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Обязательный незавершённый этап S04; точные критерии AC04 AC05 AC14 в ACCEPTANCE-COVERAGE.json. Эта карточка только принимает готовый пакет результатов этапа. Перед реализацией его остаток раскрывается в owned шагах ≤15мин по уже существующим source/evidence. Не исполнять старую deferred декомпозицию и не считать source-only полным результатом.
      Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane. Это точка объединения всей цепочки V069A, V069B, V069.
      Затрагиваемые файлы: `acceptance/native/opencode/`
      Сохранённый статус: waiting
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:08:32+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b2f9-b32b-7802-b7c4-75bbe1d8475c
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; внешнее ожидание (external_waiting)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - V072RUNNER-GROUP · ✅ Готово · (ZCode runner: reap remaining process group after timeout) · оценка 15 мин · усилие 5 мин · по часам 0 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Reproduce and fix timeout cleanup where process leader exits after SIGTERM but a grandchild ignores it; validate profile symlink before resolving in run and explicit cleanup.
      Приёмка: Local fake parent/grandchild RED then GREEN proves no live descendant remains after runner timeout; cleanup only test PIDs; run and cleanup reject a symlink profile path before resolve. Commit only runner.py and test_runner.py.
      Затрагиваемые файлы: `acceptance/native/zcode/runner.py`, `acceptance/native/zcode/test_runner.py`
      Результат: Scoped commit c167805d changes only acceptance/native/zcode/runner.py and test_runner.py. RED before fix: fake grandchild ignoring SIGTERM continued its heartbeat after runner exit (20 to 26 lines). GREEN: `python3 -m unittest acceptance/native/zcode/test_runner.py` passed 3/3; timeout sends SIGKILL to the original process group after leader exit or grace expiry; run and explicit cleanup reject the source profile symlink before resolve. Tests kill only their own fake PID/group in finally. No native calls. Existing unrelated Cargo/lib/contract/README WIP remains untouched.
  - V078 · ⌛ Ожидание · (ZCode: Подтвердить stop, контекст и digest всей вертикали) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Нет полного пакета доказательств AC14. Обязательство не отложено и не выполнено; будущие интеграционные шаги раскрываются по готовности входов. · волна 5 · зависит: — · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Обязательный незавершённый этап S05; точные критерии AC14 в ACCEPTANCE-COVERAGE.json. Эта карточка только принимает готовый пакет результатов этапа. Перед реализацией его остаток раскрывается в owned шагах ≤15мин по уже существующим source/evidence. Не исполнять старую deferred декомпозицию и не считать source-only полным результатом.
      Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane. Это точка объединения всей цепочки V078A, V078B, V078.
      Затрагиваемые файлы: `acceptance/native/zcode/`
      Сохранённый статус: waiting
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:08:33+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b2f9-b32b-7802-b7c4-75bbe1d8475c
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; внешнее ожидание (external_waiting)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - V079C · ✅ Готово · (Общий direct CDP WebSocket transport) · оценка 15 мин · усилие 53 мин по часам · по часам 53 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Реализовать и изолированно проверить общий прямой CDP WebSocket transport в adapters/cdp.rs: exact target/context binding, request correlation, bounded timeout, unknown outcome без retry. Центральные Cargo.toml/lib.rs добавляет Тера.
      Приёмка: Isolated Cargo harness компилирует модуль и подтверждает handshake Origin, точные target/context identity, command correlation сквозь events, wrong-context rejection и OutcomeUnknown после timeout/disconnect.
      Затрагиваемые файлы: `crates/herder/src/adapters/cdp.rs`
      Результат: Общий direct CDP transport готов в crates/herder/src/adapters/cdp.rs: browser-level websocket, origin port override, exact target/context binding, flattened sessions, command correlation/deadline и OutcomeUnknown без replay. Исправлен временный .tmp/cdp-harness для remote Origin; cargo test --manifest-path .tmp/cdp-harness/Cargo.toml: 11 passed (4 DTO, 7 transport); cargo test --manifest-path crates/herder/Cargo.toml adapters::cdp --lib: crate compiled, 0 filtered matches; git diff --check passed. Live provider attach/send/read не проверялись здесь, это V079D. Собственный SSH tunnel закрыт.
  - V081AHAP · ✅ Готово · (Подключить готовый ChatGPT adapter к AHAP без переписывания driver) · оценка 10 мин–15 мин · усилие 32 мин по часам · по часам 32 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Минимальный TS wrapper существующих BrowserChatAdapter/provider factory для ChatGPT. Повторно использовать OpenCode runner a3a514fa+c3b5aa58 как protocol образец; общие файлы OpenCode не менять. Direct CDP, точный instance/account; fake contract без live sends. Старый CI+ChatGPT сохраняет собственный scope.
      Приёмка: Compiled wrapper initialize/init/create/send/read fake contract, native IDs и неопределённый результат сохранены, no retry/fallback; capability truthfulness. Immutable commit и handoff Тере. Live acceptance отдельным этапом после OpenCode.
      Затрагиваемые файлы: `src/ahap-browser-runner.ts`, `tests/ahap-browser-runner.test.ts`
      Результат: AHAP ChatGPT wrapper committed as ed1acd95 and wired to scoped direct CDP in d0a71185/76bd8325. Source review defects B2ac48b682687459781b0 and Baccde92c75644613b99b registered and resolved with RED/GREEN proof. Wrapper advertises only init/listSessions/getSession/getSessionMessages/sendMessage/createSession; pinned scope checked before create/send; failed/untyped sends become UNKNOWN without retry. tsc --noEmit PASS; focused suites 42/42 PASS. No CI, live/browser, or send.
  - V081CDPBASE · ✅ Готово · (Заменить browser MCP-шлюз прямым CDP транспортом) · оценка 10 мин–15 мин · усилие 20 мин по часам · по часам 20 мин · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Сохранить ChatGptMacCdpDriver/site logic. Новый ChromePageTools transport поверх уже имеющегося ws: explicit browser endpoint/context/target, request correlation/deadline/disconnect, list_pages/new_page/evaluate_script/navigate_page. Нет SSH MCPgateway/Vibe/fallback. Только isolated fake CDP.
      Приёмка: Компилируемый CDP transport и deterministic fake WebSocket tests exact target/context/request IDs, bounded errors, unknown mutation without retry. Необработанные методы явно Unsupported.
      Затрагиваемые файлы: `src/adapters/direct-cdp-page-tools.ts`, `tests/direct-cdp-page-tools.test.ts`
      Результат: Direct WebSocket CDP transport committed as 429d39b0; correlation/deadline/disconnect, strict endpoint/context/target pinning, list_pages/new_page/evaluate_script/navigate_page, and no retry after UNKNOWN mutation verified with fake WebSocket. Final follow-up checks in 76bd8325. No live browser access.
  - V087 · ⌛ Ожидание · (ChatGPT: Подтвердить stop, контекст и digest всей вертикали) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Нет полного пакета доказательств AC06 AC14. Обязательство не отложено и не выполнено; будущие интеграционные шаги раскрываются по готовности входов. · волна 5 · зависит: — · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Обязательный незавершённый этап S06; точные критерии AC06 AC14 в ACCEPTANCE-COVERAGE.json. Эта карточка только принимает готовый пакет результатов этапа. Перед реализацией его остаток раскрывается в owned шагах ≤15мин по уже существующим source/evidence. Не исполнять старую deferred декомпозицию и не считать source-only полным результатом.
      Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane. Это точка объединения всей цепочки V087A, V087B, V087.
      Затрагиваемые файлы: `acceptance/native/chatgpt/`
      Сохранённый статус: waiting
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:08:34+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b2f9-b32b-7802-b7c4-75bbe1d8475c
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; внешнее ожидание (external_waiting)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - V089TEXT · ✅ Готово · (Сохранить plain content без выдуманной метки) · оценка 10 мин–15 мин · усилие не измерено · волна 1 · зависит: — · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Общий transcript DTO различает native block и message field content, не теряет текст и не выдумывает type/index.
      Приёмка: Serde roundtrip plain content с None type/index и source_field content; существующие блоки сохраняют type/index, consumers/schema соответствуют новому контракту.
      Результат: origin/main a5c3a405: optional native type/index и source_field; 8 transcript tests и cargo check --all-targets passed, Astra SUPPORTED. Реальная Z.ai projection и user text regression остаются browser owner.
  - V096 · ⌛ Ожидание · (Z.ai: Подтвердить stop, контекст и digest всей вертикали) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Нет полного пакета доказательств AC06 AC14. Обязательство не отложено и не выполнено; будущие интеграционные шаги раскрываются по готовности входов. · волна 5 · зависит: — · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Обязательный незавершённый этап S07; точные критерии AC06 AC14 в ACCEPTANCE-COVERAGE.json. Эта карточка только принимает готовый пакет результатов этапа. Перед реализацией его остаток раскрывается в owned шагах ≤15мин по уже существующим source/evidence. Не исполнять старую deferred декомпозицию и не считать source-only полным результатом.
      Приёмка: Native input/turn IDs, artifact digest и результат каждого действия; fixture не заменяет browser/native lane. Это точка объединения всей цепочки V096A, V096B, V096.
      Затрагиваемые файлы: `acceptance/native/z-ai/`
      Сохранённый статус: waiting
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:08:35+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b2f9-b32b-7802-b7c4-75bbe1d8475c
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; внешнее ожидание (external_waiting)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - V159 · ⌛ Ожидание · (Закрыть план только по исполненным обязательным сценариям) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Нет полного пакета доказательств AC01–AC18. Обязательство не отложено и не выполнено; будущие интеграционные шаги раскрываются по готовности входов. · волна 11 · зависит: — · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Обязательный незавершённый этап S13; точные критерии AC01–AC18 в ACCEPTANCE-COVERAGE.json. Эта карточка только принимает готовый пакет результатов этапа. Перед реализацией его остаток раскрывается в owned шагах ≤15мин по уже существующим source/evidence. Не исполнять старую deferred декомпозицию и не считать source-only полным результатом.
      Приёмка: Remote main включает результат; zero unresolved mandatory defects; scope exclusions названы и явно приняты, не молча вычеркнуты. Это точка объединения всей цепочки V159A, V159B, V159.
      Затрагиваемые файлы: `release/handoff/`
      Сохранённый статус: waiting
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:08:43+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b2f9-b32b-7802-b7c4-75bbe1d8475c
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; внешнее ожидание (external_waiting)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - D002 · ✅ Готово · (Согласовать ресурсный контракт и документы с новым графом) · оценка 10 мин–15 мин · усилие 2 мин по часам · по часам 2 мин · волна 2 · зависит: D001 · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Обновить SPEC, RUST-DESIGN, COORDINATION, RECOVERY-STORAGE и HANDOFF; resource заменяет workspace, без второго owner store.
      Приёмка: 14 tools, независимые scope/attachment/authority/claim, offline layout и приёмка согласованы; прежнее исключение 60 минут убрано.
      Результат: RESOURCES.md определяет общий resource вместо workspace с 14 tools; SPEC/RUST-DESIGN/COORDINATION/RECOVERY-STORAGE/ACCEPTANCE/HANDOFF согласованы. Локальный cap=60 удалён из plan_cli.py. Контракт R001 передан Тере для немедленного старта; реализация ресурса ещё не доказана.
  - FASTCORE22 · ⌛ Ожидание · (Собрать core и runner с подтверждённым native API) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Новый конкретный остаток QOCJOIN: join source eeba0f8b/8e051d01 и опубликованный stand. Старый profile reject устранёнFASTINIT; предыдущая running запись устарела. · волна 2 · зависит: FASTINIT · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Вход: live preflight FASTINIT выбирает подтверждённую API family; source0e49/eeba и FASTOC22 WIP сохранены. Если готоваяv2ветка подходит, не ждать ненужныйv22port. Иначе интегрироватьtypedv22/freshStart послеFASTOC22. Тот же publishedcore безfixturefork; один aggregateofflinepayloadtest, build+hash handoffLuna.
      Приёмка: Scoped source review + affected tests; published main и matched artifact digests. Fresh Start поддержан только заявленным путём, общий direct Start не объявлен. Native consumer — отдельно Luna.
      Затрагиваемые файлы: `crates/herder/src/adapters/ahap_opencode.rs`, `crates/herder/src/bin/herder_native_stdio/owner_opencode.rs`, `crates/herder/tests/launcher_scoped_profile.rs`
      Сохранённый статус: waiting
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T18:15:28+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b341-e06b-7583-8fd4-352423ca22cb
      Плановая модель: неизвестно
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; внешнее ожидание (external_waiting)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - FASTOC22 · ⌛ Ожидание · (Переиспользовать работающий API OpenCode 2.2.4 в общем TS client) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Source готов8e051d01, авторские39tests/typecheck. Не опубликован; точная интеграция с core принадлежит QOCJOIN/Terra, не повторная реализация. · волна 2 · зависит: FASTOCABI · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Вход FASTOCABI: готовые request/readback в tests/native/opencode_receipt.py. Добавить explicit pinned2.2.4 routes/payload в существующий OpenCodeClient, без нового adapter/POST fallback. Режимы и native user receipt честные; если Queue не поддержан, Unsupported и typed Start composition у Terra.
      Приёмка: Offline fixture create→message→read даёт exact user receipt; unsupported modes no effect; post-effect errors UNKNOWN; никаких native sends. Immutable delta передана Terra для rebuild.
      Затрагиваемые файлы: `packages/agent-resume/src/harness/opencode/client.ts`, `tests/opencode-v22-protocol.test.ts`, `src/ahap-opencode-runner.ts`, `tests/ahap-opencode-runner.test.ts`
      Сохранённый статус: waiting
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T18:15:27+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b39a-1f8d-7882-b0ba-416fe7c3dac6
      Плановая модель: неизвестно
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; внешнее ожидание (external_waiting)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - QAHAPPORT · ✅ Готово · (Обобщить существующий AHAP port для готовых адаптеров) · оценка 10 мин–15 мин · усилие 15 мин по часам · по часам 15 мин · волна 2 · зависит: QZCODEJOIN · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Reuse текущий ahap_opencode.rs: сейчас harness=opencode, ses*/msg_* и Start hardcoded, поэтому опубликованный ZCode runner нельзя подключить к общему core. Вынести только эти различия в проверенную при старте конфигурацию существующего port; не создавать новый transport, ledger или по копии core на harness. Transport сохраняет verified harness from initialize. Текущий OpenCode consumer должен остаться совместим.
      Приёмка: Focused source tests доказывают unchanged OpenCode flow и второй ZCode-shaped flow, mismatch harness/instance отказ, opaque bounded IDs и сохранённый UNKNOWN/no retry. Публикация exact delta; native/integration не заявлять. Cargo/lib/schema/owner launch принадлежат Terra и не меняются.
      Затрагиваемые файлы: `crates/herder/src/adapters/ahap.rs`, `crates/herder/src/adapters/ahap_opencode.rs`
      Результат: Опубликован source commit 5fb51d959d1bae8d3c7f5db407f866d889530ab4 на origin/main; remote readback HEAD == origin/main. Включены только crates/herder/src/adapters/ahap.rs и crates/herder/src/adapters/ahap_opencode.rs. Точный policy signature hunk: ahap_opencode.rs:33-36 `AhapPortPolicy { harness: String, initial_delivery_mode: SendMode }`; ahap_opencode.rs:56-62 `AhapOpenCode::new_with_policy(client, instance, cwd, name, policy) -> Result<Self, RegistryUnavailable>`; ahap.rs:270-273 `AhapClient::harness() -> &str` returns initialize-verified harness. Старый AhapOpenCode::new остаётся OpenCode/Start. Queue policy маппит только Queue; runner-shaped ZCode receipt {admitted:true,inputId,pending:true} без nativeInputMessageId остаётся OutcomeUnknown, один send, без retry или переименования inputId. Native IDs непрозрачны, непустые, <=4096 bytes, без control chars; harness/instance mismatch отказ до send. Evidence: `cargo test --manifest-path crates/herder/Cargo.toml --lib ahap -- --nocapture` — 11 passed; `rustfmt +stable --edition 2024 --check ...` и `git diff --check origin/main..HEAD` прошли. Cargo/lib/schema/owner_launch/scoped_profile не менялись; native sends не выполнялись. Terra integration и OpenCode TS fix остаются отдельными.
  - QBROWSERSCOPE · ✅ Готово · (Исправить чтение после смены браузерного аккаунта) · оценка 10 мин–15 мин · усилие 47 мин по часам · по часам 47 мин · волна 2 · зависит: QBROWSERJOIN · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Исправить B720e95cbcdcd484ab0f8: pinned account проверяется по текущему provider scope при read и до возврата данных; reuse существующий direct-CDP driver, без браузерных отправок. Terra source review уже опубликован.
      Приёмка: RED A→B account change reproduces cross-account return, GREEN rejects it before data return; same-account read remains valid. Scoped source publication+evidence; no claim of live browser proof.
      Затрагиваемые файлы: `src/ahap-browser-runner.ts`, `src/adapters/chatgpt-mac-cdp-driver.ts`, `tests/ahap-browser-runner.test.ts`
      Результат: Integrated the exact four-file QBROWSERSCOPE delta on fresh origin/main b440b37c and pushed commit 303cba8d2c522ac3b3fadd971326ee2e295a280b to origin/main. Remote ls-remote and fetched origin/main both read back that exact SHA; commit parent is the fresh base and commit contains only the four assigned paths. Fresh-main focused suite passed 40/40. Evidence: evidence/QBROWSERSCOPE-main-publish-20261107.md. CI transcript WIP remains untouched. tsc --noEmit was attempted and reports unrelated OpenCode v22 type mismatches in src/adapters/opencode.ts; no unrelated files changed. No browser send or target selection.
  - QCONTROLINSTALL · ✅ Готово · (Установить проверенные исправления управления сессиями штатным CI-путём) · оценка 15 мин · усилие 8 мин по часам · по часам 8 мин · волна 2 · зависит: QQUOTARECEIPT, QDEPENDENCYWAKE · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Переиспользовать существующие builder/candidatepreflight/rollout, source ffb714b5 и publishedQDEPENDENCYWAKE. Один executor CI для локальной установки controller100, no fleetwide refresh. Immutable publishedsource only; respect releaselease/currentrevision and preserve timers/stops.
      Приёмка: Существующий candidatepreflight наexactarchive, scoped standard rollout controller100, installedSHA/hash и readback. СтарыеUNKNOWN не менять/неповторять; no policy changes/новых тестовых sends. Если реальный build/gateblocker — точныйremaining scope/evidence, не обход.
      Результат: Controller100 установлен 73e7aac61431d97f3d172175a69385d7e96538bd (включает ffb714b5 и QDEPENDENCYWAKE). Immutable source build 15/15; isolated candidate Codex/OpenCode/ZCode PASS и повторный обязательный preflight под owner release lease. Штатный owner rollout fence62, версия config/current/PID 2444904 совпадают; index SHA256 688e6e7aebb5743eebd2640bcba5077850a194a8666140e4bfbea41299b74227, bundle 3da0fa6b914db168906ae7c2b2c2cee088f658f2dccdf3fc0832b5531f6cbf3c. Read-only GET /api/sessions?quick=1&limit=1 HTTP 200; lease released, rollback drop-in сохранён. Builder преждевременно переключил current до lease, восстановлен по точным config/PID перед rollout; зарегистрирован открытый B83d137dd9a3e43ae87c1 для исправления. Wake на естественном событии и полный installed/five-adapter gate не проверялись; send/UNKNOWN не повторяли.
  - QLHCINSTALLED · ⛔ Заблокировано · (Проверка установленного LHC: задача исполнителю и пробуждение родителя) · оценка 15 мин · усилие не измерено · волна 2 · зависит: QLHCNATIVEOBS · стоимость — модель не выбрана · лист не назвал ни модель, ни класс · блокер: Self-test wait_51988f58b1ae0c2991bea8f245b9743a immediately delivery_failed: exact turn captured but native completion unavailable/idle. QLHCNATIVEOBS + installed readback required.
      Описание задачи: LHC1.17.1 уже установлен. После готового exactnative readcontract Herder: использовать новую полезную независимую задачу existingworker черезassign/dispatch, проверитьacceptedreceipt+одинcompletionwait, terminal→parentcontinuation→reconcile→accept. Не повторять прошлыеunknown inputs.
      Приёмка: Фактические native turn/input/wait IDs, terminal event и доставленныйparentwake. PublicinstalledLhcPlan entrypoint, безfakeobserver/privateworkflow. HumanStop/UNKNOWNбезобходов.
      Затрагиваемые файлы: `evidence/QLHCCONTINUE`
      Сохранённый статус: blocked
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1b2b2-5685-7b52-a2bb-05eb931cafa4; source=mcp_metadata; at=2026-11-07T21:29:47+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Плановая модель: неизвестно
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; записан блокер (external_blocked)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: leaf: Self-test wait_51988f58b1ae0c2991bea8f245b9743a immediately delivery_failed: exact turn captured but native completion unavailable/idle. QLHCNATIVEOBS + installed readback required.
  - QOCJOIN · ✅ Готово · (Собрать готовые OpenCode core и runner в один artifact) · оценка 10 мин–15 мин · усилие 1 ч 19 мин по часам · по часам 1 ч 19 мин · волна 2 · зависит: FASTINIT · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Вход eeba0f8b+8e051d01+mainca4c3907. Принять точную дельту, проверить фактический TS payload для свежего Start и опубликовать один artifact для готового Luna stand. Не новая реализация, не native mutation. Точные решения JOINT-EXECUTION.md.
      Приёмка: Source join опубликован, focused contract tests с фактическим runner payload зелёные, artifact manifest+digest доступны Luna. Native proof не заявлен.
      Затрагиваемые файлы: `crates/herder/src`, `src/ahap-opencode-runner.ts`, `packages/agent-resume/src/harness/opencode/client.ts`
      Результат: main 1d20b7f147a6a66e8daf924a32bbf73a8da6d2a8; protocol выбирается по /api/config read-only и фиксируется до mutation. RED прежнего compiled runner: POST /session 405; GREEN исправленный compiled runner фактически выдал v2 /api/session + /prompt queue и v22 /session + /message parts; 12 TS tests, tsc passed. Immutable manifest /home/roomhacker/herder-artifacts/releases/ahap-qocjoin-1d20b7f1/manifest.json SHA256 dbca738352a71f94f90e4a47f7d478359e566c520ef3a74f9664ac597936dce5 передан Luna. Старый create-operation:1d15d2739e1196ebb5b03484cb05a321 остаётся UNKNOWN, не replay; native proof нового artifact не заявлен.
  - QZAICASE · ⌛ Ожидание · (Z.ai: проверить общий core с готовым site driver) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Требуются точные делегированные browser target/account scope и lease; текущая передача CISHARE не доказывает выделенный отдельный target. · волна 2 · зависит: QBROWSERJOIN · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Переиспользовать общий CDP и существующий Z.ai driver/CI receipt. Один isolated fresh case в разрешённом target, приоритет после ChatGPT без лишнего dependency на чужой browser account.
      Приёмка: Один native result с exact identity/account scope/transcript; UNKNOWN не повторён, не смешан с source tests.
      Сохранённый статус: waiting
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T18:55:08+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=неизвестно · session_id=01a1b39a-d499-7320-809e-e3dbbfae0c33
      Плановая модель: неизвестно
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; внешнее ожидание (external_waiting)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - V002 · ✅ Готово · (Проверить Tasks/Skills/subscriptions выбранного SDK) · оценка 30 мин–1 ч · усилие 4 мин по часам · по часам 4 мин · волна 1 · зависит: V001 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Wire transcript get/update/cancel, skills/list/get/read и listen; без native эффектов.
      Приёмка: Capabilities проверяются до возврата Task; отсутствуют tasks/list/result; найденные SDK пробелы названы.
      Затрагиваемые файлы: `tests/protocol/sdk_probe.rs`
      Результат: rmcp 3.9.0 stdio: Task get/update/cancel, skills/list/get/read и subscription проверены; tasks/list и tasks/result отсутствуют. Проверка client capability до создания задачи обязательна: SDK проверяет слишком поздно. TaskManager in-memory, durability и реальный клиент не доказаны. Transcript и воспроизводимый probe опубликованы e08e2007.
  - V004 · ✅ Готово · (Конфигурация Node и HarnessInstance) · оценка 30 мин–45 мин · усилие 3 мин по часам · по часам 3 мин · волна 1 · зависит: V001 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Typed config nodes/instances/profiles/authority/secret refs; duplicate ID validation.
      Приёмка: Два профиля одного типа независимы; hostname/root не зашиты; диагностика неверного поля.
      Затрагиваемые файлы: `crates/herder/src/config.rs`
      Результат: Типизированная конфигурация nodes, instances и profiles с проверкой уникальности и диагностикой полей опубликована c92b1300; 4 теста прошли на объединённом коде. Интеграция в daemon не проверена.
  - V025CREATETASK · ✅ Готово · (Create с prompt и составной MCP Task) · оценка 10 мин–15 мин · усилие 28 мин по часам · по часам 28 мин · волна 2 · зависит: V025GUARD1 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Создать scoped session, отдельно доставить prompt и сохранить составной Task в том же SQLite с честными частичными исходами и idempotency.
      Приёмка: Fake wire проверяет tools/call→tasks/get→messages, exact policy grants, сохранение session при no-send, UNKNOWN/no replay, fixture-confirmed и conflict; production consumer проверяется отдельно.
      Результат: Source create aggregate d1f38cff исправлен ccfd813b+ddc17d40 и принят independent Nietzsche. Exact Session Read требуется даже для cached terminal child; raw/projected no-send сохраняется на repeat; global hold не мешает read-only recovery, create только Missing, регрессия create1/submit0. Авторские fake-wire/targeted GREEN сохранены; independent reviewer проверял immutable source, без повторного запуска изменённого WIP. Live consumer и direct Task dynamic grants/reconcile отдельно V025TASKRECON/V025PUBLIC.
  - V025LAUNCH · ✅ Готово · (Fresh authority в штатном launcher) · оценка 10 мин–15 мин · усилие 20 мин по часам · по часам 20 мин · волна 2 · зависит: V025GUARD1 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Проверить защищённый локальный launch profile и открытие pinned scoped authority.
      Приёмка: Exact v3 schema, protected file chain, inode/generation, FIFO fail closed и отрицательная stdio identity-проверка; authenticated MCP composition отдельно.
      Результат: origin/main ce10245a: protected scoped profile и exact v3; launcher8, scoped19+1ignored, schema2, pinned2, target1 passed; independent security review SUPPORTED для trust boundary root/current UID. Caller Unknown, ApplicationPort не подключён.
  - V025PROMPT · ✅ Готово · (Fresh create и отдельная доставка prompt) · оценка 10 мин–15 мин · усилие 39 мин по часам · по часам 39 мин · волна 2 · зависит: V025GUARD1 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Восстановить точный результат scoped create из единого store и связать его с отдельно дедуплицированной доставкой prompt без повторения native create или UNKNOWN send.
      Приёмка: Изолированные тесты показывают exact recovery, конфликт payload, однократные create/send, UNKNOWN/no replay и успешную доставку; публичный consumer и terminal MCP Task проверяются отдельно.
      Результат: Source slice принят: 42e547c1+3d99b1c1 опубликованы в main как 8a811999+ae95e063. Exact create receipt recovery и trusted policy grant для фактически нового session ref; create UNKNOWN не отправляет prompt, delivery UNKNOWN не повторяется, повтор с новыми grants не создаёт второй native session. Независимый reviewer выполнил offline locked create_prompt_ — 3/3. Production policy/ingress/consumer не входят в это source acceptance и остаются в V025COMPOSE.
  - V025TASKDELIVERY · ⏸ Отложено владельцем · (Fenced delivery и durable MCP Task) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V025GUARD1 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Связать scoped delivery, единый SQLite и стандартный tasks/get с точной identity и диагностикой.
      Приёмка: Fake wire проверяет один send, no-send/UNKNOWN/подтверждение, durable terminal status, дедупликацию и независимый read; production consumer проверяется отдельно.
  - V025TASKRECON · ✅ Готово · (Подтвердить MCP Task по сохранённой native receipt) · оценка 10 мин–15 мин · усилие 28 мин по часам · по часам 28 мин · волна 2 · зависит: V025GUARD1 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Подключить read-only reconcile точной receipt к Task и сохранить terminal projection под существующим fence; без повторного submit.
      Приёмка: Matching receipt завершает Task через application path и сохраняется после reopen; mismatch не подтверждается; повтор delivery вызывает submit ровно один раз. Ручной SQL confirmation не является доказательством.
      Результат: Source dfe5f79a независимо SUPPORTED: exact receipt read-only reconciliation без gate/SQLite transaction на network wait, fenced подтверждение, mismatch остаётся unknown/working, повтор без submit; current exact Read policy для direct task projection/tasks/get/reopen/revoke. RED/GREEN B1a5bccfdace749a4ae22, Bdcdc08ec55a54deab3fc duplicate. Проверка 33 scoped PASS/1 ignored; native consumer отдельно выполняет Terra.
  - V051B · ✅ Готово · (Заменить старый probe wrapper вызовами публичного Rust MCP) · оценка 10 мин–15 мин · усилие 6 мин по часам · по часам 6 мин · волна 2 · зависит: V051A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Заменить старый probe wrapper вызовами публичного Rust MCP. Частный результат исходного V051: Изолированные profiles, deterministic model endpoint для поддерживающих клиентов, receipt schema. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V051A.
      Приёмка: Получен проверяемый результат: Заменить старый probe wrapper вызовами публичного Rust MCP. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `tests/native/harness_runner.rs`
      Результат: Опубликован 9fa6ed76: launcher запустил общую fixture и публичный Rust MCP; discovery/tools прошли, deliver вернул unsupported effect none. Native adapter/E001/E002 ещё не связаны.
  - V065AHAPCIDRIVER · ✅ Готово · (Подготовить реальный сценарий OpenCode поверх готового CI) · оценка 10 мин–15 мин · усилие 2 ч 45 мин по часам · по часам 2 ч 45 мин · волна 2 · зависит: V065AHAPCISETUP · стоимость $0.0032 · модель 302ai/gpt-6-luna · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Дописать исполняемый consumer driver create→deliver→receipt→assistant→reopen поверх существующего launcher/model. Manifest wrapper5d662966 проверяет файлы и запускает чужой argv, но сам business scenario не реализует. Эта подготовка не зависит от готовности сборки Теры.
      Приёмка: Готов исполняемый driver с isolated OpenCode+profile запуском, MCP core create/deliver/Task/read/reopen, exact assistant evidence и model request counter; fake/offline проверка контракта. Native run отдельно после artifacts.
      Затрагиваемые файлы: `tests/native/ahap_opencode_stand.py`, `tests/native/test_ahap_opencode_stand.py`
      Результат: Stand опубликован70fba336, inline MCP preflight/namespace probes ca4c3907. Авторские14offline tests+py_compile/diff check PASS. Подготовка driver завершена; business case не выполнялся (modelrequests0/native mutations0), остаётся V065AHAPCIRUN.
  - V079D · ⛔ Заблокировано · (ChatGPT: Проверить Rust attach/read через direct CDP) · оценка 15 мин · усилие не измерено · волна 2 · зависит: V079C · стоимость — модель не выбрана · лист не назвал ни модель, ни класс · блокер: Нет делегированного изолированного ChatGPT test profile; доступный Chrome относится к обычному профилю владельца.
      Описание задачи: Подключить ChatGptReader к новому task-owned ChatGPT target в явных instance/context/target, подтвердить hashed account scope, прочитать безопасный provider response и нормализовать выбранный conversation. Не отправлять в старый CI chat.
      Приёмка: Реальный Rust consumer выполняет direct CDP attach и ChatGPT read на exact identity; scope/conversation mismatch fail-closed. Для V079B input correlation остаётся отдельным критерием и решается на собственном новом target.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/`
      Сохранённый статус: blocked
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T08:37:53+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b39a-d499-7320-809e-e3dbbfae0c33
      Плановая модель: неизвестно
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; записан блокер (external_blocked)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: leaf: Нет делегированного изолированного ChatGPT test profile; доступный Chrome относится к обычному профилю владельца.
  - V081CDPDOM · ✅ Готово · (Подключить snapshot/fill и ChatGPT wrapper к прямому CDP) · оценка 10 мин–15 мин · усилие 20 мин по часам · по часам 20 мин · волна 2 · зависит: V081CDPBASE · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Минимальная совместимая реализация оставшихся take_snapshot/fill для existing ChatGPT driver; только реально используемая driver семантика. Устойчивая привязка DOM refs к target/context и snapshot. Подключить V081AHAP к transport через explicit trusted config, не менять site operations.
      Приёмка: Fake CDP contract всех6используемых методов, stale/foreign DOMrefs rejected; wrapper uses directCDP configuration and existing driver, tsc and affected tests. Live create-send-read отдельно.
      Затрагиваемые файлы: `src/adapters/direct-cdp-page-tools.ts`, `tests/direct-cdp-page-tools.test.ts`, `src/ahap-browser-runner.ts`, `tests/ahap-browser-runner.test.ts`
      Результат: DOM snapshot/fill and AHAP direct-CDP wiring committed in 385efc83, d0a71185, 76bd8325. take_snapshot uses Accessibility.getFullAXTree; fill resolves the current snapshot backend node on the exact target session. Refs are invalidated on snapshot/navigation/fill; foreign/stale refs reject. Runner requires explicit WS endpoint, contextId, targetId and expected account SHA; no gateway/Vibe fallback. tsc and 42 focused fake tests pass. No browser action.
  - V088C · ✅ Готово · (Z.ai: Добавить Rust CDP transport и provider operations) · оценка 15 мин · усилие 1 ч 36 мин по часам · по часам 1 ч 36 мин · волна 2 · зависит: V079C · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Реализовать Z.ai operations поверх прямого WebSocket CDP и явной node/instance/browserContext/target identity; bounded read receipt.
      Приёмка: Компилируемый provider operation через direct CDP; identity validated; bounded transport errors/no retry; provider-specific read semantics.
      Затрагиваемые файлы: `crates/herder/src/adapters/zai/`
      Результат: Live Z.ai Rust provider lane proven over direct browser-level CDP WebSocket through SSH to Mac mini Chrome. Rust enumerated and attached to the exact Z.ai target/context, account scope matched, then created its own new target after verifying exact origin/account scope; it observed the input event, clicked Send once, matched the expected assistant marker, read back the same chat via provider chat_id (2 messages), and closed only its created target. Failure B565f50393c844047b64e (new-target navigation race) fixed and recorded RED/GREEN evidence under plan evidence/. Commits: 8beedf96573cc6f32c3837130b748bdb34c03d0f and c22780f1315c4e75556d271964cf02007687ed13. cargo test --lib adapters::: 4 passed; isolated CDP harness: 11 passed; git diff --check passed. rustfmt unavailable in toolchain. ChatGPT live acceptance not performed; V079D remains blocked.
  - V098A · ⏸ Отложено владельцем · (Настроить два изолированных Codex instance) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V060 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Настроить два изолированных Codex instance. Частный результат исходного V098: Изолированные profiles и двунаправленная отправка/чтение. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V060.
      Приёмка: Получен проверяемый результат: Настроить два изолированных Codex instance. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/multi/codex/`
  - V099A · ⏸ Отложено владельцем · (Настроить два изолированных OpenCode instance) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V069 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Настроить два изолированных OpenCode instance. Частный результат исходного V099: Изолированные connections и проверка control/history. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V069.
      Приёмка: Получен проверяемый результат: Настроить два изолированных OpenCode instance. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/multi/opencode/`
  - V100A · ⏸ Отложено владельцем · (Выбрать два разрешённых браузерных профиля) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V087 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Выбрать два разрешённых браузерных профиля. Частный результат исходного V100: Два разрешённых тестовых profile refs и отдельные вкладки. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V087.
      Приёмка: Получен проверяемый результат: Выбрать два разрешённых браузерных профиля. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/multi/browser/`
  - D003 · ✅ Готово · (Проверить граф, опубликовать детализацию и передать Тере) · оценка 10 мин–15 мин · усилие 3 мин по часам · по часам 3 мин · волна 3 · зависит: D002 · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Сверить исходные обязательства, DAG и лимит новых шагов; построить публичную страницу и передать готовую очередь с условной оценкой.
      Приёмка: Канонический check/build успешен, публичный HTML содержит resource и новые шаги; исходная история сохранена, Тере переданы ближайшие действия.
      Результат: Canonical build/check успешны; 159 исходных обязательств сохранены, 150 разбиты с сохранением acceptance, новых шагов >15м нет, циклов нет. Публичная страница HTTP200 содержит R001/E001/V009A. Проверка review-evidence/15m-plan-validation.json; оценка 15m-forecast.json. Тере передан стабильный RESOURCES, R001 уже запущен. V003 и остаток V011 остаются её открытой работой; продуктовая приёмка этой ревизией не заявлена.
  - QAHAPLAUNCH · ⛔ Заблокировано · (Подключить общий AHAP port к штатному запуску экземпляров) · оценка 10 мин–15 мин · усилие не измерено · волна 3 · зависит: QAHAPPORT · стоимость — модель не выбрана · лист не назвал ни модель, ни класс · блокер: Возобновление Terra отклонено codex_quota_guard:quota_unknown; tool result admissionUnknown/nonRetryable.
      Описание задачи: Общий port5fb51d95 готов; owner launch/scoped profile всё ещё OpenCode-specific. Включить существующий port в один trusted per-instance launch path для готовых ZCode/browser runners, без нового ядра/transport и без изменения текущих production providers. Реальный OpenCode case идёт независимо на pinned1d89d04d.
      Приёмка: Protected profile pins node/instance/harness/runner configuration; verified AHAP harness/capabilities выбирают поддержанный mode без silentfallback; два instance/harness source tests, current OpenCode compatibility, scoped publication+artifact contract. No native sends; QZ receipt gap сохраняется, не подменять inputId.
      Затрагиваемые файлы: `crates/herder/src/bin/herder_native_stdio.rs`, `crates/herder/src/bin/herder_native_stdio/owner_opencode.rs`, `crates/herder/src/bin/herder_native_stdio/scoped_profile.rs`
      Сохранённый статус: blocked
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1b2b2-5685-7b52-a2bb-05eb931cafa4; source=mcp_metadata; at=2026-11-07T20:38:47+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b341-e06b-7583-8fd4-352423ca22cb
      Плановая модель: неизвестно
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; записан блокер (external_blocked)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: leaf: Возобновление Terra отклонено codex_quota_guard:quota_unknown; tool result admissionUnknown/nonRetryable.
  - QMACREUSE · ✅ Готово · (Переиспользовать рабочий Mac Mini transport в AHAP browser runner) · оценка 15 мин · усилие 13 мин по часам · по часам 13 мин · волна 3 · зависит: QBROWSERSCOPE · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Mac Mini50260DevTools gateway и штатный MacMiniChromeTransport живы. Raw-CDP-only launcher не должен блокировать reuse. Явная конфигурация существующего transport, pinned page/account, без fallback и новых bridge/dependencies. CI владеет native target preparation, этот leaf source-only.
      Приёмка: Runner явно выбирает существующий direct CDP или штатный MacMiniChromeTransport; fail closed без exact page/account, отсутствие скрытого fallback; focused tests, published owned commit и launch contract. Не выдавать source proof за native case.
      Затрагиваемые файлы: `src/ahap-browser-runner.ts`, `tests/ahap-browser-runner.test.ts`, `acceptance/native/browser/`
      Результат: Published QMACREUSE on fresh origin/main. Commit f9ec4647b9b71289d339d37e603114a46e1b3ab9 has parent 0fdd84c71332321fc8c652efcc7fc961aaa451c2 and contains only src/ahap-browser-runner.ts, tests/ahap-browser-runner.test.ts, acceptance/native/browser/launch-contract.md. Remote ls-remote and post-push fetch both read back f9ec4647. Runner now requires explicit AHAP_CHATGPT_TRANSPORT=mac-mini|direct-cdp; Mac Mini mode reuses MacMiniChromeTransport, and both modes require exact page ID + expected account scope. AHAP filters list_pages to that page and fails closed if absent; no transport/page fallback. Focused typecheck passed and runner tests passed 12/12 twice on fresh-main revisions. Evidence: evidence/QMACREUSE-20261107.md. CI worktree's independent transcript hunk remains untouched. Native browser acceptance, target selection, and messages were not run.
  - QOCPREFLIGHT · ✅ Готово · (Устранить ложное совпадение API в preflight OpenCode) · оценка 5 мин–15 мин · усилие 0 мин по часам · по часам 0 мин · волна 3 · зависит: V065AHAPCIDRIVER · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: stand require_runner_route_compat(api_family,pinned_protocol='v2') вызывается без runner input; этим preflight объявил совпадение, хотя artifact runner фактически выбирал v22. Также detect API200 null сейчас ошибочно считает v2. Использовать точный подтверждённый runner startup contract и одинаковую семантику existing receipt probe; не угадывать по default/версии.
      Приёмка: RED actual v2-v22 mismatch rejected before create and config200 null distinguished; GREEN valid families accepted only with verified artifact/runner choice, unknown choice fails descriptive. Source+offline tests+publication; старый UNKNOWN не повторять, native create/send здесь не запускать.
      Затрагиваемые файлы: `tests/native/ahap_opencode_stand.py`, `tests/native/test_ahap_opencode_stand.py`
      Результат: Исправлены только tests/native/ahap_opencode_stand.py и tests/native/test_ahap_opencode_stand.py; commit b440b37cd0a237691057f7ee5f8014e5a58e7a8d опубликован origin/main, после push HEAD == origin/main. Серверная family detector различает v2 (HTTP 200 valid JSON object/array) и v22 (HTTP 200 JSON null; HTTP 404 только с HTTP 200 JSON object /api/health); malformed/unknown fail closed. Guard без default запускает exact runner artifact и сравнивает capabilities.nativeProtocol из его read-only initialize. Retained v2 config-array + runner v22 mismatch отвергается до mutation. RED: evidence/QOCPREFLIGHT-red.txt; GREEN: evidence/QOCPREFLIGHT-green.txt; 16 focused offline tests pass; py_compile и git diff --check pass. Native create/send не запускались; прежний UNKNOWN create-operation:1d15d2739e1196ebb5b03484cb05a321 не повторялся.
  - QOCPROBEJSON · ✅ Готово · (Отказать при невалидном JSON в выборе API OpenCode) · оценка 5 мин–10 мин · усилие 6 мин по часам · по часам 6 мин · волна 3 · зависит: QOCJOIN · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Остаток B1ea420df80c3455995cc после published1d20b7f1: parse failure нельзя превращать в JSONnull/v22. Terra уже получил точный defect и исправляет; сохранить source results QOCJOIN без fictitious closure нового remainder.
      Приёмка: RED invalidJSON wrongly selects protocol → GREEN refusal before mutation; explicitnull still v22; publish fixed source+replacement artifact+digest, предыдущий1d20 artifact только source proof. Native UNKNOWN case не повторять.
      Затрагиваемые файлы: `src/ahap-opencode-runner.ts`, `tests/ahap-opencode-runner.test.ts`
      Результат: main 1d89d04dbefec21ed355533da49bd60e11ee7114: HTTP200 malformed JSON отвергается до mutation, только настоящий null выбирает v22; 404 требует /api/health 200 JSON object, 200 JSON object/array выбирает v2. Handshake result.capabilities.nativeProtocol без default. RED 1 failed→GREEN 14 passed; compiled artifact проверен на обе семьи и payload, manifest /home/roomhacker/herder-artifacts/releases/ahap-qocjoin-1d89d04d/manifest.json SHA256 cd78329317fac02fe0ae56c2f08aa9f2693ffd0422de943bf9390c218405efac. Передан Luna; реальный consumer pending, старый UNKNOWN не replay.
  - QZRECEIPT · ✅ Готово · (Передать настоящий ZCode receipt через готовый AHAP runner) · оценка 10 мин–15 мин · усилие 12 мин по часам · по часам 12 мин · волна 3 · зависит: QAHAPPORT, QZCODEJOIN · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Current ZCode runner returns admitted/inputId/pending without nativeInputMessageId; общий core правильно сохраняет UNKNOWN. Reuse working CI L45 native protocol/receipt, явно передать подтверждённый native identity и readback correlation без synthetic caller-ID и без retry. Допускается источник результата native adapter, никакие live UNKNOWN не повторять.
      Приёмка: Реальные documented/recorded native response shapes → exact receipt mapping; pending без native confirmation остаётся pending/UNKNOWN. Source contract tests positive/ambiguous/no replay+published scoped delta; новый native case только отдельно после ready artifact.
      Затрагиваемые файлы: `src/ahap-zcode-runner.ts`, `src/adapters/zcode.ts`, `tests/ahap-zcode-runner.test.ts`, `acceptance/native/zcode/ahap-contract.json`
      Результат: Source published to origin/main as dc9d882103002b09e4109019a7a880f3fda3cf54 (parent 303cba8d2c522ac3b3fadd971326ee2e295a280b). Scoped paths only: src/adapters/zcode.ts, src/ahap-zcode-runner.ts, tests/ahap-zcode-runner.test.ts, acceptance/native/zcode/ahap-contract.json. Reused zcodeNativeAdmission read-only exact same-session message lookup requiring adapter-derived sourceCommandId; nativeInputMessageId is copied only from the matching native user row, with turnId separate. Caller inputId is unchanged. Missing anchor/turn-only evidence does not synthesize nativeInputMessageId; UNKNOWN/pending semantics remain. Evidence: npx vitest run --root . --config vitest.config.ts tests/ahap-zcode-runner.test.ts: 7/7 passed; npx tsc --noEmit passed; git diff --check passed. Tests cover exact receipt, turnId-only, other-session/wrong-command mismatch, and existing ambiguous no-retry. No native sends; V078 remains separate; V072D/V072E UNKNOWN not replayed. Exact signature hunk: ZcodeAdapter.sendMessage queue/steer/images branch normalizes admission, derives native correlation with zcodeInputId(callerInputId, origin), calls zcodeNativeAdmission(localDbPath, id, [nativeCommandId]), and copies only native.userMessageId to nativeInputMessageId plus native.turnId separately. Remote main readback: dc9d882103002b09e4109019a7a880f3fda3cf54.
  - T002 · ✅ Готово · (Поднять legacy downstream и native upstream на официальных SDK) · оценка 10 мин–15 мин · усилие 0 мин по часам · по часам 0 мин · волна 3 · зависит: T001, V002 · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Реализовать только этот проверяемый шаг по COMPATIBILITY.md. Входы: T001, V002. При неизвестном SDK/consumer маршруте сначала назвать минимальный пробел; не форкать Codex.
      Приёмка: Изолированный wire probe проходит оба handshake; версии и feature flags закреплены, native endpoint не понижает wire.
      Затрагиваемые файлы: `crates/herder-compat/`, `acceptance/compat/`
      Результат: Закреплён rmcp=3.9.0; upstream использует ClientLifecycleMode::Discover и строго получает 2026-07-28, downstream stdio negotiate initialize на 2025-06-18. Интеграционный wire test подключил LegacyEdge к скомпилированному crates/herder/src/bin/herder_native_stdio, проксировал ровно список 14 native tools из upstream discovery и подтвердил отсутствие downgrade. Evidence: review-evidence/run-01a1b398/native-endpoint.json; test output green-B8.txt. Это только protocol/catalog proof: native handlers пока unsupported/effect=none, capabilities Tasks/Skills/Resources отсутствуют; Codex consumer и бизнес-путь не проверены.
  - V003 · ✅ Готово · (Проверить конкретный основной MCP-клиент) · оценка 30 мин–1 ч · усилие 1 ч 33 мин по часам · по часам 1 ч 33 мин · волна 1 · зависит: V002 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один объявленный потребитель подключается к probe; revision/extensions/identity matrix.
      Приёмка: Есть прямой trace реального клиента, не SDK talking to itself; unsupported блокирует gate и зависимую реализацию.
      Затрагиваемые файлы: `acceptance/contracts/primary-client.json`
      Результат: Диагностика завершена: прямой app-server Codex 0.167.0 с opt-in работает на новом wire, но протестированный Tasks запрос отказан -32021 без побочного эффекта; штатный MCP Skills discovery/listen не найден. По прямому решению владельца используется отдельный удаляемый translator; совместимость Codex через него проверят T011/T013, это НЕ PASS прямого пути. Evidence e0ea5ed5 и review-evidence/v003-app-extensions.
  - V005 · ✅ Готово · (Типы адресов и capabilities) · оценка 30 мин–45 мин · усилие 2 мин по часам · по часам 2 мин · волна 1 · зависит: V004 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Node/instance/session refs, supported/available/authorized отдельно; версии capability.
      Приёмка: Одинаковые native IDs в разных instance не равны; offline не unsupported.
      Затрагиваемые файлы: `crates/herder/src/domain/address.rs`
      Результат: Адреса node/instance/session и раздельные support/availability/authorization опубликованы d5d1e145; 7 тестов прошли, live integration не проверена.
  - V025CREATEINPUT · ✅ Готово · (Объяснить причину неправильного create input и исправление) · оценка 5 мин–10 мин · усилие 12 мин по часам · по часам 12 мин · волна 3 · зависит: V025CREATETASK · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Узкая diagnostic delta mcp_create.rs: distinct unsupported project_ref, empty prompt, malformed request_key и instance mismatch. Без раскрытия чужих данных.
      Приёмка: Ответ содержит проблемное поле, expected form и конкретное исправление; ноль create/send при invalid input. Generic unauthorized не раскрывает чужие ресурсы.
      Результат: Astra independent source review 3fe988fa + 18270c63 SUPPORTED. Clean immutable worker HEAD18270c63: targeted fake wire test passed 1/1. Four actionable field diagnostics with correction/effect=none, authorization precedes diagnostics; no prompt/key/project echo, zero create/submit/intents. Source proof only; V025PUBLIC remains separate.
  - V051 · ⏸ Отложено владельцем · (Подтвердить уникальные input и native receipt без вызова реальной модели) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V051B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить уникальные input и native receipt без вызова реальной модели. Частный результат исходного V051: Изолированные profiles, deterministic model endpoint для поддерживающих клиентов, receipt schema. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V051B.
      Приёмка: Native процесс отличим от fake adapter; никакого личного аккаунта/звонка; отдельные browser test identities. Это точка объединения всей цепочки V051A, V051B, V051.
      Затрагиваемые файлы: `tests/native/harness_runner.rs`
      Результат: 27a22ff0: изолированный Codex 0.167.0 выполнил 2 input/turn с отдельными native IDs и fixture answer, подтверждено thread/read; через Herder MCP ещё не проходит.
  - V065AHAPCIRUN · ⛔ Заблокировано · (Проверить новый мост на реальном OpenCode с лжемоделью) · оценка 10 мин–15 мин · усилие не измерено · волна 3 · зависит: QOCJOIN, V065AHAPCIDRIVER · стоимость $0.0032 · модель 302ai/gpt-6-luna · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional · блокер: Native create outcome UNKNOWN; replay forbidden
      Описание задачи: Готовый standmainca4c3907+QOCJOIN artifact. Один fresh isolated native create/deliver/read/reopen; exact IDs/request count/receipt, no replay UNKNOWN. Не писать второй CI launcher или model server.
      Приёмка: Exact artifact digests, session/input/receipt, model-request counter, native readback/reopen и сохранённые failure evidence. Accepted/UNKNOWN не повторять; старые V064LIVE/V065LIVE не переисполнять. Результат в canonical evidence.
      Затрагиваемые файлы: `.agents/tasks/20261107-herder-native-mcp-breaking/review-evidence/V065AHAPCIRUN`
      Результат: Preflight PASS на manifest SHA256 6e00a60d8f4c62d156351606b8131a781a90ba105945a033d993b79ad395818f: API v2/config 200, MCP tools/list ok, mutations=0, model_requests=0. Единственный разрешённый case запустил create; Task create-operation:1d15d2739e1196ebb5b03484cb05a321 вернул outcome_unknown/retry=forbidden без native receipt. Native OpenCode log: POST /session HTTP 405. Read-only retained DB: ноль session_v2/inbox/messages и ноль Herder bindings/messages; model_requests_at_failure=0. Evidence: evidence/V065AHAPCIRUN-20261107.json; retained workspace: /home/roomhacker/herder-artifacts/retained/ahap-opencode-run-076bacd8-20261107. Повтор запрещён; реальный create/read/reopen не подтверждён.
      Сохранённый статус: blocked
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T18:58:59+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b5e5-b6de-74c3-8276-45803194a16f
      Плановая модель: gpt-6-luna
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; записан блокер (external_blocked)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: leaf: Native create outcome UNKNOWN; replay forbidden
  - V098B · ⏸ Отложено владельцем · (Отправить разные маркеры и сопоставить native IDs) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V098A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Отправить разные маркеры и сопоставить native IDs. Частный результат исходного V098: Изолированные profiles и двунаправленная отправка/чтение. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V098A.
      Приёмка: Получен проверяемый результат: Отправить разные маркеры и сопоставить native IDs. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/multi/codex/`
  - V099B · ⏸ Отложено владельцем · (Отправить разные маркеры и остановить один instance) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V099A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Отправить разные маркеры и остановить один instance. Частный результат исходного V099: Изолированные connections и проверка control/history. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V099A.
      Приёмка: Получен проверяемый результат: Отправить разные маркеры и остановить один instance. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/multi/opencode/`
  - V100B · ⏸ Отложено владельцем · (Создать разные тестовые сообщения в отдельных профилях) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V100A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Создать разные тестовые сообщения в отдельных профилях. Частный результат исходного V100: Два разрешённых тестовых profile refs и отдельные вкладки. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V100A.
      Приёмка: Получен проверяемый результат: Создать разные тестовые сообщения в отдельных профилях. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/multi/browser/`
  - D004 · ✅ Готово · (Внести удаляемый translator и распределить работу между самостоятельными сессиями) · оценка 10 мин–15 мин · усилие 12 мин по часам · по часам 12 мин · волна 4 · зависит: D003 · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Прямые решения владельца: legacy compatibility только на edge; Terra <=4 агента; Astra оркестрирует самостоятельные сессии и волны. Зафиксировать контракт/цепочку <=15м, снять прежний блокер маршрута и выдать непересекающиеся направления.
      Приёмка: Есть native/legacy граница, точные Tasks/Skills/subscriptions mapping, отдельные user-owned chats с проверенным стартом, ownership путей и обновлённые waves. Fork Codex не нужен.
      Результат: Созданы6 самостоятельных чатов; wait_threads подтвердилactive/inProgress. У Теры<=4 прямыхагента, общийпул10. COMPATIBILITY.md/T001–T015 задают удаляемый native-to-legacy translator без forkCodex/второгоTaskstore; V010/E001/E002/V097 зависимости исправлены. WAVES.md содержит92 условные волны с переменной занятостью/core<=4; ORCHESTRATION.md фиксируетграницы. Canonical build/check прошёл. Ресурсныйhandoff передан после8c607d3c; nativeсессиямданы точные путиcore иexistingfake-model fixture. Реализацияtranslator и adapters продолжается, не объявлена готовой.
  - QOCREGRESSION · ✅ Готово · (Проверить исправленный OpenCode в новом изолированном экземпляре) · оценка 10 мин–15 мин · усилие 10 мин по часам · по часам 10 мин · волна 4 · зависит: QOCPROBEJSON, QOCPREFLIGHT · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Новый самостоятельный regression исправленного artifact1d89d04d + standb440b37c в полностью отдельном disposable native instance/fresh DB/fake model. Не повтор старого UNKNOWN: retained076bacd8, его instance/DB/intent не открывать для записи, старый request не повторять и не переименовывать. Пройти actual core→AHAP→OpenCode create/initial delivery/read/reopen с квитанцией.
      Приёмка: Exact artifact hashes, fresh isolated instance paths, server/runner nativeProtocol equality, native user+assistant IDs, local modelcounter, core Task/result+transcript readback/reopen, cleanup. Старый UNKNOWN остаётся сохранён; новый UNKNOWN не retry. Никаких production/paid models.
      Затрагиваемые файлы: `tests/native/ahap_opencode_stand.py`, `tests/native/test_ahap_opencode_stand.py`, `acceptance/early/opencode/`
      Результат: PASS: fresh standalone core→AHAP→OpenCode case on manifest 1d89d04d SHA256 cd78329317fac02fe0ae56c2f08aa9f2693ffd0422de943bf9390c218405efac; AHAP stand b440b37cd0a237691057f7ee5f8014e5a58e7a8d. Exact core/runner/OpenCode hashes matched manifest; manifest-pinned Node v22.22.2 SHA verified and used. Read-only server and exact runner protocol both v2 before mutation. In new loopback-only network namespace, disposable user/filesystem HOME, fresh authority DB/profile: Task create-operation:e1440ce607b38baa23931fb57fe3cdde completed; session_ref session:06e2b65301159526f7e622aaa2bfd3ef bound native ses_e48eee10affexJRqEVmWqcrikv; user receipt/message msg_1b7112059001y6Thh7Uu75wwvI; assistant msg_1b71120870012BuTJBrUNPsLrF; core readback and reopened Task/transcript completed; local fake-model counter exactly 1. Launcher removed disposable instance; temporary hardlink carrier and failed-preflight scratch removed. Evidence: evidence/QOCREGRESSION/native-case-receipt.json and native-case-final.log. Two prior attempts failed before mutation: one wrapper argument-order error; one wrong system Node v12.22.9 (model counter 0); recovered using manifest-pinned Node v22.22.2. No UNKNOWN retry; prior 1d15… and retained 076bacd8 untouched. Source b440b37 remains ancestor of origin/main (which advanced independently); worktree has no edits.
  - QOCTYPEJOIN · ✅ Готово · (Исправить интеграцию типов OpenCode v22 в опубликованном main) · оценка 15 мин · усилие не измерено · волна 4 · зависит: QOCPROBEJSON · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: QBROWSERSCOPE fresh-main tsc выявил несогласованность protocol v22/isV22/start в src/adapters/opencode.ts. Воспроизвести и перенести минимальную пропущенную дельту из готовогоFASTOC22 без переписывания.
      Приёмка: Зафиксированный RED tsc на freshmain, минимальная source дельта, GREEN tsc и focused adaptertests, owned publication. Native regression Luna не трогать.
      Затрагиваемые файлы: `src/adapters/opencode.ts`, `tests/opencode-adapter.test.ts`
      Результат: Астра проверила актуальный main dc9d8821 с текущими shared dependencies: tsc --noEmit exit0, evidence/QQUOTARECEIPT/typecheck.txt. Старый browser report на303cba8d не воспроизводится; новый codefix не требуется. Worker assignment not_attempted, повторов не было.
  - QZAIFACTORY · ✅ Готово · (Подключить готовый Z.ai site driver к общему browser AHAP runner) · оценка 15 мин · усилие 9 мин по часам · по часам 9 мин · волна 4 · зависит: QMACREUSE · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Текущий runner принимает только AHAP_HARNESS=chatgpt. Переиспользовать существующий Z.ai driver с тем же явным transport/page/account contract; одна dispatchфункция, capabilities factual. No newtransport/driver rewrite.
      Приёмка: Configured harness chatgpt/zai реально создаёт соответствующий adapter; capabilities/harness неhardcodeChatGPT, unknownmode/page/account failsbeforemutation; tests both, scopedpublish. НативныйZ.ai отдельный QZAICASE; не обходить missingaccountproof, CI driverfilesне трогать.
      Затрагиваемые файлы: `src/ahap-browser-runner.ts`, `tests/ahap-browser-runner.test.ts`, `acceptance/native/browser/launch-contract.md`
      Результат: Source-only factory published as 4489c69bcf6a24ab7457161ed158eda4a1a6fdc8 on main; remote SHA confirmed. Existing Z.ai driver is selected via the explicit shared Mac Mini transport and exact page; reads perform fresh expected-scope checks. Focused runner tests 15/15 pass. The existing Z.ai proof cannot establish scope for an empty list; that precise limitation is recorded and fails closed. Native Z.ai/browser acceptance is not claimed. Evidence: evidence/QZAIFACTORY-main-publish-20261107.md.
  - V006 · ✅ Готово · (Контракт pure core и native port) · оценка 30 мин–45 мин · усилие 3 мин по часам · по часам 3 мин · волна 1 · зависит: V005 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: DTO Admission/Unknown/Receipt и маленькие reader/control ports; enum registry.
      Приёмка: Табличный pure decision test без I/O; fake submit различает never sent и unknown.
      Затрагиваемые файлы: `crates/herder/src/domain/adapter.rs`
      Результат: Pure decision и native port, различение отсутствия отправки и UNKNOWN опубликованы 8b7f8111; 11 тестов интегрированного кода прошли. Native adapters не проверены.
  - V008 · ✅ Готово · (Привязать caller и области доступа) · оценка 30 мин–1 ч · усилие 3 мин по часам · по часам 3 мин · волна 1 · зависит: V005 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Verified principal/self binding; deny-by-default для private session и ресурсов.
      Приёмка: Подмена sender/session_ref и общий node token не дают self; auth не следует из parent.
      Затрагиваемые файлы: `crates/herder/src/auth/identity.rs`
      Результат: Правила caller/self и приватных scope опубликованы 1add72a9; 9 интеграционных unit тестов прошли. Реальный transport identity ещё не подтверждён.
  - V098 · ⏸ Отложено владельцем · (Проверить изоляцию истории и управления двух Codex) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V098B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить изоляцию истории и управления двух Codex. Частный результат исходного V098: Изолированные profiles и двунаправленная отправка/чтение. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V098B.
      Приёмка: В обоих профилях свои IDs/history; fixture одинакового native ID не смешивает ключи. Это точка объединения всей цепочки V098A, V098B, V098.
      Затрагиваемые файлы: `acceptance/multi/codex/`
  - V099 · ⏸ Отложено владельцем · (Проверить сохранение работы и истории второго instance) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V099B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить сохранение работы и истории второго instance. Частный результат исходного V099: Изолированные connections и проверка control/history. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V099B.
      Приёмка: Отправка и stop одного instance не касаются второго. Это точка объединения всей цепочки V099A, V099B, V099.
      Затрагиваемые файлы: `acceptance/multi/opencode/`
  - V100 · ⏸ Отложено владельцем · (Подтвердить отсутствие пересечения истории и отправки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V100B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить отсутствие пересечения истории и отправки. Частный результат исходного V100: Два разрешённых тестовых profile refs и отдельные вкладки. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V100B.
      Приёмка: History/send не пересекают аккаунты; нет использования чужой вкладки или credentials в receipt. Это точка объединения всей цепочки V100A, V100B, V100.
      Затрагиваемые файлы: `acceptance/multi/browser/`
  - E002 · ✅ Готово · (Показать первый native ответ OpenCode через новый MCP) · оценка 10 мин–15 мин · усилие не измерено · волна 5 · зависит: QOCREGRESSION · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Использовать квитанцию единственного OpenCode consumer Luna: exact source/artifact, native user/assistant IDs, model counter и reopen. Повторно не отправлять. Выход — проверяемый первый путь нового core, не финальный installed release.
      Приёмка: Установить dev сборку. Пройти create→deliver→read на изолированном OpenCode с лжемоделью. Полная приёмка V069 остаётся обязательной.
      Затрагиваемые файлы: `acceptance/early/opencode/`
      Результат: Astra прочитала и сверила evidence/QOCREGRESSION/native-case-receipt.json с native-case-final.log (LAUNCH_EXIT=0): source1d89d04d/standb440b37c; manifestcd783293..; core→AHAP→настоящий OpenCode v2, native session ses_e48eee10affexJRqEVmWqcrikv, confirmeduser msg_1b7112059001y6Thh7Uu75wwvI, assistant msg_1b71120870012BuTJBrUNPsLrF, HERDER_TEST_MODEL_OK, model_requests=1, taskcompleted/reopenedcompleted. Namespace fresh+cleanup. Это первый candidate consumer; installedrelease/stop/context/fullAC остаются V069. ИсторическийUNKNOWN076bacd8 не трогался.
  - I001 · ✅ Готово · (Собрать общий adapters namespace и зависимости) · оценка 15 мин · усилие 5 мин по часам · по часам 5 мин · волна 5 · зависит: V006 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Интегрировать подтверждённые owned commits Codex, OpenCode и browser normalizers; единый adapters namespace и только необходимые Cargo зависимости. Не считать тесты native acceptance.
      Приёмка: Все подключённые modules компилируются и их тесты проходят на объединённом source; нет Vibe runtime dependency, явно указаны версии и границы незавершённых маршрутов.
      Затрагиваемые файлы: `crates/herder/src/lib.rs`, `crates/herder/Cargo.toml`, `crates/herder/Cargo.lock`
      Результат: Codex/OpenCode connections и ChatGPT/Z.ai DTO с единым adapters namespace и reqwest 0.12.28 объединены в main 47ff0fba; 46 unit tests passed. Native/browser runtime, auth и полная приёмка ещё не доказаны; Vibe не является dependency.
  - R001 · ✅ Готово · (Определить неизменный Resource ID и независимые scope, attachment и owner) · оценка 10 мин–15 мин · усилие 2 мин по часам · по часам 2 мин · волна 5 · зависит: V005, V008 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Типизированный descriptor: global/project/node, kind, external_ref, authority_ref, attachment с observed_at; без секретов и свободного executable кода.
      Приёмка: Телефон сохраняет ID при смене attachment; global не выдаёт права; scope отделён от storage authority.
      Затрагиваемые файлы: `crates/herder/src/domain/resource.rs`
      Результат: Typed ResourceDescriptor и отдельный ResourceClaim опубликованы dbb8890c; перенос attachment сохраняет identity и claim, global не предоставляет права, authority не зависит от attachment; 18 тестов прошли. Хранилище, ACL и работа устройства не проверены.
  - T003 · ⋯ В очереди · (Передать caller identity и ACL через translator) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Нужен конкретный trusted credential channel и isolated proof A/B ACL + revoke A на уже открытом соединении для Tasks/read. HTTP gate не блокирует отдельно обозначенный single-owner stdio consumer. · волна 5 · зависит: T002, V008 · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Вход crates/herder-compat/src/edge.rs + готовый protected caller boundary. Передать verified transport identity upstream, не принимать principal из model metadata. Проверить два principals и unknown identity до effect. Существующий refused T016 не повторять; stopped translator worker не будить.
      Приёмка: Два downstream principal остаются разными upstream; подмена session/Task ref отвергнута.
      Затрагиваемые файлы: `crates/herder-compat/`, `acceptance/compat/`
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:12:50+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b341-e06b-7583-8fd4-352423ca22cb
      Плановая модель: gpt-6-astra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; исполнитель занят (owner_busy)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - V007 · ✅ Готово · (Одна диагностическая схема ошибок) · оценка 30 мин–45 мин · усилие 50 мин по часам · по часам 50 мин · волна 1 · зависит: V006 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: field/received/expected/fix/effect/retry/receipt; redaction секретов.
      Приёмка: Wrong mode и conflict reply_to дают однозначный исправляемый вызов без mutation.
      Затрагиваемые файлы: `crates/herder/src/error.rs`
      Результат: Диагностика wrong mode и reply_to, redaction, effect и retry опубликована aa34c88e; 15 тестов объединённого кода прошли. Подключение к реальным MCP handlers и consumer ещё не проверено.
  - V011A · ✅ Готово · (Подключить version fence к SQLite writer) · оценка 15 мин · усилие 9 мин по часам · по часам 9 мин · волна 5 · зависит: V006 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Добавить минимальный Rust SQLite connection и регистрацию herder_writer_version для каждого writer, используя опубликованную схему 03627936.
      Приёмка: Writer с новой схемой открывается и пишет; регистрация версии обязательна, без production базы.
      Затрагиваемые файлы: `crates/herder/src/store`
      Результат: Rust SQLite writer с регистрацией версии и fail-closed подключением опубликован f6283c92; тесты показали запись на совпадающей версии и отказ при mismatch. Реальная проверка старого compiled writer — V011B.
  - V017A · ✅ Готово · (Адресовать session, Task и transcript стандартными MCP resource URI) · оценка 10 мин–15 мин · усилие 7 мин по часам · по часам 7 мин · волна 5 · зависит: V008 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Source стандартных MCP Resource URI и типизированного чтения session/Task/transcript/registered Resource в отдельном mcp/resources.rs поверх текущего rmcp и существующего storage. Подключение к NativeServer/ingress отдельно.
      Приёмка: Получен проверяемый результат: Адресовать session, Task и transcript стандартными MCP resource URI. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/mcp/resources.rs`
      Результат: Commit 526757a8 adds only crates/herder/src/mcp/resources.rs. ResourceUri parses and canonically formats herder://session|task|transcript|resource/{opaque-ref}; invalid encodings, noncanonical encodings, extra path/query/fragment, empty/control refs are rejected. ResourceReadPort and ResourceValue provide typed source boundaries for existing SessionSnapshot, rmcp GetTaskResult, TranscriptPage and canonical ResourceDescriptor; list/read projection returns pinned rmcp Resource/ListResourcesResult/ReadResourceResult. Four focused tests passed with temporary `pub mod resources;` in lib.rs, removed before commit. rustfmt +stable and git diff --check pass. Shared module registration and runtime consumer remain unproven.
  - V028A · ✅ Готово · (Нормализовать последние user и assistant с turn и временем) · оценка 10 мин–15 мин · усилие 4 мин по часам · по часам 4 мин · волна 5 · зависит: V006 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Нормализовать последние user и assistant с turn и временем. Частный результат исходного V028: Общий projection user+assistant с turn/time/partial; read-only session. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V006.
      Приёмка: Получен проверяемый результат: Нормализовать последние user и assistant с turn и временем. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/recent.rs`
      Результат: Чистая нормализация последних сообщений ролей с сохранением turn/time/partial опубликована a6548e3a; тесты прошли. Native reader и полная V028 ещё не проверены.
  - V031A · ✅ Готово · (Выдать список сессий по project и instance без FTS) · оценка 10 мин–15 мин · усилие 6 мин по часам · по часам 6 мин · волна 5 · зависит: V006, V005 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Выдать список сессий по project и instance без FTS. Частный результат исходного V031: Постраничный список по project/instance; native availability отдельно от cached records. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V006, V005.
      Приёмка: Получен проверяемый результат: Выдать список сессий по project и instance без FTS. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/list.rs`
      Результат: Чистая paginated выборка cached session snapshots по полным project/instance и отдельной availability опубликована 55a2138e; 2 targeted теста прошли. Native/live список и обновление snapshot ещё не подключены.
  - V032A · ✅ Готово · (Читать каталог моделей точного instance) · оценка 10 мин–15 мин · усилие 45 мин по часам · по часам 45 мин · волна 5 · зависит: V005, V006 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Читать каталог моделей точного instance. Частный результат исходного V032: discover(kind=models) отдаёт verified catalog и unknown значения. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V005, V006.
      Приёмка: Получен проверяемый результат: Читать каталог моделей точного instance. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/models.rs`
      Результат: Интеграция подтверждена в source HEAD 24d1f229: application/models.rs в bc6dcb26 и export в a5b03c90; следующие native consumer шаги остаются в V032B/V032.
  - V036A · ✅ Готово · (Описать storage authority и global, project, node scope) · оценка 10 мин–15 мин · усилие 9 мин по часам · по часам 9 мин · волна 5 · зависит: V004, V008 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Описать storage authority и global, project, node scope. Частный результат исходного V036: Storage/project/resource markers, точный offline locator и ACL policy. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V004, V008.
      Приёмка: Получен проверяемый результат: Описать storage authority и global, project, node scope. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/ownership/manifest.rs`
      Результат: Typed storage authority и markers project/node/global опубликованы 16108ea9; 28 интегрированных unit-тестов прошли. Реальное хранилище и владение ещё не проверены; строгая deserialization исправляется в F001.
  - V052A · ✅ Готово · (Codex: Зафиксировать версию и один официальный native маршрут) · оценка 10 мин–15 мин · усилие 1 мин по часам · по часам 1 мин · волна 5 · зависит: V006 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Codex: Зафиксировать версию и один официальный native маршрут. Частный результат исходного V052: Один versioned app-server JSON-RPC: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V006.
      Приёмка: Получен проверяемый результат: Codex: Зафиксировать версию и один официальный native маршрут. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/contracts/codex.md`
      Результат: Codex CLI 0.167.0: app-server stdio JSON-RPC, initialize/initialized; исходный протокол объявляет thread/read/list и turn/start/steer/interrupt с expectedTurnId. Доступность конкретных операций live в этом leaf не проверена; официальная документация https://learn.chatgpt.com/docs/app-server.
  - V061A · ✅ Готово · (OpenCode: Зафиксировать версию и один официальный native маршрут) · оценка 10 мин–15 мин · усилие 2 мин по часам · по часам 2 мин · волна 5 · зависит: V006 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: OpenCode: Зафиксировать версию и один официальный native маршрут. Частный результат исходного V061: Один versioned HTTP/events: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V006.
      Приёмка: Получен проверяемый результат: OpenCode: Зафиксировать версию и один официальный native маршрут. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/contracts/opencode.md`
      Результат: OpenCode 2.2.4: source-backed GET /api/session и /api/event, сервер 127.0.0.1:4095 доступен; оба запроса без авторизации вернули 401. Authenticated read/events не проверены.
  - V070A · ✅ Готово · (ZCode: Зафиксировать версию и один официальный native маршрут) · оценка 10 мин–15 мин · усилие 1 мин по часам · по часам 1 мин · волна 5 · зависит: V006 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: ZCode: Зафиксировать версию и один официальный native маршрут. Частный результат исходного V070: Один versioned подтверждаемый native session transport: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V006.
      Приёмка: Получен проверяемый результат: ZCode: Зафиксировать версию и один официальный native маршрут. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/contracts/zcode.md`
      Результат: ZCode 0.16.9: app-server ZCode Protocol stdio; Herder src/adapters/zcode-protocol.ts и zcode.ts описывают hello/ack и методы readSession/readSessionMessages. Live handshake и receipt в этом leaf не проверены.
  - V079A · ✅ Готово · (ChatGPT: Типизировать native normalization DTO) · оценка 10 мин–15 мин · усилие 13 мин по часам · по часам 13 мин · волна 5 · зависит: V006 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Зафиксировать ChatGPT conversation payload projection отдельным typed DTO/normalizer с изолированными fixture tests. Не заявлять authenticated profile или live API proof.
      Приёмка: Из acceptance/native/chatgpt/Cargo.toml проходят fixture tests для conversation identity, selected branch, user/assistant text и фильтрации внутренних сообщений.
      Затрагиваемые файлы: `acceptance/contracts/chatgpt.md`
      Результат: crates/herder/src/adapters/chatgpt/mod.rs и acceptance/native/chatgpt/conversation.json; isolated harness: 2/2 tests passed. Evidence: /tmp/herder-native-adapters-01a1b2b2/summary.md. Не доказаны live provider API, authorized profile, route, receipt/history/context или product crate registration.
  - V088A · ✅ Готово · (Z.ai: Типизировать native normalization DTO) · оценка 10 мин–15 мин · усилие 13 мин по часам · по часам 13 мин · волна 5 · зависит: V006 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Зафиксировать Z.ai messages/batch payload projection отдельным typed DTO/normalizer с изолированными fixture tests. Не заявлять authenticated profile или live API proof.
      Приёмка: Из acceptance/native/z-ai/Cargo.toml проходят fixture tests для chat identity, requested message ordering, text blocks и фильтрации неизвестной роли.
      Затрагиваемые файлы: `acceptance/contracts/z-ai.md`
      Результат: crates/herder/src/adapters/zai/mod.rs и acceptance/native/z-ai/messages-batch.json; isolated harness: 2/2 tests passed. Evidence: /tmp/herder-native-adapters-01a1b2b2/summary.md. Не доказаны live provider API, authorized profile, route, receipt/history/context или product crate registration.
  - F001 · ✅ Готово · (Отклонять лишние поля области ресурса) · оценка 15 мин · усилие 27 мин по часам · по часам 27 мин · волна 6 · зависит: R001 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Исправить подтверждённую ошибку B05de7d28746541c59261: global scope не должен принимать project_ref и другие неизвестные поля.
      Приёмка: RED: global с лишним project_ref принимается; GREEN: отклоняется; корректные global/project/node по-прежнему проходят, включая JSON Schema path.
      Затрагиваемые файлы: `crates/herder/src/domain/resource.rs`
      Результат: Strict ResourceScope исправлен 8c607d3c; одинаковый regression тест: RED exit 101, GREEN 1 passed; bug B05de7d28746541c59261 закрыт с хешированными доказательствами review-evidence/f001. Schema vs dispatch дополнительно проверены 9060361c.
  - QOCEXPORT · ✅ Готово · (Проверить OpenCode export через тот же публичный MCP и native transcript) · оценка 15 мин · усилие 15 мин · по часам 12 мин · волна 6 · зависит: E002 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Расширить существующий stand отдельным export acceptance case; reuse confirmed artifact/core, отдельный isolated fixture и localfake backend. Не повторять предыдущие операции/UNKNOWN. Public export результат сравнить с exact native user+assistant rows и after-reopen; unsupported capability зафиксировать честно.
      Приёмка: Public tools/call export и его task/result/resource возвращают exact native messages и completeness; independent native read сравнение, reopen same result. При unavailable feature конкретный bounded source contract gap, без поддельногоPASS. Scoped publication+receipt, cleanup.
      Затрагиваемые файлы: `tests/native/ahap_opencode_stand.py`, `tests/native/test_ahap_opencode_stand.py`, `acceptance/early/opencode/`
      Результат: EXPORT_UNAVAILABLE — public MCP tools/call export вернул {code:unsupported,effect:none,message:operation is not connected}; exact gap подтверждён в pinned core ApplicationPort. Native create→initial deliver→read/reopen завершены; сравнение export payload невозможно, PASS не заявляется. Evidence: evidence/QOCEXPORT/native-export-case-receipt.json, public-export-wire-contract.json, native-export-case.log; readiness RED/GREEN tests.
  - T008 · ⏸ Отложено владельцем · (Отдать Skills и содержимое старому клиенту) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: T003 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Реализовать только этот проверяемый шаг по COMPATIBILITY.md. Входы: T003. При неизвестном SDK/consumer маршруте сначала назвать минимальный пробел; не форкать Codex.
      Приёмка: compat_skill list/get и доступный resource read работают; чтение не выдано за activation.
      Затрагиваемые файлы: `crates/herder-compat/`, `acceptance/compat/`
  - T009 · ⏸ Отложено владельцем · (Отобразить подписку в notifications или bounded changes read) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: T003 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Реализовать только этот проверяемый шаг по COMPATIBILITY.md. Входы: T003. При неизвестном SDK/consumer маршруте сначала назвать минимальный пробел; не форкать Codex.
      Приёмка: Настоящий listen, ограниченный буфер, cursor и snapshot/resync после потери; push в модель не обещан.
      Затрагиваемые файлы: `crates/herder-compat/`, `acceptance/compat/`
  - V009A · ✅ Готово · (Описать строгие варианты 14 инструментов, заменив workspace на resource) · оценка 10 мин–15 мин · усилие 4 мин по часам · по часам 4 мин · волна 6 · зависит: V007, V002, R001 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Описать строгие варианты 14 инструментов, заменив workspace на resource. Частный результат исходного V009: Единая декларация discovery/dispatch с oneOf schemas; actions read/mutate разделены. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V007, V002, R001.
      Приёмка: Получен проверяемый результат: Описать строгие варианты 14 инструментов, заменив workspace на resource. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/mcp/catalog.rs`
      Результат: Строгие типы входных вариантов 14 инструментов, включая resource, опубликованы f0b0b96f; 24 теста прошли. JSON Schema discovery и dispatch ещё не подключены.
  - V011B · ✅ Готово · (Проверить старый writer после миграции схемы) · оценка 15 мин · усилие 8 мин по часам · по часам 8 мин · волна 6 · зависит: V011A · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Доказать отказ записи через настоящий скомпилированный старый writer после повышения версии схемы, сохраняя атомарность.
      Приёмка: Два отдельных compiled writer и временная БД: новый проводит миграцию, старый не пишет; нет half intent; результат воспроизводим.
      Затрагиваемые файлы: `crates/herder/tests`
      Результат: Два compiled test writer на временной SQLite базе: старый writer при открытом соединении отказал после user_version 2; новый пишет, rollback убирает task/intent. Опубликовано c5befa28, 1 integration test прошёл. Конструктор файла тестовый, production migration V2 ещё не доказана.
  - V017B · ✅ Готово · (Применять ACL и приватный cache к каждому чтению) · оценка 10 мин–15 мин · усилие 30 мин по часам · по часам 30 мин · волна 6 · зависит: V017A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Применять ACL и приватный cache к каждому чтению. Частный результат исходного V017: Session/task/transcript resources с remote-readable refs и pagination. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V017A.
      Приёмка: Получен проверяемый результат: Применять ACL и приватный cache к каждому чтению. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/mcp/resources.rs`
      Результат: Source-only V017B committed in 7c8dd65a54d423e1a27b3a8b0a3da88ad5b0bcc1 and follow-up a698aeefd5e2a3a2e0c74c12a603971aee889560. Task projection requires URI ref == ResourceValue.task_ref and embedded GetTaskResult task ID. Added authorized_task_read_rejects_result_for_different_task_id regression through read_authorized. RED: evidence/v017b-task-payload-mismatch-red.txt (expected TypeMismatch assertion failed); GREEN: evidence/v017b-task-payload-mismatch-green.txt (10 passed). Tests used temporary module export, removed before commit; no lib.rs diff. Independent delta-review SHIP. Session/transcript source binding remains an authoritative resolver contract, not runtime proof. NativeServer wiring and consumer acceptance remain separate.
  - V028B · ✅ Готово · (Пометить partial, truncation и связь ответа с input) · оценка 10 мин–15 мин · усилие 4 мин по часам · по часам 4 мин · волна 6 · зависит: V028A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Пометить partial, truncation и связь ответа с input. Частный результат исходного V028: Общий projection user+assistant с turn/time/partial; read-only session. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V028A.
      Приёмка: Получен проверяемый результат: Пометить partial, truncation и связь ответа с input. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/recent.rs`
      Результат: Projection сохраняет partial/truncation и связывает ответ с input только по явным идентификаторам; опубликовано c5aa79a8, 4 целевых теста прошли. Реальный native reader ещё не подключён.
  - V031B · ✅ Готово · (Добавить страницы, observed_at и offline coverage) · оценка 10 мин–15 мин · усилие 10 мин по часам · по часам 10 мин · волна 6 · зависит: V031A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Добавить страницы, observed_at и offline coverage. Частный результат исходного V031: Постраничный список по project/instance; native availability отдельно от cached records. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V031A.
      Приёмка: Получен проверяемый результат: Добавить страницы, observed_at и offline coverage. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/list.rs`
      Результат: Опубликован c1988bcd: страницы snapshot и coverage, 4 теста прошли; native consumer не подключён.
  - V032B · ⏸ Отложено владельцем · (Отделить cache квоты разных профилей и unknown) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V032A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Отделить cache квоты разных профилей и unknown. Частный результат исходного V032: discover(kind=models) отдаёт verified catalog и unknown значения. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V032A.
      Приёмка: Получен проверяемый результат: Отделить cache квоты разных профилей и unknown. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/models.rs`
      Результат: Опубликован 7628576d: QuotaCache изолирует InstanceRef, unknown/0/unlimited, исключает stale/foreign; 5 tests. Legacy quota read глобальный, provider bridge не подключён.
  - V033A · ✅ Готово · (Разобрать typed patch node, instance и session) · оценка 10 мин–15 мин · усилие 11 мин по часам · по часам 11 мин · волна 6 · зависит: V004, V008, V007 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Разобрать typed patch node, instance и session. Частный результат исходного V033: Node/instance/session settings поддерживаются только при capability, typed patches. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V004, V008, V007.
      Приёмка: Pure parser декодирует только node.endpoint:string, instance.endpoint:string|null, session.model:string; непустые значения, точный scope и revision сохраняются. Mapping configure.node.endpoint/configure.instance.endpoint/configure.session.model явен. Неверный target/key/type отклоняется до эффекта с точным полем и способом исправления. Capability не объявляется supported самим parser; native apply/CAS остаются V033B/V033.
      Затрагиваемые файлы: `crates/herder/src/application/settings.rs`
      Результат: Pure configure patch parser implemented in crates/herder/src/application/settings.rs; scoped commit fd258e2fb2122255f37df7cb797a0d8a4a0515ad. Finite variants only: node/endpoint/non-empty string, instance/endpoint/non-empty string|null, session/model/non-empty native model ID string. Parsed output carries exact typed target, typed patch, unchanged revision, and required capability name; no support/applied state, I/O, storage, normalization, or effects. Rejects wrong target/key/value with field/expected/correction and does not echo rejected values. Focused isolated-copy tests: 3 passed; rustfmt +stable --check and diff --check passed. Test crate temporarily exported the module; original lib.rs intentionally untouched. Not proven here: module integration, model membership in the correct native catalog, writer/CAS, capability availability, desired/applied.
  - V036B · ✅ Готово · (Проверять независимый resource marker и разрешённый offline маршрут) · оценка 10 мин–15 мин · усилие 13 мин по часам · по часам 13 мин · волна 6 · зависит: V036A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Проверять независимый resource marker и разрешённый offline маршрут. Частный результат исходного V036: Storage/project/resource markers, точный offline locator и ACL policy. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V036A.
      Приёмка: Получен проверяемый результат: Проверять независимый resource marker и разрешённый offline маршрут. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/ownership/manifest.rs`
      Результат: StorageAuthority::read_local_resource_marker проверяет local route, абсолютный root, storage/resource/project identity, path component и Authorization; возвращает точный каталог лишь после проверки. Опубликовано в main: 6d1d15e41c7acca331d00bda0ab32ecf12be7449. На опубликованном SHA ownership::manifest::tests проходит 3/3; git diff --check passed. Evidence: /home/roomhacker/.codex/worktrees/herder-resources-recovery/agent-herder/.tmp/v036b/RESULT.md. MCP/CLI integration не заявлена.
  - V052B · ✅ Готово · (Codex: Проверить доступность test profile и корреляцию input) · оценка 10 мин–15 мин · усилие 8 мин по часам · по часам 8 мин · волна 6 · зависит: V052A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Codex: Проверить доступность test profile и корреляцию input. Частный результат исходного V052: Один versioned app-server JSON-RPC: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V052A.
      Приёмка: Получен проверяемый результат: Codex: Проверить доступность test profile и корреляцию input. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/contracts/codex.md`
      Результат: Codex CLI 0.167.0 direct app-server probe passed in an isolated CODEX_HOME and loopback-only network namespace using the authorized local fake-model fixture. A unique native input and HERDER_TEST_MODEL_OK assistant item appeared in one completed turn; turn/start response, turn/started, turn/completed and thread/read matched native turn 01a1b3a1-b2aa-7512-a959-b40be3fabdce; thread 01a1b3a1-b283-7b40-bb72-83d7f28155aa; user item 01a1b3a1-b343-7640-9ace-e878747ae1da; assistant item msg_test_1; fixture received exactly one request. Evidence: /home/roomhacker/.codex/worktrees/herder-codex-native/agent-herder/.tmp/v052b-codex-profile-20261107/{RESULT.md,proof.json,native-transcript.jsonl,result.json}. This is direct app-server proof only; adapter/MCP/install/consumer are unproven.
  - V061B · ✅ Готово · (OpenCode: Проверить доступность test profile и корреляцию input) · оценка 10 мин–15 мин · усилие 12 мин по часам · по часам 12 мин · волна 6 · зависит: V061A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: OpenCode: Проверить доступность test profile и корреляцию input. Частный результат исходного V061: Один versioned HTTP/events: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V061A.
      Приёмка: Получен проверяемый результат: OpenCode: Проверить доступность test profile и корреляцию input. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/contracts/opencode.md`
      Результат: Изолированный OpenCode 2.2.4 поднят с отдельными HOME/XDG и task-owned loopback auth; на единственный input ref v061b-input-20261107-5e7429b5 native API прочитал user message msg_1b3a66ec3001qxRDmdN2DXIlDE и assistant message msg_1b3a670a9001Z40JO1l9YfPKHo в точной сессии ses_e4c5afe46ffegA4WFmXjGvF9xS; ответ HERDER_TEST_MODEL_OK. Fake fixture requests 0→2, поэтому не заявлено, что было ровно одно completion HTTP обращение. Тестовая сессия удалена (204), оба собственных процесса остановлены. Доказательства: .tmp/v061b/evidence.json, .tmp/v061b/native-messages.json, acceptance/contracts/opencode.md. Adapter create/deliver/recent ещё не проверен.
  - V070B · ✅ Готово · (ZCode: Проверить доступность test profile и корреляцию input) · оценка 10 мин–15 мин · усилие 44 мин по часам · по часам 44 мин · волна 6 · зависит: V070A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: ZCode: Проверить доступность test profile и корреляцию input. Частный результат исходного V070: Один versioned подтверждаемый native session transport: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V070A.
      Приёмка: Получен проверяемый результат: ZCode: Проверить доступность test profile и корреляцию input. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/contracts/zcode.md`
      Результат: Подтверждён isolated native route: ZCode CLI 0.16.9 + ZCode Server 3.17.2 (`3.17.2-linux-x64-88a41b337faa`) в новом временном HOME/server-root и изолированном loopback; supervisor достиг ready, control.sock присутствует, host capability получен, authenticated /ws/host подключён. Native initialize requestId=1 ответил responseId=1 (available=false — провайдер не настроен); listSessions requestId=2 ответил responseId=2 и вернул 0 сессий (ожидаемо для нового профиля). Evidence: acceptance/contracts/zcode.md и .tmp/run-v070b-zcode/{official-server-receipt.json,official-websocket-receipt.json} в /home/roomhacker/.codex/worktrees/herder-zcode-native/agent-herder. Отправка model input, корреляция inputId и чтение непустой истории не доказаны; inference requests=0. Старый отдельный stdio app-server 0.16.9 достиг ready без ожидаемого hello и без RPC; он не является штатным выбранным supervisor WebSocket маршрутом.
  - V079B · ⏸ Отложено владельцем · (ChatGPT: Проверить доступность test profile и корреляцию input) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V079A · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Проверить доступность test profile и корреляцию input. Частный результат исходного V079: Один versioned авторизованный browser profile через разрешённый маршрут: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V079A.
      Приёмка: Получен проверяемый результат: ChatGPT: Проверить доступность test profile и корреляцию input. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/contracts/chatgpt.md`
      Результат: Direct CDP confirmed Chrome 156.0.8078.80/protocol 1.3 and exact instance/context identities. Provider-specific composer accepts visible draft but submit remains disabled and input event is absent under safe preflight. No message was sent; this is not a confirmed provider outage and does not prove Rust adapter.
  - V080A · ✅ Готово · (ChatGPT: Открыть соединение конкретного instance) · оценка 10 мин–15 мин · усилие 6 мин по часам · по часам 6 мин · волна 6 · зависит: V079A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Реализовать source direct-CDP attach/read для конкретного ChatGPT instance поверх общего cdp.rs; fake CDP fixture подтверждает точный context/target, без live profile действий.
      Приёмка: Получен проверяемый результат: ChatGPT: Открыть соединение конкретного instance. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/connection.rs`
      Результат: Existing ChatGptReader source attach_via_browser/read_conversation is now covered end-to-end against a local fake CDP browser; source was reused without a parallel transport. Fake target inventory includes a neighbor tab; the exact ChatGPT target, browserContextId and attached CDP session are checked. Fake auth scope and page origin are verified, then the adapter's exact same-origin GET /backend-api/conversation/{id} expression returns the captured conversation fixture and normalizes user/assistant messages. The fixture injects unrelated protocol events and mismatched response IDs. Assertions prove no Target.createTarget/closeTarget, DOM/Input, or send action on the read path. Wrong-context target is rejected before attach/page evaluation. Commit 71af7987380420cc95e8af60ced9f52e30a9c7d4 (only crates/herder/src/adapters/chatgpt/mod.rs). Command `cargo test --manifest-path crates/herder/Cargo.toml adapters::chatgpt::tests`: 4 passed, 0 failed; exact output evidence/V080A-direct-cdp-green.txt (SHA-256 c9bc0d5e51f36f702043d4fd420ce3fe75cd45c7fa7453d1479fa77b002e7493). No real profile, live API, or send used.
  - V088B · ✅ Готово · (Z.ai: Проверить доступность test profile и корреляцию input) · оценка 10 мин–15 мин · усилие 18 мин по часам · по часам 18 мин · волна 6 · зависит: V088A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Z.ai: Проверить доступность test profile и корреляцию input. Частный результат исходного V088: Один versioned авторизованный browser profile через разрешённый маршрут: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V088A.
      Приёмка: Получен проверяемый результат: Z.ai: Проверить доступность test profile и корреляцию input. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/contracts/z-ai.md`
      Результат: Live browser/provider proof completed through direct CDP in explicit Chrome instance/context: isolated new Z.ai target, New Chat, one unique marker sent once, same target returned marker_OK and provider conversation route. DOM exposed no message IDs. This does not prove Rust Herder adapter.
  - QOCV1CI · 🔄 В работе · (OpenCode stand: принять native export и V1 CI-сценарии) · оценка 15 мин · усилие не измерено · прошло 3 ч 25 мин на момент сборки · отстаём: прошло 3 ч 25 мин при оценке 15 мин · волна 7 · зависит: QOCEXPORT · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Расширить только tests/native/ahap_opencode_stand.py и его regression tests под V1 owner contract: export format=native с lossless bytes_base64, complete/source; common явно unsupported; discover(action=projects,instance_ref); второй отдельный deliver в ту же сессию, оба input/reply, search marker coverage, restart без resend. Live case только на опубликованном новом candidate с новым disposable scope; исторические receipts не переигрывать. Зафиксировать обязательные поля отчёта для CI REPORT.
      Приёмка: Source regression покрывает native lossless export, explicit common unsupported, projects discovery, два same-session deliver и search/reopen/no-resend checks. Новый manifest preflight проверяет hashes, launcher/mounts и exact runner/server protocol. Live receipt на новом candidate содержит по каждому сценарию status PASS/FAIL/UNSUPPORTED/UNKNOWN, stage=candidate|installed, source_commit, manifest_sha256, core/runner/opencode/node/bootstrap hashes+versions, run_id, instance_ref, session_ref, оба Task/request/native user+assistant IDs, search marker+coverage, export format/complete/source/decoded SHA256+length, restart/replay proof, model request delta и evidence/cleanup paths. QOCV1CI не PASS до candidate consumer receipt; старые операции не replay.
      Затрагиваемые файлы: `tests/native/ahap_opencode_stand.py`, `tests/native/test_ahap_opencode_stand.py`, `acceptance/early/opencode/`
      Сохранённый статус: running
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1b5e5-b6de-74c3-8276-45803194a16f; source=mcp_metadata; at=2026-11-07T22:51:31+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b5e5-b6de-74c3-8276-45803194a16f
      Плановая модель: неизвестно
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; сохранённый статус не в очереди (not_queued)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - V009B · ✅ Готово · (Получать discovery и dispatch из одной декларации) · оценка 10 мин–15 мин · усилие 13 мин по часам · по часам 13 мин · волна 7 · зависит: V009A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Получать discovery и dispatch из одной декларации. Частный результат исходного V009: Единая декларация discovery/dispatch с oneOf schemas; actions read/mutate разделены. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V009A.
      Приёмка: Получен проверяемый результат: Получать discovery и dispatch из одной декларации. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/mcp/catalog.rs`
      Результат: Единая декларация каталога генерирует schema и typed parse/classification 14 tools; опубликовано 4c893a4e, 29 тестов на объединённом коде прошли. Подключение к MCP и независимая JSON Schema валидация ещё не доказаны.
  - V011 · ✅ Готово · (SQLite схема и транзакционные границы) · оценка 30 мин–1 ч · усилие 1 ч 26 мин по часам · по часам 1 ч 26 мин · волна 1 · зависит: V011B · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Таблицы tasks/intents/messages/holds/lineage/settings; migration version.
      Приёмка: Rollback transaction не оставляет half intent; новый schema version запрещает запись старому binary.
      Затрагиваемые файлы: `crates/herder/src/store/schema.sql`
      Результат: Schema tables и version guards 03627936, writer f6283c92, межпроцессный тест c5befa28: rollback не оставляет half intent, старый тестовый binary не пишет после смены версии. Production migration V2 и файловый runtime writer ещё не реализованы; это не доказательство установки.
  - V017 · ⋯ В очереди · (Проверить чужой principal, страницы и срок cache) · оценка 10 мин–15 мин · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: V017B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Вход resources.rs+a698aeef: URI/object/task-result identity checks готовы. Подключить этот resolver к реальному NativeServer resource read. Owned implementation resources/handler, shared export patch передать Тере. Проверка обычным SDK: своё доступно, чужое denied, TaskA/payloadB denied. Не переписывать ACL.
      Приёмка: Другой principal не читает result/Task; cacheScope private и ttlMs корректны. Это точка объединения всей цепочки V017A, V017B, V017.
      Затрагиваемые файлы: `crates/herder/src/mcp/resources.rs`
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:12:42+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b399-4210-7471-8286-93750dff10b7
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: неизвестно; назначение не подтверждено (assignment_unknown)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - V028 · ✅ Готово · (Проверить старый ответ и недоступный источник) · оценка 10 мин–15 мин · усилие 9 мин по часам · по часам 9 мин · волна 1 · зависит: V028B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Проверить старый ответ и недоступный источник. Частный результат исходного V028: Общий projection user+assistant с turn/time/partial; read-only session. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V028B.
      Приёмка: Старый assistant не назван ответом на новый input; отсутствующий источник не пустая история. Это точка объединения всей цепочки V028A, V028B, V028.
      Затрагиваемые файлы: `crates/herder/src/application/recent.rs`
      Результат: Чистая recent projection различает недоступный источник и пустую историю, сохраняет старый ответ отдельно и не выводит связь без ID. Опубликовано 715465b3, 5 тестов прошли. Подключение native reader ещё не доказано.
  - V031 · ✅ Готово · (Проверить одинаковые имена и частично недоступные источники) · оценка 10 мин–15 мин · усилие 54 мин по часам · по часам 54 мин · волна 1 · зависит: V031B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Проверить одинаковые имена и частично недоступные источники. Частный результат исходного V031: Постраничный список по project/instance; native availability отдельно от cached records. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V031B.
      Приёмка: Offline peer явно отмечен, одинаковые basename не склеены. Это точка объединения всей цепочки V031A, V031B, V031.
      Затрагиваемые файлы: `crates/herder/src/application/list.rs`
      Результат: Опубликованы dd761c64/d21369f2 и a9d8afc0: одинаковые имена/ID из разных instance, offline/empty/missing и coverage страниц проверены, включая OpenCode→injected inventory→MCP. Штатная production композиция вынесена в V031C.
  - V031C · ⋯ В очереди · (Подключить production inventory к sessions/list) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Нет production create binding и композиции в штатном launcher · волна 7 · зависит: V031B · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Вход V031A/B/V031 и существующий application/list.rs. Подключить готовый inventory provider к действующему native application вместо fixture injection. Не писать новый discovery/index. Проверка: две existing source fixtures разных instance и явный offline/partial; shared lib/wiring только у Теры.
      Приёмка: Обычный клиент получает список живого изолированного instance через штатный launcher; недоступный источник виден как неполное покрытие.
      Затрагиваемые файлы: `crates/herder/src/application/list.rs`
      Результат: 49afd980: ConfiguredListInventory на SQLite v2 и native reader, три теста и изолированный OpenCode→SQLite→MCP прошли; binding создан в test DB, production остаётся открытым.
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:12:47+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b341-e06b-7583-8fd4-352423ca22cb
      Плановая модель: неизвестно
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; исполнитель занят (owner_busy)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - V032 · ⏸ Отложено владельцем · (Проверить неизвестную квоту без нуля или unlimited) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V032B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить неизвестную квоту без нуля или unlimited. Частный результат исходного V032: discover(kind=models) отдаёт verified catalog и unknown значения. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V032B.
      Приёмка: Два профиля не разделяют auth/quota cache, unknown не zero/unlimited. Это точка объединения всей цепочки V032A, V032B, V032.
      Затрагиваемые файлы: `crates/herder/src/application/models.rs`
  - V033B · ✅ Готово · (Сохранить desired revision и применить поддерживаемый patch) · оценка 10 мин–15 мин · усилие 11 мин по часам · по часам 11 мин · волна 7 · зависит: V033A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Сохранить desired revision и применить поддерживаемый patch. Частный результат исходного V033: Node/instance/session settings поддерживаются только при capability, typed patches. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V033A.
      Приёмка: Получен проверяемый результат: Сохранить desired revision и применить поддерживаемый patch. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/settings.rs`
      Результат: Source slice commit a356fa44 plus follow-up CAS fix f6317184 in crates/herder/src/application/settings.rs. apply_patch now uses only ParsedSettingPatch.revision for the read/CAS; the separate expected_revision argument was removed. RED reproduced accepting parsed revision 1 against current 0 when the caller supplied expected 0; fixed regression now rejects it before save/apply. SettingsPort docs require implementations to serialize revision-read through applied-mark per target across processes and port instances; &mut self alone is explicitly insufficient. Targeted tests pass 7/7. This remains source/fake-port proof only; no production persistence or consumer integration claimed.
  - V036 · ✅ Готово · (Отличить отсутствие owner от wrong root, mount loss и EACCES) · оценка 10 мин–15 мин · усилие 1 ч 41 мин по часам · по часам 1 ч 41 мин · волна 2 · зависит: V036B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Отличить отсутствие owner от wrong root, mount loss и EACCES. Частный результат исходного V036: Storage/project/resource markers, точный offline locator и ACL policy. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V036B.
      Приёмка: Wrong root/storage/mount loss отличаются от owner ENOENT; секретов нет. Это точка объединения всей цепочки V036A, V036B, V036.
      Затрагиваемые файлы: `crates/herder/src/ownership/manifest.rs`
      Результат: StorageAuthority::read_owner_bytes возвращает Ok(None) только при отсутствующем owner.json после проверки storage/resource и project markers и их повторной сверки; wrong identity, missing storage marker и остальные I/O ошибки остаются Err. Опубликовано в main: 6d1d15e41c7acca331d00bda0ab32ecf12be7449. На опубликованном SHA ownership::manifest::tests проходит 3/3; git diff --check passed. Evidence: /home/roomhacker/.codex/worktrees/herder-resources-recovery/agent-herder/.tmp/v036/RESULT.md. MCP/CLI/owner writes ещё не доказаны.
  - V052 · ✅ Готово · (Codex: Записать capability matrix с точным неподдерживаемым вызовом) · оценка 10 мин–15 мин · усилие 3 мин по часам · по часам 3 мин · волна 5 · зависит: V052B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Codex: Записать capability matrix с точным неподдерживаемым вызовом. Частный результат исходного V052: Один versioned app-server JSON-RPC: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V052B.
      Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success. Это точка объединения всей цепочки V052A, V052B, V052.
      Затрагиваемые файлы: `acceptance/contracts/codex.md`
      Результат: Codex native route/capability matrix recorded in acceptance/contracts/codex.md on isolated worktree. Live: initialize/initialized, thread/start, turn/start, turn/completed, thread/read; exact same turn ref ties unique input and fixture answer, V052B evidence cited. Read-only unsupported request tasks/list returned JSON-RPC -32600 unknown variant. Declared but unverified: thread/list, turn/steer, turn/interrupt. Explicitly separates app-server JSON-RPC from Herder public MCP 2026-07-28 and preserves the removable translator boundary. No adapter/MCP/install/consumer proof claimed.
  - V061 · ✅ Готово · (OpenCode: Записать capability matrix с точным неподдерживаемым вызовом) · оценка 10 мин–15 мин · усилие 3 мин по часам · по часам 3 мин · волна 5 · зависит: V061B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: OpenCode: Записать capability matrix с точным неподдерживаемым вызовом. Частный результат исходного V061: Один versioned HTTP/events: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V061B.
      Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success. Это точка объединения всей цепочки V061A, V061B, V061.
      Затрагиваемые файлы: `acceptance/contracts/opencode.md`
      Результат: OpenCode 2.2.4 capability matrix recorded in acceptance/contracts/opencode.md from authenticated server-generated OpenAPI 3.1.0 and isolated live proof. Confirmed POST /api/session, GET session/message/context, POST /prompt, GET /event, POST /interrupt. Exact unsupported POST /api/session/{sessionID}/prompt_async is absent from OpenAPI and returned HTTP 404. Event stream is volatile with no documented replay cursor; history reconciliation is required. Evidence: .tmp/v061b/openapi.json, .tmp/v061b/prompt-async-probe.txt, .tmp/v061b/evidence.json. Not proven: Herder adapter delivery, HumanStop/UNKNOWN preservation, public MCP.
  - V070 · ✅ Готово · (ZCode: Записать capability matrix с точным неподдерживаемым вызовом) · оценка 10 мин–15 мин · усилие 0 мин по часам · по часам 0 мин · волна 5 · зависит: V070B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: ZCode: Записать capability matrix с точным неподдерживаемым вызовом. Частный результат исходного V070: Один versioned подтверждаемый native session transport: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V070B.
      Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success. Это точка объединения всей цепочки V070A, V070B, V070.
      Затрагиваемые файлы: `acceptance/contracts/zcode.md`
      Результат: Capability matrix recorded in acceptance/contracts/zcode.md. Evidence: isolated supervisor route on ZCode CLI 0.16.9 / Server 3.17.2: authenticated host WebSocket, initialize request/response ID 1, listSessions request/response ID 2, empty profile; official-server-receipt.json and official-websocket-receipt.json in /home/roomhacker/.codex/worktrees/herder-zcode-native/agent-herder/.tmp/run-v070b-zcode. Selected route is the official supervisor /ws/host path; legacy direct stdio app-server's expected hello was not observed. Proven: startup, capability handshake, native request correlation and empty list. Unknown: nonempty transcript/recent, create, input delivery and context operations; profile intentionally has no provider and inference count is zero. The contract makes those boundaries explicit.
  - V079 · ⏸ Отложено владельцем · (ChatGPT: Записать capability matrix с точным неподдерживаемым вызовом) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V079B · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Записать capability matrix с точным неподдерживаемым вызовом. Частный результат исходного V079: Один versioned авторизованный browser profile через разрешённый маршрут: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V079B.
      Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success. Это точка объединения всей цепочки V079A, V079B, V079.
      Затрагиваемые файлы: `acceptance/contracts/chatgpt.md`
      Результат: V079A fixture готов; устаревший Vibe blocker снят прямым CDP evidence. Product transport, operations и безопасная input correlation не доказаны.
  - V080B · ✅ Готово · (ChatGPT: Связать request IDs, disconnect и время ожидания) · оценка 10 мин–15 мин · усилие 48 мин по часам · по часам 48 мин · волна 7 · зависит: V080A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: ChatGPT: Связать request IDs, disconnect и время ожидания. Частный результат исходного V080: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V080A.
      Приёмка: Получен проверяемый результат: ChatGPT: Связать request IDs, disconnect и время ожидания. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/connection.rs`
      Результат: Source/fake slice 7e15afb0 (поверх71af7987) принят просмотром diff Astra. Fake CDP disconnect/timeout возвращают OutcomeUnknown с исходным request ID; conversation fetch/Runtime.evaluate выполняются один раз, соседние IDs/context не принимаются. Автор6/6 tests, RED/GREEN и fixture bug перенесены в canonical с совпавшими SHA-256. Independent rerun не заявлен. Main integration handoff Terra; live profile и V080/V079 остаются отдельным held gate.
  - V088 · ✅ Готово · (Z.ai: Записать capability matrix с точным неподдерживаемым вызовом) · оценка 10 мин–15 мин · усилие 10 мин по часам · по часам 10 мин · волна 5 · зависит: V088B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Z.ai: Записать capability matrix с точным неподдерживаемым вызовом. Частный результат исходного V088: Один versioned авторизованный browser profile через разрешённый маршрут: operations/receipt/history/context hook. Зафиксировать sample frames и недоступные операции. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V088B.
      Приёмка: Результат — capability matrix с источником. Если нужной операции нет, dependent leaf не считается выполнимым; конкретный route/design gap записан, не выдуман success. Это точка объединения всей цепочки V088A, V088B, V088.
      Затрагиваемые файлы: `acceptance/contracts/z-ai.md`
      Результат: Capability matrix and redacted linked live receipt are published in origin/main commit c5946f4009ae27e1e178327ea44f99930c79cde5: acceptance/contracts/z-ai.md and acceptance/native/z-ai/live-rust-cdp-20261107.md. Provider/CDP source was already published by 8ce54d93 and cb011f85; no duplicate source commits. Matrix records direct CDP route, exact profile/context/account checks, read_chat endpoints, one-send/readback behavior, and the exact current adapter gap ZaiReader::list_chats() (full list not implemented; V090A). ChatGPT remains held. Reconfirmed cargo test --manifest-path crates/herder/Cargo.toml --lib adapters::: 13 passed. Linked receipt is a summary; raw chat_id was not retained.
  - R002 · ✅ Готово · (Регистрировать descriptor ресурса в каноническом storage) · оценка 10 мин–15 мин · усилие 27 мин по часам · по часам 27 мин · волна 8 · зависит: R001, V036 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Create/update resource.json с revision CAS; lookup/list по scope и правам. Никакой второй mutable DB ownership.
      Приёмка: Дубликат identity и stale revision дают исправляемую ошибку; неразрешённый descriptor не раскрывается.
      Затрагиваемые файлы: `crates/herder/src/ownership/resource.rs`
      Результат: В crates/herder/src/ownership/resource.rs реализованы register_or_update/get/list/list_by_scope поверх resource.json: стабильный storage registry guard, дубликат external_ref отвергается, revision CAS возвращает WouldBlock для stale, запись temp+fsync+rename+directory fsync. ResourceMarker обратно-совместимо расширен optional descriptor; descriptor identity проверяется на read; неразрешённые markers не видны в list/get и не claim-ятся. Проверено: unauthorized get/list отказаны, create=revision 1, update=2, дубликат и stale отказаны без мутации. На свежем origin/main: cargo test --manifest-path crates/herder/Cargo.toml ownership:: — 10 passed, 0 failed; rustup stable rustfmt по изменённым Rust-файлам; git diff --check чистый. Detached commit 79ac0b5f071e80d8a6f270471f7ba21263a6a156, передан Тере для интеграции. Не доказаны MCP/offline CLI consumer readback и цепочка R003/R004/V043/E003.
  - V009 · ✅ Готово · (Отклонять лишние поля и старые имена до вызова обработчика) · оценка 10 мин–15 мин · усилие 7 мин по часам · по часам 7 мин · волна 1 · зависит: V009B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Отклонять лишние поля и старые имена до вызова обработчика. Частный результат исходного V009: Единая декларация discovery/dispatch с oneOf schemas; actions read/mutate разделены. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V009B.
      Приёмка: tools/list совпадает с dispatch; дополнительные поля/legacy names отвергаются. Это точка объединения всей цепочки V009A, V009B, V009.
      Затрагиваемые файлы: `crates/herder/src/mcp/catalog.rs`
      Результат: Каталог 14 tools: независимый JSON Schema validator и typed dispatch согласованы на 33 ветках и вложенных extra fields, старое workspace отвергается; опубликовано 9060361c, 6 целевых тестов прошли. Подключение к установленному MCP остаётся V010.
  - V012A · ✅ Готово · (Сохранять intent и payload hash под уникальным request_key) · оценка 10 мин–15 мин · усилие 3 мин по часам · по часам 3 мин · волна 8 · зависит: V011, V008, V007 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Сохранять intent и payload hash под уникальным request_key. Частный результат исходного V012: Unique principal/target/request_key + payload hash и CAS prepared→dispatching. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V011, V008, V007.
      Приёмка: Получен проверяемый результат: Сохранять intent и payload hash под уникальным request_key. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/store/intents.rs`
      Результат: Атомарный prepare сохраняет task и intent по principal/target/request_key, повтор с тем же hash возвращает прежний ID, другой — Conflict. Опубликовано 8029724a; 32 unit tests прошли. Hash должен вычисляться доверенным application слоем; native submit и CAS пока не реализованы.
  - V018A · ⏸ Отложено владельцем · (Отдавать изменения по фильтру с ограниченной очередью) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V017 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Отдавать изменения по фильтру с ограниченной очередью. Частный результат исходного V018: subscriptions/listen filters; drop→snapshot, без SSE replay. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V017.
      Приёмка: Получен проверяемый результат: Отдавать изменения по фильтру с ограниченной очередью. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/mcp/subscriptions.rs`
  - V019A · ⏸ Отложено владельцем · (Отдавать единый Skills manifest и content hash) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V017 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Отдавать единый Skills manifest и content hash. Частный результат исходного V019: skills/list/get и resources/read с digest; directoryRead не объявлен. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V017.
      Приёмка: Получен проверяемый результат: Отдавать единый Skills manifest и content hash. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/mcp/skills.rs`
  - V029A · ✅ Готово · (Нормализовать transcript blocks с ссылкой на исходник) · оценка 10 мин–15 мин · усилие 7 мин по часам · по часам 7 мин · волна 8 · зависит: V028 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Нормализовать transcript blocks с ссылкой на исходник. Частный результат исходного V029: Нормализованные blocks, raw ref и подписанный/привязанный snapshot cursor. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V028.
      Приёмка: Получен проверяемый результат: Нормализовать transcript blocks с ссылкой на исходник. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/domain/transcript.rs`, `crates/herder/src/lib.rs`
      Результат: Добавлены TranscriptSourceRef, TranscriptBlock, TranscriptBlockKind, RawTranscriptBlock и pure normalize_transcript_blocks; domain module экспортирован. Native OpenCode V061B message IDs/text сохранены, порядок/индекс блока проверены, opaque types не выдают текст, отсутствующий turn остаётся None. 3 targeted tests passed. Scoped commit a0875873 (crates/herder/src/domain/transcript.rs, crates/herder/src/lib.rs).
  - V033 · ✅ Готово · (Проверить stale CAS и отличить desired от applied) · оценка 10 мин–15 мин · усилие 1 мин по часам · по часам 1 мин · волна 1 · зависит: V033B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Проверить stale CAS и отличить desired от applied. Частный результат исходного V033: Node/instance/session settings поддерживаются только при capability, typed patches. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V033B.
      Приёмка: Stale revision отвергнут; remote unavailable не applied; scope проверяется. Это точка объединения всей цепочки V033A, V033B, V033.
      Затрагиваемые файлы: `crates/herder/src/application/settings.rs`
      Результат: No source change needed: existing crates/herder/src/application/settings.rs at 4870992c7c5d922a8dd98cfdbcf7abbab9540600 already enforces wire-revision CAS before save, rejects stale/unsupported patches without writes, keeps desired advanced and applied unchanged on native failure, and advances applied only on success. Target types remain explicit (Node/Instance/Session) through SettingsPort. Focused offline source/fake suite: 7 passed; proof evidence/v033-settings-source-green.txt. Principal/ACL authorization and real native application are not implemented/proven by this source slice and remain integration acceptance.
  - V037A · ✅ Готово · (Создать стабильный guard и атомарный claim с nonce) · оценка 10 мин–15 мин · усилие 19 мин по часам · по часам 19 мин · волна 8 · зависит: V036 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Создать стабильный guard и атомарный claim с nonce. Частный результат исходного V037: Claim/renew/release с UUID epoch, atomic rename/unlink+fsync, CAS claim ID. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V036.
      Приёмка: Получен проверяемый результат: Создать стабильный guard и атомарный claim с nonce. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/ownership/claim.rs`
      Результат: 2b6830eb интегрирован как 0a28eafc, экспорт ownership::claim в 1b6905b1; 5 ownership тестов прошли. MCP/CLI и гонка ещё не доказаны.
  - V053A · ✅ Готово · (Codex: Открыть соединение конкретного instance) · оценка 10 мин–15 мин · усилие 8 мин по часам · по часам 8 мин · волна 8 · зависит: V052 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Codex: Открыть соединение конкретного instance. Частный результат исходного V053: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V052.
      Приёмка: Получен проверяемый результат: Codex: Открыть соединение конкретного instance. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/connection.rs`
      Результат: Added crates/herder/src/adapters/codex/connection.rs and acceptance/contracts/codex.md in commit c30bd5b5, rebased onto fresh origin/main 9060361c. CodexInstance makes instance ID, executable, CODEX_HOME and cwd explicit; CodexConnection owns one app-server child and stdio pipes, clears inherited environment and fixes HOME/CODEX_HOME to the selected profile, exposes process/profile identity, and kills/reaps the child on drop. Standalone rustc harness passed 2/2 in a loopback-only network namespace: rejects empty instance before spawn, starts official Codex app-server for the selected isolated profile, verifies process CODEX_HOME/HOME and no OPENAI_API_KEY, then verifies child is reaped. Evidence: /home/roomhacker/.codex/worktrees/herder-codex-native/agent-herder/.tmp/v052b-codex-profile-20261107/connection-build.log and connection-smoke.log. Full Cargo integration not yet proven because core-owned lib.rs wiring is pending Terra.
  - V062A · ✅ Готово · (OpenCode: Открыть соединение конкретного instance) · оценка 10 мин–15 мин · усилие 10 мин по часам · по часам 10 мин · волна 8 · зависит: V061 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: OpenCode: Открыть соединение конкретного instance. Частный результат исходного V062: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V061.
      Приёмка: Получен проверяемый результат: OpenCode: Открыть соединение конкретного instance. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/connection.rs`
      Результат: Добавлен crates/herder/src/adapters/opencode/connection.rs, commit 5583e0c8. OpenCodeConnection::open привязывает endpoint/auth к явному InstanceRef и делает только GET openapi.json; запрещает userinfo/query/fragment и проверяет session list/create + event route. Compile и live handshake прошли в временной копии crate с reqwest 0.12, default-features=false, features=json,rustls-tls; отдельный OpenCode 2.2.4 подтвердил OpenAPI 3.1.0 и все три маршрута. Evidence: .tmp/v062a-runtime/probe.json. Общие Cargo.toml/Cargo.lock/lib.rs не менял; интеграционный compile в основном crate ожидает центрального wiring Terra.
  - V071A · ✅ Готово · (ZCode: Открыть соединение конкретного instance) · оценка 10 мин–15 мин · усилие 14 мин по часам · по часам 14 мин · волна 8 · зависит: V070 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: ZCode: Открыть соединение конкретного instance. Частный результат исходного V071: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V070.
      Приёмка: Получен проверяемый результат: ZCode: Открыть соединение конкретного instance. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/connection.rs`
      Результат: Добавлен ZcodeConnection для одного явного ZcodeInstance и подтверждён live attach: status/token из выбранного server_root, host capability, authenticated /ws/host, native initialize frame. Реализация в crates/herder/src/adapters/zcode/connection.rs, commit dfd17b9a; live evidence /home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-herder-native-mcp-breaking/evidence/V071B/zcode-rust-connection.json. cargo check прошёл. Центральная wiring-интеграция Cargo.toml/lib.rs остаётся отдельным незакоммиченным WIP владельца этих файлов.
  - V080 · ⏸ Отложено владельцем · (ChatGPT: Проверить изоляцию подключения и ошибку доступа) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V080B, V079 · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Проверить изоляцию подключения и ошибку доступа. Частный результат исходного V080: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V080B.
      Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю. Это точка объединения всей цепочки V080A, V080B, V080.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/connection.rs`
  - V081A · ⏸ Отложено владельцем · (ChatGPT: Прочитать native список и устойчивые session IDs) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V080A, V028 · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT source/fake direct-CDP list route: переиспользовать старый рабочий read-only список, вернуть устойчивые conversation IDs с honest pagination/partial; live profile gate проверяется в итоговом V081.
      Приёмка: Fake endpoint подтверждает source путь и exact context/account, устойчивые IDs, continuation/partial и descriptive unavailable. Нет create/send и обращения к live профилю; source commit/evidence отдельно от native proof.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/read.rs`, `crates/herder/src/adapters/chatgpt/mod.rs`
      Результат: Existing ChatGPT source route/fixture confirmed in src/adapters/browser-chat-api-scripts.ts and tests/chatgpt-request-trace.test.ts. Added ChatGptReader::list_conversations in crates/herder/src/adapters/chatgpt/read.rs (module wiring in mod.rs), using observed same-origin /backend-api/conversations?offset={offset}&limit=100&order=updated. Fake direct-CDP covers exact pinned target/context/account, two pages with stable native IDs, provider-backed cursor/partial, account-scope change rejection and descriptive HTTP 503. Commit 0bbfbb2812586de9531eca8222582599d8e5302b; focused command cargo test --manifest-path crates/herder/Cargo.toml adapters::chatgpt -- --nocapture; 14 passed / 0 failed. No live profile/create/send.
  - V089A · ✅ Готово · (Z.ai: Открыть соединение конкретного instance) · оценка 10 мин–15 мин · усилие не измерено · волна 8 · зависит: V088 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Z.ai: Открыть соединение конкретного instance. Частный результат исходного V089: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V088.
      Приёмка: Получен проверяемый результат: Z.ai: Открыть соединение конкретного instance. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/cdp.rs`, `crates/herder/src/adapters/zai/mod.rs`
      Результат: Z.ai attach работает через CdpConnection::connect_browser/attach_target с явными node_id, instance_id, browser_context_id и target_id; ZaiReader использует выбранный target/context и проверяет account scope. Источники: V088C live Rust CDP receipt в acceptance/native/z-ai/live-rust-cdp-20261107.md и implementation в origin/main c5946f40. Никаких новых provider действий не выполнялось. Не доказано: live подключение ко второму соседнему профилю.
  - R003A · ✅ Готово · (Связать resource list/get с одним каноническим storage) · оценка 15 мин · усилие 16 мин по часам · по часам 16 мин · волна 9 · зависит: R002, V008 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Независимая часть R003: тонкий application facade над ownership::resource::list/get. Явная Authorization и StorageAuthority; без новых store/cache и без правки общего MCP transport.
      Приёмка: Application list/get читает существующий resource.json/owner.json; unauthorized доступ отклонён; availability отделена от ownership; отключение/reconnect не освобождают claim. Проверка MCP consumer остаётся в R003.
      Затрагиваемые файлы: `crates/herder/src/application/resource.rs`
      Результат: R003A refinement commit ef9c7f6329661a0da20d827872f4d3c8380c1fd0 (after b1394245), only crates/herder/src/application/resource.rs. list now collects/sorts/deduplicates exact Resource refs from this principal's Read grants and calls registry::get only for those; all errors for granted refs propagate, including missing ref NotFound. RED/GREEN bug Be3f2c5430c2b4ffa8f55: unauthorized corrupt marker made list fail (RED exit 101); fixed same focused tests 3 passed. Added available→unavailable→available CAS updates while changing node; ID and list/get visibility persist; owner.json bytes unchanged each step. Tests ran in isolated crate copy with temporary module export because integration-owned lib.rs stayed untouched. rustfmt +stable check and scoped diff --check pass. MCP/CLI consumer still unproven.
  - T004 · ⋯ В очереди · (Перевести предметные tools и результаты без повторного исполнения) · оценка 10 мин–15 мин · усилие не измерено · ждёт: причина не названа · волна 9 · зависит: T003, V009 · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Проксировать обычный tools/call через существующий SDK edge и upstream tools/list. Сохранить request_key, typed diagnostic и isError. Проверка fake upstream counter=1 при потерянном ответе; no private job store и no retry.
      Приёмка: 14 schemas и результат/effect/retry/request_key сохраняются; нет второго intent или старого job API.
      Затрагиваемые файлы: `crates/herder-compat/`, `acceptance/compat/`
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:12:51+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b341-e06b-7583-8fd4-352423ca22cb
      Плановая модель: gpt-6-astra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; ждёт зависимостей (dependencies_unmet)
      Незавершённые зависимости: T003
      Причина ожидания / доставки: не записана
  - V010A1 · ✅ Готово · (Передать проверенный stdio запрос в application) · оценка 15 мин · усилие 5 мин по часам · по часам 5 мин · волна 9 · зависит: V009, V008 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Довести оставшийся стык V010A: typed request после metadata и identity binding передаётся в application port; отсутствующий handler остаётся явным безопасным отказом.
      Приёмка: Wire test с injected application подтверждает единственный вызов для корректного запроса; лишние поля/version/unknown caller не вызывают закрытый handler и не создают effect.
      Затрагиваемые файлы: `crates/herder/src/mcp/transport.rs`
      Результат: Injected application port подключён к typed stdio dispatch ca6b8c91; wire test: read вызывает fake handler, invalid version/extra fields/unknown caller mutation не создают effect. Штатный binary пока без application и возвращает unsupported.
  - V012B · ✅ Готово · (Атомарно назначать единственного отправителя через CAS) · оценка 10 мин–15 мин · усилие 8 мин по часам · по часам 8 мин · волна 9 · зависит: V012A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Атомарно назначать единственного отправителя через CAS. Частный результат исходного V012: Unique principal/target/request_key + payload hash и CAS prepared→dispatching. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V012A.
      Приёмка: Получен проверяемый результат: Атомарно назначать единственного отправителя через CAS. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/store/intents.rs`
      Результат: CAS prepared→dispatching опубликован 3ed4381a; из 8 конкурентных подключений ровно одно получает право, повтор и unknown не допускаются. Три targeted tests прошли; реальная отправка ещё не подключена.
  - V018B · ⏸ Отложено владельцем · (Восстанавливать snapshot после обрыва или переполнения) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V018A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Восстанавливать snapshot после обрыва или переполнения. Частный результат исходного V018: subscriptions/listen filters; drop→snapshot, без SSE replay. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V018A.
      Приёмка: Получен проверяемый результат: Восстанавливать snapshot после обрыва или переполнения. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/mcp/subscriptions.rs`
  - V019B · ⏸ Отложено владельцем · (Читать Skill через resource с теми же правами) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V019A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Читать Skill через resource с теми же правами. Частный результат исходного V019: skills/list/get и resources/read с digest; directoryRead не объявлен. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V019A.
      Приёмка: Получен проверяемый результат: Читать Skill через resource с теми же правами. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/mcp/skills.rs`
  - V029B · ✅ Готово · (Привязать cursor к snapshot и principal) · оценка 10 мин–15 мин · усилие 2 мин по часам · по часам 2 мин · волна 9 · зависит: V029A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Привязать cursor к snapshot и principal. Частный результат исходного V029: Нормализованные blocks, raw ref и подписанный/привязанный snapshot cursor. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V029A.
      Приёмка: Получен проверяемый результат: Привязать cursor к snapshot и principal. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/domain/transcript.rs`
      Результат: В domain/transcript.rs добавлен BoundTranscriptCursor: он сохраняет opaque native cursor и связывает его с non-empty principal_id и snapshot_id; validate отклоняет mismatch principal/snapshot и не разбирает cursor. 5 targeted transcript tests passed; rustfmt +stable --check и git diff --check прошли. Scoped commit 91a42282.
  - V037B · ✅ Готово · (Выполнять renew и release с проверкой текущего claim_id) · оценка 10 мин–15 мин · усилие 31 мин по часам · по часам 31 мин · волна 9 · зависит: V037A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Выполнять renew и release с проверкой текущего claim_id. Частный результат исходного V037: Claim/renew/release с UUID epoch, atomic rename/unlink+fsync, CAS claim ID. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V037A.
      Приёмка: Получен проверяемый результат: Выполнять renew и release с проверкой текущего claim_id. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/ownership/claim.rs`
      Результат: Добавлены renew() и release() в crates/herder/src/ownership/claim.rs. Обе операции берут стабильный guard.lock и проверяют точный claim_id; renew атомарно сохраняет новый expires_at через owner.json+fsync, release удаляет owner.json и fsync каталога. Неверный ID даёт PermissionDenied и не меняет owner. Проверка на свежем origin/main: cargo test --manifest-path crates/herder/Cargo.toml ownership:: — 6 passed, 0 failed; git diff --check чистый. Commit 1325276061f3ef0500663ec6871133223a87cb48 detached. Не доказана межпроцессная гонка claim (корневой V037).
  - V053B · ✅ Готово · (Codex: Связать request IDs, disconnect и время ожидания) · оценка 10 мин–15 мин · усилие 14 мин по часам · по часам 14 мин · волна 9 · зависит: V053A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Codex: Связать request IDs, disconnect и время ожидания. Частный результат исходного V053: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V053A.
      Приёмка: Получен проверяемый результат: Codex: Связать request IDs, disconnect и время ожидания. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/connection.rs`
      Результат: Extended crates/herder/src/adapters/codex/connection.rs in commit ace1a5d6 (rebased onto origin/main ca6b8c91). Each JSON-RPC call has a monotonic request ID; response correlation is exact, unrelated/late IDs are ignored, and notifications are retained. Timeout, partial write, malformed/read failure and disconnect carry the sent request ID and are marked outcome-unknown; no automatic retry exists. A pre-send dead process returns NotRunning. The same Cargo smoke harness passed 4/4: IDs/notification, late response after timeout followed by a new request, disconnect, malformed response. RED/GREEN compiler evidence: review-evidence/v053b-codex-connection/{red.log,green.log}; harness/outputs also in /home/roomhacker/.codex/worktrees/herder-codex-native/agent-herder/.tmp/v052b-codex-profile-20261107/. The V053 connection leaves are complete at transport layer; actual Herder crate export/integration still awaits Terra-owned lib.rs wiring.
  - V062B · ✅ Готово · (OpenCode: Связать request IDs, disconnect и время ожидания) · оценка 10 мин–15 мин · усилие 11 мин по часам · по часам 11 мин · волна 9 · зависит: V062A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: OpenCode: Связать request IDs, disconnect и время ожидания. Частный результат исходного V062: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V062A.
      Приёмка: Получен проверяемый результат: OpenCode: Связать request IDs, disconnect и время ожидания. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/connection.rs`
      Результат: OpenCodeRequest теперь сохраняет переданный request ID в response/error, ставит bounded timeout (по умолчанию 30s), не повторяет запрос; timeout и разрыв после отправки классифицируются OutcomeUnknown, только connect failure — DefinitelyNotSent. Код в crates/herder/src/adapters/opencode/connection.rs, commit 9db738f2. Scratch crate compile с reqwest 0.12 прошёл. Live OpenCode 2.2.4 GET /api/session вернул 200 и тот же request ID; 1ns read timeout дал OutcomeUnknown; task-local stub получил POST body и оборвал соединение, результат OutcomeUnknown, без retry. Evidence: .tmp/v062b-runtime/evidence.json и два probe source. Cargo/lib.rs интеграция остаётся за Terra.
  - V071B · ✅ Готово · (ZCode: Связать request IDs, disconnect и время ожидания) · оценка 10 мин–15 мин · усилие 14 мин по часам · по часам 14 мин · волна 9 · зависит: V071A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: ZCode: Связать request IDs, disconnect и время ожидания. Частный результат исходного V071: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V071A.
      Приёмка: Получен проверяемый результат: ZCode: Связать request IDs, disconnect и время ожидания. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/connection.rs`
      Результат: В connection.rs добавлен native ZCode binary RPC encode/decode, монотонные request IDs, корреляция ответов, bounded deadline и OutcomeUnknown после отправки при timeout/disconnect; close закрывает только socket. cargo check прошёл. Live Rust attach к свежему isolated ZCode Server 3.17.2: handshake принят, `zcode-agent.initialize` requestId=1 получил responseId=1/type 201, available=false, owned_process_id=None, socket закрыт; inference=0. Вторая read-only listSessions попытка получила native ошибку `ZCode Agent runtime is not running`; сессии не создавались и input не отправлялся. Независимая V070B квитанция ранее подтверждает пустой listSessions ответ на том же маршруте. Evidence: /home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-herder-native-mcp-breaking/evidence/V071B/zcode-rust-connection.json. Таймаут с искусственной задержкой, create, input и transcript остаются непроверенными. Scoped commit: dfd17b9a (только connection.rs); Cargo.toml/lib.rs wiring остаётся незакоммиченным WIP их владельца.
  - V081B · ⏸ Отложено владельцем · (ChatGPT: Нормализовать user и assistant с turn refs) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V081A · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Нормализовать user и assistant с turn refs. Частный результат исходного V081: Одна подтверждённая native read route → адреса/status/последние user+assistant. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V081A.
      Приёмка: Получен проверяемый результат: ChatGPT: Нормализовать user и assistant с turn refs. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/read.rs`, `crates/herder/src/adapters/chatgpt/mod.rs`
      Результат: Added ChatGptReader::recent_messages in crates/herder/src/adapters/chatgpt/read.rs. It projects latest user and assistant from current_node ancestry, retains message IDs/time, verifies account scope in the same page operation, follows explicit parent ancestry for reply_to_input_id, and leaves turn_id/partial unknown where the captured schema supplies no fields. Fake CDP fixture proves user-001 and assistant-final-001 relation through the intermediate analysis node; account switch is rejected. Same focused command: 14 passed / 0 failed. Source commit 0bbfbb2812586de9531eca8222582599d8e5302b. Live profile/send remains unverified and held for V081/V080.
  - V089B · ✅ Готово · (Z.ai: Связать request IDs, disconnect и время ожидания) · оценка 10 мин–15 мин · усилие не измерено · волна 9 · зависит: V089A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Z.ai: Связать request IDs, disconnect и время ожидания. Частный результат исходного V089: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V089A.
      Приёмка: Получен проверяемый результат: Z.ai: Связать request IDs, disconnect и время ожидания. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/cdp.rs`
      Результат: CdpConnection использует возрастающий next_id, ждёт ответ только с соответствующим ID, ограничивает ожидание request_timeout; после send disconnect/timeout возвращает OutcomeUnknown и автоматически не повторяет команду. Предыдущая проверка: 13 Rust adapter tests + 11 изолированных CDP harness tests прошли (из предыдущего выполнения задачи; provider prompts harness не отправлял). Source: crates/herder/src/adapters/cdp.rs; обобщённый transport gate V079C. Не выполнен новый тестовый прогон в этой сессии.
  - V107A · ✅ Готово · (Hub: найти один вызывающий Herder маршрут и владельца путей) · оценка 10 мин–15 мин · усилие не измерено · волна 9 · зависит: V009, V003 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Hub: найти один вызывающий Herder маршрут и владельца путей. Частный результат исходного V107: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V009, V003.
      Приёмка: Получен проверяемый результат: Hub: найти один вызывающий Herder маршрут и владельца путей. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `integrations/consumers/hub/target.json`
      Результат: Подготовлена owner/source-route информация, потреблённая V107: commit ce46aa12b4b793c818edb00ef80010dd81e984b6 опубликовал integrations/consumers/hub/target.json с владельцем GPTAdmin, точными caller/dispatch символами, webhook→shell→Herder MCP route и mock-only границей. V107 провалидировал и опубликовал этот target. Private route command/cwd/runtime auth не подтверждены; событие не отправлялось.
  - V110A · ✅ Готово · (LHC: найти один вызывающий Herder маршрут и владельца путей) · оценка 10 мин–15 мин · усилие 5 мин по часам · по часам 5 мин · волна 9 · зависит: V009, R001 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: LHC: найти один вызывающий Herder маршрут и владельца путей. Частный результат исходного V110: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V009, R001.
      Приёмка: Получен проверяемый результат: LHC: найти один вызывающий Herder маршрут и владельца путей. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `integrations/consumers/lhc/target.json`
      Результат: Записан и закоммичен в Agent Herder `integrations/consumers/lhc/target.json` (commit 4a10fe9e). Установленный Last Human Commit 1.15.1 вызывает `lhc_plan_ui.herder_panel(tasks)` из `lhc_plan_publish.publish(...)`; исходный владелец — megamen32, репозиторий megamen32/LastHumanCommit, наблюдавшийся checkout commit 6198a0fc6583d36fd2add22360ccb32c2cc37c88. SHA-256 `lhc_plan_ui.py` и `lhc_plan_publish.py` совпадает между installed 1.15.1 и source checkout; метаданные source plugin показывают 1.7.20. Точный тестовый маршрут записан: `pytest -q tests/test_plan_publish.py -k herder_panel`; команда не запускалась, это маршрут теста, а не доказательство live consumer. JSON валиден и перечисленные source/test пути существуют. Изменён только target.json; runtime LHC и settings apply не тронуты.
  - R003 · ⏸ Отложено владельцем · (Публиковать resource list/get и наблюдаемый маршрут подключения) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: R002, V017, R003A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Стандартные MCP resource чтения используют общий descriptor; available, unavailable, unknown отдельно от owner.
      Приёмка: Отключённый телефон остаётся в списке; reconnect не освобождает владельца; ACL применяется к маршруту.
      Затрагиваемые файлы: `crates/herder/src/application/resource.rs`
  - T005 · ⋯ В очереди · (Отобразить стандартный Task в compat_task get) · оценка 10 мин–15 мин · усилие не измерено · ждёт: причина не названа · волна 10 · зависит: T004 · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Подключить существующий compat_task get к upstream стандартному Task get/result: точный task ref и caller ACL, без второго lifecycle. Проверка completed/working/error и чужогоTask через SDK fixture. Input/cancel/Skills/subscriptions остаются обязательными в S01, не блокируют первый get.
      Приёмка: Принятие возвращает origin ref, get читает тот же upstream Task; completed отдельно от tool error.
      Затрагиваемые файлы: `crates/herder-compat/`, `acceptance/compat/`
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:12:54+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b341-e06b-7583-8fd4-352423ca22cb
      Плановая модель: gpt-6-astra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; ждёт зависимостей (dependencies_unmet)
      Незавершённые зависимости: T004
      Причина ожидания / доставки: не записана
  - V010A2 · ⏸ Отложено владельцем · (Подключить конфигурацию и первый реальный read handler) · оценка 15 мин · усилие не измерено · вне остатка · зависит: V010A1 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Привязать штатный stdio binary к application с конфигурацией и настоящим read-only discover nodes; закрытые операции без доверенного caller не выполнять.
      Приёмка: Отдельный stdio процесс читает тестовую конфигурацию и через discover nodes возвращает её ноды; неподключённые мутации дают effect=none и не вызывают native actions.
      Затрагиваемые файлы: `crates/herder/src/application`, `crates/herder/src/bin/herder_native_stdio.rs`
      Результат: Опубликован 7362a275: конфигурация stdio и fail-closed node discovery; 2 ACL теста и отдельный stdio прошли; injected principal не доказывает trusted launcher.
  - V012 · ✅ Готово · (Проверить гонку дубликатов и конфликт payload без второго submit) · оценка 10 мин–15 мин · усилие 6 мин по часам · по часам 6 мин · волна 1 · зависит: V012B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Проверить гонку дубликатов и конфликт payload без второго submit. Частный результат исходного V012: Unique principal/target/request_key + payload hash и CAS prepared→dispatching. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V012B.
      Приёмка: Два одновременных обработчика вызывают fake submit один раз; conflict payload отклоняется. Это точка объединения всей цепочки V012A, V012B, V012.
      Затрагиваемые файлы: `crates/herder/src/store/intents.rs`
      Результат: Тест 8 конкурентных duplicate prepare: одна task/intent и один claim, другой payload конфликтует, unknown не replay; опубликован 5a099a0c, 4 целевых теста прошли. Native submit ещё не подключён.
  - V018 · ⏸ Отложено владельцем · (Проверить медленного подписчика без блокировки других клиентов) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V018B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить медленного подписчика без блокировки других клиентов. Частный результат исходного V018: subscriptions/listen filters; drop→snapshot, без SSE replay. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V018B.
      Приёмка: Медленный клиент не блокирует ноду; reconnect видит current revision без дублирования эффектов. Это точка объединения всей цепочки V018A, V018B, V018.
      Затрагиваемые файлы: `crates/herder/src/mcp/subscriptions.rs`
  - V019 · ⏸ Отложено владельцем · (Проверить границы manifest и отсутствие ложной activation) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V019B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить границы manifest и отсутствие ложной activation. Частный результат исходного V019: skills/list/get и resources/read с digest; directoryRead не объявлен. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V019B.
      Приёмка: Проверены manifest boundary, приватность и content hash; read не объявляет activation. Это точка объединения всей цепочки V019A, V019B, V019.
      Затрагиваемые файлы: `crates/herder/src/mcp/skills.rs`
  - V029 · ✅ Готово · (Проверить последнюю страницу и чужой cursor) · оценка 10 мин–15 мин · усилие 3 мин по часам · по часам 3 мин · волна 1 · зависит: V029B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Проверить последнюю страницу и чужой cursor. Частный результат исходного V029: Нормализованные blocks, raw ref и подписанный/привязанный snapshot cursor. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V029B.
      Приёмка: Чужой cursor отвергнут; последняя страница, truncation и snapshot boundary проверены. Это точка объединения всей цепочки V029A, V029B, V029.
      Затрагиваемые файлы: `crates/herder/src/domain/transcript.rs`
      Результат: Добавлен TranscriptPage: отсутствие next_cursor завершает страницу; truncation сохраняется независимо. native_cursor_for отклоняет principal/snapshot mismatch, а пустой native cursor отвергается при bind. 7 transcript tests passed. Codex cross-check использует только paired fixture /home/roomhacker/.codex/worktrees/herder-codex-native/agent-herder/.tmp/v052b-codex-profile-20261107/{proof.json,native-transcript.jsonl}; native IDs/text/turn совпали, reply link не выводился. Scoped commit a36520d7.
  - V037 · ✅ Готово · (Проверить гонку MCP и CLI с одним победителем) · оценка 10 мин–15 мин · усилие 2 мин по часам · по часам 2 мин · волна 2 · зависит: V037B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Проверить гонку MCP и CLI с одним победителем. Частный результат исходного V037: Claim/renew/release с UUID epoch, atomic rename/unlink+fsync, CAS claim ID. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V037B.
      Приёмка: Concurrent claims имеют одного победителя; release чужого ID denied; нет state.json transaction. Это точка объединения всей цепочки V037A, V037B, V037.
      Затрагиваемые файлы: `crates/herder/src/ownership/claim.rs`
      Результат: В V037A/B добавлены claim/renew/release с UUID claim_id, стабильным guard.lock, атомарным owner.json и CAS по владельцу. В V037 добавлен конкурентный тест: два параллельных callers; наблюдаем ровно один Acquired и один Busy; release чужого ID даёт PermissionDenied, guard inode сохраняется, state.json transaction отсутствует. На свежем origin/main после V037A: cargo test --manifest-path crates/herder/Cargo.toml ownership:: — 7 passed, 0 failed; git diff --check чистый. Scoped commits detached: V037B 1325276061f3ef0500663ec6871133223a87cb48, V037 concurrency 5f2e18f0fd2bcd7bfcf564574ab9dd924b2748d5. Не доказаны MCP и offline CLI consumer integration; следующий результат требует R002/E003.
  - V053 · ✅ Готово · (Codex: Проверить изоляцию подключения и ошибку доступа) · оценка 10 мин–15 мин · усилие 3 мин по часам · по часам 3 мин · волна 5 · зависит: V053B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Codex: Проверить изоляцию подключения и ошибку доступа. Частный результат исходного V053: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V053B.
      Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю. Это точка объединения всей цепочки V053A, V053B, V053.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/connection.rs`
      Результат: Root V053 acceptance passes. On the connection code from V053A/B, the isolated Cargo harness passed five tests including a bad explicit CODEX_HOME while a separate neighboring profile directory exists: returns OpenError::DirectoryUnavailable for the selected profile and does not execute a marker executable, proving no spawn/fallback. It also reruns request-ID, notification, timeout/late response, disconnect and malformed-response scenarios. Evidence: /home/roomhacker/.codex/worktrees/herder-codex-native/agent-herder/.tmp/v052b-codex-profile-20261107/v053-isolation-smoke-green.log. V053 transport code and separate commits 695f1063/ace1a5d6 are present atop latest origin/main; end-to-end Herder MCP/install remains unproven.
  - V062 · ✅ Готово · (OpenCode: Проверить изоляцию подключения и ошибку доступа) · оценка 10 мин–15 мин · усилие 3 мин по часам · по часам 3 мин · волна 5 · зависит: V062B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: OpenCode: Проверить изоляцию подключения и ошибку доступа. Частный результат исходного V062: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V062B.
      Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю. Это точка объединения всей цепочки V062A, V062B, V062.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/connection.rs`
      Результат: Цепочка V062 завершена commit 5583e0c8 + 9db738f2. Explicit instance/profile connection прошла на OpenCode 2.2.4; неверная auth вернула Unauthorized, недоступный endpoint вернул Transport без fallback на другой instance. Request ID, 30s bound, timeout/disconnect OutcomeUnknown и отсутствие retry доказаны V062B. Evidence: .tmp/v062a-runtime/probe.json, .tmp/v062b-runtime/evidence.json, .tmp/v062-runtime/evidence.json. Compile/live checks проходили в scratch crate с reqwest 0.12; основной crate compile ожидает добавления reqwest/export Terra.
  - V071 · ✅ Готово · (ZCode: Проверить изоляцию подключения и ошибку доступа) · оценка 10 мин–15 мин · усилие не измерено · волна 5 · зависит: V071B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: ZCode: Проверить изоляцию подключения и ошибку доступа. Частный результат исходного V071: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V071B.
      Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю. Это точка объединения всей цепочки V071A, V071B, V071.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/connection.rs`
      Результат: Two temporary ZCode 3.17.2 supervisor instances with independent HOME/XDG/server_root reached ready on distinct loopback ports and attached through the Rust ZcodeConnection. Native initialize response ID matched request ID on both. Replacing only A's isolated ingress token caused CapabilityUnavailable; a nonexistent instance root caused ProfileUnavailable; the already-connected B socket remained Connected and healthy. Both profiles had initialize.available=false; no session was created and no input/inference was sent. All created runtime process groups and temporary profiles were stopped/removed. Evidence: /home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-herder-native-mcp-breaking/evidence/V071/zcode-two-instance-isolation.json. Limitation: network namespace creation is denied on this host; verification used loopback-only listeners and credential-free temporary profiles. Adapter source is commit dfd17b9a; Cargo/lib wiring remains uncommitted WIP owned by its central integrator.
  - V081 · ⏸ Отложено владельцем · (ChatGPT: Сверить recent с независимым native чтением) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V081B, V080 · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Сверить recent с независимым native чтением. Частный результат исходного V081: Одна подтверждённая native read route → адреса/status/последние user+assistant. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V081B.
      Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен. Это точка объединения всей цепочки V081A, V081B, V081.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/read.rs`
  - V089 · ✅ Готово · (Z.ai: Проверить изоляцию подключения и ошибку доступа) · оценка 10 мин–15 мин · усилие не измерено · волна 5 · зависит: V089B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Z.ai: Проверить изоляцию подключения и ошибку доступа. Частный результат исходного V089: Подключение explicit profile; timeout/shutdown; process/socket state в одном объекте. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V089B.
      Приёмка: Неверный profile/endpoint даёт unavailable; нет подключения к соседнему профилю. Это точка объединения всей цепочки V089A, V089B, V089.
      Затрагиваемые файлы: `crates/herder/src/adapters/cdp.rs`, `crates/herder/src/adapters/zai/mod.rs`, `acceptance/contracts/z-ai.md`, `acceptance/native/z-ai/live-rust-cdp-20261107.md`
      Результат: Изоляция Z.ai реализована explicit browser endpoint + browser context + target; attach проверяет target/context, account scope сверяется внутри страницы; invalid endpoint/identity/context отклоняются. V088C live receipt подтверждает attach к выбранному target/context и отсутствие закрытия чужих targets. Ошибки disconnect/timeout после отправки остаются OutcomeUnknown без retry. На момент проверки: 13 Rust adapter tests и 11 изолированных CDP harness tests ранее прошли. Ограничение: live attach к отдельному соседнему Chrome профилю не выполнялся; это не заявляется. Public MCP/installed consumer acceptance отдельно не доказан.
  - V107 · ✅ Готово · (Hub: записать target.json с точным контрактом и тестовым маршрутом) · оценка 10 мин–15 мин · усилие не измерено · волна 8 · зависит: V107A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Hub: записать target.json с точным контрактом и тестовым маршрутом. Частный результат исходного V107: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V107A.
      Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции. Это точка объединения всей цепочки V107A, V107.
      Затрагиваемые файлы: `integrations/consumers/hub/target.json`
      Результат: Каноническая запись восстановлена: integrations/consumers/hub/target.json провалидирован; контент и маршрут были опубликованы commit ce46aa12b4b793c818edb00ef80010dd81e984b6. Описаны endpoint → Hub shell action → scripts/agent_deliver.py → Herder MCP deliver, exact caller paths и mock-only test boundary. Live route summary read-only; event не отправлялся. Полный private command/cwd/runtime auth state не подтверждены.
  - V110 · ✅ Готово · (LHC: записать target.json с точным контрактом и тестовым маршрутом) · оценка 10 мин–15 мин · усилие не измерено · волна 8 · зависит: V110A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: LHC: записать target.json с точным контрактом и тестовым маршрутом. Частный результат исходного V110: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V110A.
      Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции. Это точка объединения всей цепочки V110A, V110.
      Затрагиваемые файлы: `integrations/consumers/lhc/target.json`
      Результат: Обновлён и закоммичен `integrations/consumers/lhc/target.json` (4a10fe9e, уточнение контракта — 9b9e546b). Зафиксирован integration_kind=ui_deeplink, exact reference `harness:nativeSessionId`, URL с `?from=lhc` и URL-encoding полного reference. Указано, что `src/common/tools/lhc_plan_ui.py` и `lhc_plan_publish.py` — исходные writable пути владельца megamen32, пакетные пути generated. Точный заданный тест `pytest -q tests/test_plan_publish.py -k herder_panel` завершён: 6 passed, 26 deselected. По Herder source `sessionKeyFromHash` декодирует route reference, `isFleetSessionLink` включает fleet-aware resolution для from=lhc, `resolveSessionDeepLink` не угадывает отсутствующую/неоднозначную identity; host-specific mesh form не выдаётся LHC. Поэтому LHC API bridge не нужен; V111A передан как совместимость/no-op gate. Live browser readback не заявляется. Изменялся только target.json; LHC runtime/settings не менялись.
  - T006 · ⏸ Отложено владельцем · (Передать ответ Task input через compat_task answer) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: T005 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Реализовать только этот проверяемый шаг по COMPATIBILITY.md. Входы: T005. При неизвестном SDK/consumer маршруте сначала назвать минимальный пробел; не форкать Codex.
      Приёмка: Ответ точному pending input вызывает standard update один раз; повтор key не продолжает дважды.
      Затрагиваемые файлы: `crates/herder-compat/`, `acceptance/compat/`
  - T007 · ⏸ Отложено владельцем · (Передать Task cancel с честным исходом эффекта) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: T005 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Реализовать только этот проверяемый шаг по COMPATIBILITY.md. Входы: T005. При неизвестном SDK/consumer маршруте сначала назвать минимальный пробел; не форкать Codex.
      Приёмка: Standard cancel вызывается для нужного Task; cancel не выдаётся за остановленный effect.
      Затрагиваемые файлы: `crates/herder-compat/`, `acceptance/compat/`
  - T010 · ⋯ В очереди · (Проверить restart translator и UNKNOWN без proxy jobs) · оценка 10 мин–15 мин · усилие не измерено · ждёт: причина не названа · волна 11 · зависит: T005 · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Перезапустить только translator над существующим upstream Task. Повторное чтение того же результата не создаёт новую работу; один upstream effect и правильный UNKNOWN. Это минимальный restore/get proof; полный input/cancel proof остаётся AC02/AC03, не объявлять весь translator готовым.
      Приёмка: После разрыва читается origin Task; второй durable store и повтор send отсутствуют.
      Затрагиваемые файлы: `crates/herder-compat/`, `acceptance/compat/`
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:12:57+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b341-e06b-7583-8fd4-352423ca22cb
      Плановая модель: gpt-6-astra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; ждёт зависимостей (dependencies_unmet)
      Незавершённые зависимости: T005
      Причина ожидания / доставки: не записана
  - V010A · ⏸ Отложено владельцем · (Подключить stdio к application и проверке metadata) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V010A2 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подключить stdio к application и проверке metadata. Частный результат исходного V010: Транспорт SDK, обязательная request metadata, shutdown; application entrypoint. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V009, V003, V008.
      Приёмка: Получен проверяемый результат: Подключить stdio к application и проверке metadata. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/mcp/transport.rs`
      Результат: Native stdio endpoint опубликован 514b46e6: discover/list/typed validation, 14 tools и safe unsupported подтверждены wire. Metadata клиента не даёт identity; все application операции пока отключены — подключение реального application handler и binding ещё не выполнено.
  - V015A · ✅ Готово · (Сопоставить dispatching intent с точной native квитанцией) · оценка 10 мин–15 мин · усилие 10 мин по часам · по часам 10 мин · волна 11 · зависит: V012, V006 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Сопоставить dispatching intent с точной native квитанцией. Частный результат исходного V015: Restart dispatcher читает native receipt по стабильной корреляции, без send. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V012, V006.
      Приёмка: Получен проверяемый результат: Сопоставить dispatching intent с точной native квитанцией. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/reconcile.rs`
      Результат: Опубликованы 3636adda и 67aebe8b: read-only reconciliation по точному адресу и native ID подключён к библиотеке; targeted test прошёл. Restart dispatcher и native reader ещё не подключены.
  - V022A · ✅ Готово · (Сохранять creator и request_ref в create intent) · оценка 10 мин–15 мин · усилие 13 мин по часам · по часам 13 мин · волна 11 · зависит: V012 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Сохранять creator и request_ref в create intent. Частный результат исходного V022: Создатель в create intent, native parent и происхождение отдельно. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V012.
      Приёмка: Получен проверяемый результат: Сохранять creator и request_ref в create intent. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/store/lineage.rs`, `crates/herder/src/store/mod.rs`
      Результат: Опубликован коммит 58ecc1d928843946a7da81af64c1accfa8acbe0d в origin/main (fast-forward от 554b7182). crates/herder/src/store/lineage.rs добавляет NewCreateLineageIntent и Writer::prepare_create_lineage_intent, сохраняющие creator_ref/request_ref до native side effect через существующий atomic prepare_intent; crates/herder/src/store/mod.rs экспортирует API. Проверка: cargo test -p herder store::lineage::tests::create_intent_persists_creator_and_request_ref_before_dispatch — 1 passed (после rebase). Удалённый main подтверждён на 58ecc1d9; worktree чистый. Не доказано: MCP/установленный consumer acceptance.
  - V030A · ✅ Готово · (Добавлять изменённую сессию в SQLite FTS по cursor) · оценка 10 мин–15 мин · усилие 24 мин по часам · по часам 24 мин · волна 11 · зависит: V029, V011 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Добавлять изменённую сессию в SQLite FTS по cursor. Частный результат исходного V030: SQLite FTS и source cursors; обновление только изменённой сессии. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V029, V011.
      Приёмка: Получен проверяемый результат: Добавлять изменённую сессию в SQLite FTS по cursor. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/search/index.rs`
      Результат: Source-only module committed as 0342d129 on fresh origin/main base 0d9582c250835e71250ffc0abcfef59c6f62cc98: crates/herder/src/search/index.rs. API uses full SessionAddress identity and TranscriptPage.snapshot_id for the complete searchable snapshot (not native page cursor); equal snapshot skips, changed snapshot atomically replaces one session's FTS row/state. Isolated rusqlite harness: 7 passed (4 index + 3 address). Evidence: review-evidence/v030a/unit-green.log. Not integrated: Terra owns lib/export and v4 schema/writer fence; no production, installed, or consumer proof. Parent V030 remains open.
  - V038A · ✅ Готово · (Ввести сбои вокруг rename и fsync при claim) · оценка 10 мин–15 мин · усилие 11 мин по часам · по часам 11 мин · волна 11 · зависит: V037 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Ввести сбои вокруг rename и fsync при claim. Частный результат исходного V038: Fault injection до/после rename/unlink/fsync; leftover temp cleanup под lock. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V037.
      Приёмка: Получен проверяемый результат: Ввести сбои вокруг rename и fsync при claim. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `tests/ownership/crash.rs`
      Результат: В claim.rs добавлены cfg(test)-only fault points до rename, после rename, до и после directory fsync; тесты находятся в crates/herder/tests/ownership/crash.rs как вложенный unit-test module. До rename: owner.json отсутствует, temp-файл удалён, повтор с тем же nonce получает Acquired. После rename/около directory fsync: owner целый, temp отсутствует, replay того же nonce даёт AlreadyOwned. Проверка: cargo test --manifest-path crates/herder/Cargo.toml claim::crash_tests:: — 2 passed, 0 failed. Commit 1268b86a381f0ae4dea543c23c18e55a82127b3c detached, diff-check чистый.
  - V039A · ✅ Готово · (Добавить offline status и claim через общую библиотеку) · оценка 10 мин–15 мин · усилие 36 мин по часам · по часам 36 мин · волна 11 · зависит: V037 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Добавить offline status и claim через общую библиотеку. Частный результат исходного V039: herder ownership без запуска daemon/SQLite/MCP; JSON и русские ошибки. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V037.
      Приёмка: Получен проверяемый результат: Добавить offline status и claim через общую библиотеку. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/cli/ownership.rs`
      Результат: Добавлены offline-команды herder ownership status|claim через общую ownership-библиотеку. Повтор того же claim ID восстанавливает исходный acquired_at при полном совпадении resource/principal/session/ID/purpose/expiry; изменённый payload отклоняется, строгая claim() сохранена. Commit 56e1001b3cd150d851053a301392aaabd836198c; передан Тере для интеграции вместе с точным diff lib.rs (одна строка pub mod cli;). Доказательства: cargo check --bin herder; cargo test ownership::claim::tests 5/5; offline fixture status free -> acquired -> already_owned -> changed purpose rejected -> status owned с исходным acquired_at. cargo fmt недоступен: rustfmt отсутствует для 1.96.1. Не доказаны интеграция Терой и R004.
  - V040A · ⏸ Отложено владельцем · (Сохранить объявления worktree, scopes и заметки в resource) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V037, V031, R003 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сохранить объявления worktree, scopes и заметки в resource. Частный результат исходного V040: Project/worktree identity/scopes/notes; MCP ownership вызывает ту же библиотеку. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V037, V031, R003.
      Приёмка: Получен проверяемый результат: Сохранить объявления worktree, scopes и заметки в resource. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/workspace.rs`
  - V040B · ✅ Готово · (Направить MCP resource claim в общую файловую библиотеку) · оценка 10 мин–15 мин · усилие 48 мин по часам · по часам 48 мин · волна 11 · зависит: R002, V037 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Подключить MCP resource claim/release к уже работающей ownership/file library. Один authority/storage для MCP и CLI. Проверка: MCP и CLI конкурируют за один exact resource, один победитель; device/S21 не трогать.
      Приёмка: Получен проверяемый результат: Направить MCP resource claim в общую файловую библиотеку. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/workspace.rs`
      Результат: Source slice committed 74d4cf6c: workspace MCP adapter delegates claim/release to canonical ownership file authority, enforces verified principal and exact write ACL, creates stable UUID claim IDs and reports errors/statuses. `cargo test application::workspace::tests --lib` PASS 2/2: shared temp authority race against offline CLI had exactly one winner; wrong principal release rejected; missing ACL denied; reopened authority readback succeeded. User explicitly authorized the single `pub mod workspace;` export hunk, included. Not proven: resource.claim via NativeServer MCP wire consumer; commit published to current main.
  - V054A · ✅ Готово · (Codex: Прочитать native список и устойчивые session IDs) · оценка 10 мин–15 мин · усилие 15 мин · по часам 16 мин · волна 11 · зависит: V053, V028 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Codex: Прочитать native список и устойчивые session IDs. Частный результат исходного V054: Одна подтверждённая native read route → адреса/status/последние user+assistant. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V053, V028.
      Приёмка: Получен проверяемый результат: Codex: Прочитать native список и устойчивые session IDs. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/read.rs`
      Результат: Реализован CodexReader: initialize сверяет CODEX_HOME, list_threads читает native thread/list и сохраняет устойчивые session IDs, cwd, status и cursors. Direct app-server smoke 6/6; один профиль повторно вернул session ID 01a1b3a1-b283-7b40-bb72-83d7f28155aa. Evidence: .tmp/v052b-codex-profile-20261107/v054a-native-list.log. Центральный экспорт pub mod read подтверждён в актуальном origin/main после commit 0e062d58; сообщённый Тере suite 50 tests не запускался повторно этой сессией. Не доказаны MCP/installed consumer; они остаются отдельным acceptance.
  - V063A · ✅ Готово · (OpenCode: Прочитать native список и устойчивые session IDs) · оценка 10 мин–15 мин · усилие 7 мин по часам · по часам 7 мин · волна 11 · зависит: V062, V028 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: OpenCode: Прочитать native список и устойчивые session IDs. Частный результат исходного V063: Одна подтверждённая native read route → адреса/status/последние user+assistant. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V062, V028.
      Приёмка: Получен проверяемый результат: OpenCode: Прочитать native список и устойчивые session IDs. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/read.rs`
      Результат: Добавлен crates/herder/src/adapters/opencode/read.rs, commit a8dd75f6 поверх свежего origin/main. `OpenCodeSessionReader::list_sessions` читает native GET /api/session, мапит стабильный ses… ID в SessionAddress с точным InstanceRef, сохраняет parent/project/outcome/time/location и opaque cursors. На isolated OpenCode 2.2.4 создана одна пустая сессия, независимый список вернул тот же ID и instance; сессия удалена HTTP 204. Evidence: .tmp/v063a-runtime/evidence.json и v063a_probe.rs. Scratch compile с reqwest 0.12 прошёл; общий `lib.rs` export Terra ещё должен добавить `pub mod read`.
  - V064PORT · ✅ Готово · (OpenCode: native create с точным instance и receipt) · оценка 15 мин · усилие 3 ч 19 мин по часам · по часам 3 ч 19 мин · волна 11 · зависит: V062 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Независимая native часть V064A: реализовать create port над готовым OpenCode connection по существующему контракту NativeCreateControl. Не ждать application composition V023; не менять core interface.
      Приёмка: Изолированная native create операция возвращает точный SessionAddress данного instance; timeout/disconnect после возможной отправки даёт UNKNOWN без retry, preflight отказ без эффекта. Проверка источника ответа и отсутствие второй create через управляемый fixture. Общий application/MCP proof сохраняется в V064A/B/V064.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/create.rs`, `acceptance/native/opencode/`
      Результат: OpenCode native create validation fixed on integrated candidate d7b560d3 as commit 395eb202 (create.rs only). Invalid request key, invalid JSON/specification (including caller-selected id), and invalid parentID return NativeCreateOutcome::DefinitelyNotSent before POST. Request construction failures and proven connect failures map to DefinitelyNotSent; timeout/interrupted response, any non-success HTTP response, malformed response or post-response body failure remain Unknown without retry. Fixture confirms invalid inputs produce zero POST and timeout after POST is Unknown with one POST. Evidence: evidence/V064PORT/opencode-fixtures-green.txt; OpenCode fixture suite passed 8/8.
  - V066A · ⏸ Отложено владельцем · (OpenCode: Прочитать native transcript страницами) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V062, V029 · стоимость — вне сметы · отложено владельцем
      Описание задачи: OpenCode: Прочитать native transcript страницами. Частный результат исходного V066: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V062, V029, V030.
      Приёмка: Получен проверяемый результат: OpenCode: Прочитать native transcript страницами. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/transcript.rs`
  - V072A · ✅ Готово · (ZCode: Прочитать native список и устойчивые session IDs) · оценка 10 мин–15 мин · усилие 17 мин по часам · по часам 17 мин · волна 11 · зависит: V071, V028 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: ZCode: Прочитать native список и устойчивые session IDs. Частный результат исходного V072: Одна подтверждённая native read route → адреса/status/последние user+assistant. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V071, V028.
      Приёмка: Получен проверяемый результат: ZCode: Прочитать native список и устойчивые session IDs. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/read.rs`
      Результат: Добавлен и закоммичен `ZcodeSessionReader::list_sessions` в crates/herder/src/adapters/zcode/read.rs, commit d764d538. Используется legacy-native zcode-agent.listSessions contract, scoped к одному абсолютному workspace и explicit instance; строит SessionAddress из native sessionId и сохраняет status как optional native value. На изолированном supervisor profile две последовательные Rust native reads вернули пустой список, результаты совпали; initialize.available=false. Никаких create/send/inference действий не было. Evidence: /home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-herder-native-mcp-breaking/evidence/V072A/zcode-native-empty-list.json. Временный probe включил read.rs по path и удалён. cargo check прошёл. Непустой session ID/message history не доказаны; Cargo/lib wiring владельца Tera не тронуто и остаётся незакоммиченным.
  - V073PORT · ✅ Готово · (ZCode: source native create порт с точной квитанцией) · оценка 15 мин · усилие не измерено · волна 11 · зависит: V071 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Выделенная независимая adapter часть V073A. Native createSession через существующий проверенный instance connection, using captured/legacy contract. Общие application/public gates сохраняются.
      Приёмка: Fake transport проверяет одно create, exact native ID, definitely-not-sent validation против UNKNOWN after possible send, no retry. Typed NativeCreateOutcome из published309fd821. Source/tests only; V072D UNKNOWN не повторять, native profile/model не запускать. Shared Cargo/lib/schema не менять.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/create.rs`, `acceptance/native/zcode/`
      Результат: V073PORT source is integrated in published origin/main: create port source commit 25ced4bb and ZCode module exports commit 99733d7f. Verified in the current 99733d7f worktree with `cargo test --manifest-path crates/herder/Cargo.toml zcode:: --offline`: 6 passed, 0 failed (includes all three create fake tests: exact returned ID, DefinitelyNotSent before create, UNKNOWN after one possible write with no retry). No native create/send/model or V072D replay.
  - V075A · ✅ Готово · (ZCode: Прочитать native transcript страницами) · оценка 10 мин–15 мин · усилие 16 мин · по часам 15 мин · волна 11 · зависит: V071, V029 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Source ZCode transcript reader/projection on existing captured native history and bound snapshot cursor. Search indexing integration is separate V075B and depends on V030. No new native create/send for this slice; previous V072D UNKNOWN remains.
      Приёмка: Получен проверяемый результат: ZCode: Прочитать native transcript страницами. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/transcript.rs`
      Результат: Scoped commit e13487a6 adds crates/herder/src/adapters/zcode/transcript.rs and acceptance/native/zcode/transcript-legacy.json. Reader uses the exact existing session with runtimePolicy=existing-only and messageLimit=200, verifies returned session ID, preserves typed raw parts/native type/index and legacy plain user content via source_field=content, and binds page cursors to principal plus a snapshot hash over node/instance/session and full response. Local pages are explicitly slices of the bounded native batch; truncation is independent and conservatively true at the 200-message cap or when native payload says truncated. Fake-source harness tests: 3/3 passed; shared domain transcript tests: 8/8 passed; `rustfmt +stable --check`, JSON parse and diff checks passed. V072B records no native ZCode transcript capture, so the acceptance fixture honestly reuses its synthetic legacy DTO shape; no live read, create, send or model action was performed. Shared lib/Cargo export was not changed; runtime/consumer readback is not claimed.
  - V076A · ✅ Готово · (ZCode: Привязать interrupt к точному native turn) · оценка 10 мин–15 мин · усилие 3 мин по часам · по часам 3 мин · волна 11 · зависит: V071 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: ZCode source/fake exact native-turn interrupt port на основании старого рабочего adapter/native evidence. Если native protocol не позволяет атомарную exact turn корреляцию — явный unsupported до эффекта. Реальный stop и общий HumanStop gate отдельно в V076.
      Приёмка: Source regression exact/stale turn и unavailable/unsupported, без native/model/stop calls. Нет blind session-wide cancel при неизвестной корреляции. Reuse existing port/DTO/receipts; owned new ZCode file и минимальный registration handoff.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/control.rs`, `acceptance/native/zcode/interrupt-capability.json`
      Результат: Commit f51058ef adds adapters::zcode::control::interrupt_exact and synthetic source contract fixture. The existing native API is stopGeneration(taskId); legacy adapter obtains activeTurnId only through preflight, not an atomic turn guard. Matching observation returns Unsupported without a native-call interface; stale, unknown, foreign-instance, empty/oversized inputs return DefinitelyNotSent. Source harness compiled actual zcode connection.rs and ran 2 named V076A tests PASS. Evidence: review-evidence/V076A/source-tests.txt. No native stop/read/create/send/model action; no lib.rs/Cargo registration or consumer proof.
  - V090A · ✅ Готово · (Z.ai: Прочитать native список и устойчивые session IDs) · оценка 10 мин–15 мин · усилие 4 мин по часам · по часам 4 мин · волна 11 · зависит: V089, V028 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Z.ai: Прочитать native список и устойчивые session IDs. Частный результат исходного V090: Одна подтверждённая native read route → адреса/status/последние user+assistant. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V089, V028.
      Приёмка: Получен проверяемый результат: Z.ai: Прочитать native список и устойчивые session IDs. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/zai/mod.rs`, `acceptance/contracts/z-ai.md`, `acceptance/native/z-ai/chat-list.json`
      Результат: Добавлен read-only ZaiReader::list_chats() поверх уже наблюдавшегося same-origin list endpoint. Возвращает стабильные ZaiChatRef.id с первой страницы; malformed/duplicate IDs отклоняются. Первая страница не заявляется как полный список. Synthetic list fixture. Commit 208e81bc atop origin/main f18149d3. Повторная проверка всей Z.ai lane на текущей базе: cargo test --manifest-path crates/herder/Cargo.toml adapters::zai --offline — 6 passed; rustfmt +stable --edition 2024 --check и git diff --check прошли. Live вызов list_chats и последующие страницы не проверялись.
  - V093A · ✅ Готово · (Z.ai: Прочитать native transcript страницами) · оценка 10 мин–15 мин · усилие 53 мин по часам · по часам 53 мин · волна 11 · зависит: V089, V029 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Z.ai: Прочитать native transcript страницами. Частный результат исходного V093: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V089, V029, V030.
      Приёмка: Получен проверяемый результат: Z.ai: Прочитать native transcript страницами. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/zai/mod.rs`, `acceptance/native/z-ai/`, `acceptance/contracts/z-ai.md`
      Результат: ZaiReader::transcript_page projects the current ordered native batch window while preserving node/instance/chat identity, provider message IDs, native content_blocks types and indices, and message-level content as text with source_field=content and no fabricated native type/index. Source implementation: a3f95ac9 (transcript projection) plus scoped completion f7355c53bd31228fcfd88c6482743a0e04462e00 (only crates/herder/src/adapters/zai/mod.rs and acceptance/contracts/z-ai.md). Focused test `cargo test --manifest-path crates/herder/Cargo.toml transcript_projection_preserves_native_block_types_indices_and_known_limits`: 1 passed, 0 failed; exact output evidence/V093A-post-projection-green.txt (SHA-256 42bd4d420976b7a9857f1e6ed81091818574bd0142d5c8b013d92f27ae1bd602). Limitation: current read is capped at the last 180 history IDs; no native continuation cursor or complete-history signal was observed, so truncated=true and next_cursor=None; full history is not claimed. Node/instance/chat snapshot digest uses canonical identity, principal, account scope, and selected payload with length-delimited fields. V093B source feed is now complete in commit 9ca0408c; V093 full export/search acceptance and production v4 integration remain open.
  - V108A · ⏸ Отложено владельцем · (Hub: заменить вызов на общий typed API) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V107 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Hub: заменить вызов на общий typed API. Частный результат исходного V108: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V107.
      Приёмка: Получен проверяемый результат: Hub: заменить вызов на общий typed API. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `consumer:hub:paths-from-target.json`
  - V111A · ✅ Готово · (LHC: проверить, нужен ли переход с UI deep-link на typed API) · оценка 10 мин–15 мин · усилие не измерено · волна 11 · зависит: V110 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Фактический маршрут LHC — UI deep-link/iframe, а не вызов старого Agent Herder API. Проверить существующую ссылку относительно точного контракта `integrations/consumers/lhc/target.json`. Не добавлять bridge или новый вызов. Если текущий URL сохраняет точную native session identity, зафиксировать доказательство отсутствия нужного изменения и завершить без изменения LHC source; менять код только при воспроизводимом несовпадении контракта.
      Приёмка: Сопоставлены LHC URL `?from=lhc#/session/<encodeURIComponent(harness:nativeSessionId)>`, Herder hash parser/fleet-aware resolver и результаты точечных тестов. Зафиксирован factual delta: API migration не требуется, если ссылка сохраняет exact session; host ambiguity и missing/ambiguous identity явно описаны. Никакой искусственный bridge не создаётся. Live/browser proof нельзя выводить из unit/source evidence.
      Затрагиваемые файлы: `integrations/consumers/lhc/target.json`
      Результат: Фактический результат опубликован commit bafb71f5e272a08e72e4987f31e468fbbfe88c19 в integrations/consumers/lhc/target.json. Target различает текущую LHC UI ссылку harness+nativeSessionId (не API/resource call) и реализованный Herder UI host identity mesh:[hostId,harness,nativeSessionId] (не task/message ref). Вывод: caller/API migration не требуется для существующего контракта; hostId-aware delta отдельный зависимый gate только если требуется адресация по host либо доказан collision. Runtime/tests не менялись в этом leaf.
  - T011 · ⏸ Отложено владельцем · (Проверить неизменённый Codex через compatibility endpoint) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: T008, T009, T010 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Реализовать только этот проверяемый шаг по COMPATIBILITY.md. Входы: T008, T009, T010. При неизвестном SDK/consumer маршруте сначала назвать минимальный пробел; не форкать Codex.
      Приёмка: Официальный Codex обычными tools вызывает get/answer/cancel и читает Skill/changes; upstream native trace. Probe proof отдельно от real Herder.
      Затрагиваемые файлы: `crates/herder-compat/`, `acceptance/compat/`
  - V010B · ⏸ Отложено владельцем · (Подключить HTTP к той же application и identity) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V010A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подключить HTTP к той же application и identity. Частный результат исходного V010: Транспорт SDK, обязательная request metadata, shutdown; application entrypoint. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V010A.
      Приёмка: Получен проверяемый результат: Подключить HTTP к той же application и identity. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/mcp/transport.rs`
  - V015B · ⏸ Отложено владельцем · (Восстанавливать confirmed или unknown без новой отправки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V015A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Восстанавливать confirmed или unknown без новой отправки. Частный результат исходного V015: Restart dispatcher читает native receipt по стабильной корреляции, без send. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V015A.
      Приёмка: Получен проверяемый результат: Восстанавливать confirmed или unknown без новой отправки. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/reconcile.rs`
      Результат: 554b7182: версионированная receipt привязана к intent/principal/target/request_key/address; неверная или повреждённая даёт UNKNOWN, 3 targeted теста. Реальное происхождение и полный restart dispatcher ещё не доказаны.
  - V022B · ✅ Готово · (Добавлять native parent отдельно от creator после admission) · оценка 10 мин–15 мин · усилие 4 мин по часам · по часам 4 мин · волна 12 · зависит: V022A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Добавлять native parent отдельно от creator после admission. Частный результат исходного V022: Создатель в create intent, native parent и происхождение отдельно. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V022A.
      Приёмка: Получен проверяемый результат: Добавлять native parent отдельно от creator после admission. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/store/lineage.rs`
      Результат: Опубликован коммит 88d90a3b137ff772471c44f681ed702cec7cf27d в origin/main после fast-forward rebase от 9788a174; единственный изменённый путь crates/herder/src/store/lineage.rs. Добавлены AdmittedCreateLineage и Writer::record_admitted_create_lineage: creator берётся из intent principal, parent_ref хранится отдельно только при state admitted/confirmed и непустом native_receipt; повторы идемпотентны, несовпадающий parent даёт Conflict. Проверка после rebase: cargo +stable test --manifest-path crates/herder/Cargo.toml store::lineage::tests::admitted_parent_is_stored_separately_from_creator_and_is_immutable — 1 passed; rustfmt +stable --edition 2024 --check — passed; git diff --check — passed. Не доказано: вызов из application/MCP consumer.
  - V030B · ✅ Готово · (Фильтровать поисковую выдачу по ACL и coverage) · оценка 10 мин–15 мин · усилие 6 мин по часам · по часам 6 мин · волна 12 · зависит: V030A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Фильтровать поисковую выдачу по ACL и coverage. Частный результат исходного V030: SQLite FTS и source cursors; обновление только изменённой сессии. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V030A.
      Приёмка: Получен проверяемый результат: Фильтровать поисковую выдачу по ACL и coverage. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/search/index.rs`
      Результат: Source-only V030B committed as d7d6cbee in crates/herder/src/search/index.rs. Added serializable search_page/SearchPage/SearchHit/SearchCoverage API. It receives the trusted ACL allowlist as full SessionAddress values and applies that set in SQL to both count and hit query before ORDER/LIMIT/OFFSET; count and pages contain authorized sessions only. Coverage is partial when caller source coverage is incomplete or any allowlisted session's transcript is marked truncated; total_hits is documented as a lower bound for partial coverage. update_session persists content_truncated with snapshot state. Isolated rusqlite harness: 10 passed (7 index + 3 address), evidence review-evidence/v030b/search-acl-coverage.log. Not integrated into crate/store schema/export, no production or consumer proof; Terra owns v4 migration/fence/export. Parent V030 remains open.
  - V030MIG · ✅ Готово · (Мигрировать FTS в единственную схему v4) · оценка 10 мин–15 мин · усилие 30 мин по часам · по часам 30 мин · волна 12 · зависит: V030A · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Ввести fenced v3→v4 migration для FTS/state с обновлением exact schema validation и scoped authority; не применять к live DB.
      Приёмка: На копии v3 migration сохраняет holds/mapping/intent; старый writer отказывает, новый v4 валидирует полную schema и FTS; rollback ошибки атомарен; scoped authority работает на v4.
      Результат: origin/main 783335cd: isolated gated v3→v4 migration, exact schema + old writer fence, FTS/state, scope/mapping/active hold retained; snapshot search consistent transaction; independent review SUPPORTED, search10, launcher10, scoped26+1ignored, rollback/wrong-gate/fence tests passed. Installed/live DB not migrated.
  - V038B · ✅ Готово · (Ввести сбои вокруг unlink и уборки временного файла) · оценка 10 мин–15 мин · усилие 3 мин по часам · по часам 3 мин · волна 12 · зависит: V038A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Ввести сбои вокруг unlink и уборки временного файла. Частный результат исходного V038: Fault injection до/после rename/unlink/fsync; leftover temp cleanup под lock. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V038A.
      Приёмка: Получен проверяемый результат: Ввести сбои вокруг unlink и уборки временного файла. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `tests/ownership/crash.rs`
      Результат: Добавлена уборка оставшихся `.owner-*.tmp` под guard lock перед новым claim; добавлены test-only точки сбоя до/после unlink owner.json и два fault test. До unlink: release возвращает ошибку, owner сохранён. После unlink: release возвращает ошибку, owner отсутствует (caller должен сверить состояние по nonce, не повторять действие). Следующий claim удаляет abandoned temp и успешно пишет owner. Проверка после rebase: cargo test claim::crash_tests:: — 4 passed, 0 failed; diff-check чистый. Commit 64ff7015 на свежем origin/main f2da8394; owned пути claim.rs и tests/ownership/crash.rs. Передаю Терe.
  - V039B · ✅ Готово · (Добавить renew и release без daemon и SQLite) · оценка 10 мин–15 мин · усилие 3 мин по часам · по часам 3 мин · волна 12 · зависит: V039A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Добавить renew и release без daemon и SQLite. Частный результат исходного V039: herder ownership без запуска daemon/SQLite/MCP; JSON и русские ошибки. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V039A.
      Приёмка: Получен проверяемый результат: Добавить renew и release без daemon и SQLite. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/cli/ownership.rs`
      Результат: Добавлены offline команды renew и release в тот же CLI; renew возвращает claim с новым expires_at, release делегирует проверку точного claim_id общей библиотеке. На authority fixture: claim acquired → renew обновил expires_at → неверный claim_id для release отклонён → владелец release успешен → status free. cargo check --bin herder прошёл; diff --check прошёл. Коммит e6ec0c25 на свежем origin/main b23f366a после rebase; затронут только crates/herder/src/cli/ownership.rs. Интеграция Терой и R004/consumer acceptance ещё не доказаны.
  - V040 · ⏸ Отложено владельцем · (Проверить общий workspace двух нод и различие заметки и владения) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V040B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить общий workspace двух нод и различие заметки и владения. Частный результат исходного V040: Project/worktree identity/scopes/notes; MCP ownership вызывает ту же библиотеку. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V040B.
      Приёмка: Декларация не lease; две ноды одного shared workspace используют один resource. Это точка объединения всей цепочки V040A, V040B, V040.
      Затрагиваемые файлы: `crates/herder/src/application/workspace.rs`
  - V040BCONSUMER · ✅ Готово · (Проверить и опубликовать MCP resource claim consumer) · оценка 15 мин · усилие не измерено · волна 12 · зависит: V040B · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Перенести scoped commit 74d4cf6c только по двум owned paths на актуальный main без затрагивания чужих путей. Проверить NativeServer MCP wire resource.claim и resource.release совместно с offline CLI на одном временном resource; один победитель, чужой release rejected, reopen readback. Scoped publish и receipt.
      Приёмка: Реальные NativeServer MCP tools/call и offline CLI используют один временный authority: ровно один claim winner, release чужого principal отклонён, restart/reopen readback подтверждает owner; owned commit опубликован на main.
      Затрагиваемые файлы: `crates/herder/src/application/workspace.rs`, `crates/herder/src/lib.rs`
      Результат: Published to origin/main: commit 0fdd84c71332321fc8c652efcc7fc961aaa451c2 (parent ffb714b5), three scoped paths only: crates/herder/src/application/workspace.rs, crates/herder/src/lib.rs (single authorized pub mod workspace line), crates/herder/tests/workspace_mcp_wire.rs. Wire evidence: `cargo test --test workspace_mcp_wire` PASS 1/1; starts NativeServer::with_application and sends JSON-RPC tools/call resource.claim, offline CLI claim on identical temp file authority gets busy (MCP sole winner), separate NativeServer Bob resource.release gets MCP isError=true, reopened StorageAuthority read_by_claim_id confirms alice, offline CLI status=owned. Focused source tests: `cargo test application::workspace::tests --lib` PASS 2/2 including concurrent MCP adapter/CLI race exactly one winner, wrong-owner release, missing ACL rejection and reopen readback. Push accepted fast-forward ffb714b5..0fdd84c7; subsequent fetch confirms origin/main equals published commit. No Cargo/schema/launcher changes.
  - V054B · ✅ Готово · (Codex: Нормализовать user и assistant с turn refs) · оценка 10 мин–15 мин · усилие 15 мин · по часам 10 мин · волна 12 · зависит: V054A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Codex: Нормализовать user и assistant с turn refs. Частный результат исходного V054: Одна подтверждённая native read route → адреса/status/последние user+assistant. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V054A.
      Приёмка: Получен проверяемый результат: Codex: Нормализовать user и assistant с turn refs. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/read.rs`
      Результат: В crates/herder/src/adapters/codex/read.rs добавлены NativeMessageRole, NativeMessage/NativeMessagePage и CodexReader::list_messages на native `thread/items/list` с пагинацией и точным turnId. Изолированный live Codex app-server harness: 1/1; сохранённая fixture-сессия вернула точные user ID 01a1b3a1-b343-7640-9ace-e878747ae1da и assistant ID msg_test_1, оба связаны с turn ID 01a1b3a1-b2aa-7512-a959-b40be3fabdce; текст input и HERDER_TEST_MODEL_OK совпали. Evidence: .tmp/v052b-codex-profile-20261107/v054b-native-items.log. Коммит 4d40a4c6 опубликован в origin/main, удалённый HEAD подтверждён. Не доказаны Herder MCP или installed consumer; это остаётся E001.
  - V063B · ✅ Готово · (OpenCode: Нормализовать user и assistant с turn refs) · оценка 10 мин–15 мин · усилие 27 мин по часам · по часам 27 мин · волна 12 · зависит: V063A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: OpenCode: Нормализовать user и assistant с turn refs. Частный результат исходного V063: Одна подтверждённая native read route → адреса/status/последние user+assistant. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V063A.
      Приёмка: Получен проверяемый результат: OpenCode: Нормализовать user и assistant с turn refs. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/read.rs`
      Результат: Реализован `OpenCodeSessionReader::recent_messages` в `crates/herder/src/adapters/opencode/read.rs`; commit `7665e586324397490e5bcd5ead229d54c448d33b` поверх `origin/main` d457e401, single owned path. Новейшие user/assistant читаются отдельными native history filters; сохраняются IDs, timestamps и текст; turn/reply/truncation остаются unknown без явной native связи. Проверки: isolated import harness с фактическим `.tmp/v061b/native-messages.json` — 2/2; `cargo test --manifest-path crates/herder/Cargo.toml` на crate с экспортированным `opencode::read` — 52/52. Commit SHA отправлен Тере для интеграции. Consumer create→deliver→recent через новый MCP пока не проверен.
  - V064LIVE · ✅ Готово · (OpenCode: проверить native create и независимый readback) · оценка 15 мин · усилие 2 мин по часам · по часам 2 мин · волна 12 · зависит: V064PORT, V062 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Один изолированный loopback create через порт V064PORT с уже известным launcher/auth из V062/V063; прочитать ровно возвращённый session ID через native GET и удалить только созданную тестовую сессию. Не делать модельный вызов, не повторять create при UNKNOWN.
      Приёмка: Реальный OpenCode 2.2.4 native API на loopback: точное совпадение instance и возвращённого native session ID, независимый GET readback, ровно один POST create, delete только task-created session. Сохранить redacted receipt; unit/live/MCP уровни раздельно.
      Затрагиваемые файлы: `.tmp/v064port-runtime/`
      Результат: Live isolated official OpenCode 2.2.4 loopback proof passed through OpenCodeCreateControl: exactly one POST, Confirmed exact configured instance and session ID ses_e4ae072abffe2Z3GNNzrMi42ew; independent GET /api/session/{id} confirmed exact ID and unique title; DELETE succeeded and subsequent GET was not found. No model call. Credential-free receipt: .tmp/v064port-runtime/live-receipt.json in the dedicated implementation worktree. Temporary Rust integration test removed; temporary lib export restored. Unit fixture proof remains 4/4 in V064PORT. MCP consumer proof is not claimed.
  - V065PORT · ✅ Готово · (OpenCode: native submit и точная квитанция без повторной отправки) · оценка 15 мин · усилие 20 мин по часам · по часам 20 мин · волна 12 · зависит: V062, V064PORT · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Независимая native часть V065A. Использовать уже проверенный connection/create и рабочий legacy send protocol, реализовать native control в adapters/opencode без core/schema. Поддерживать лишь доказанные mode; unsupported до эффекта.
      Приёмка: Fake native server фиксирует ровно один submit и точный instance/session receipt. Некорректный target/mode отклонён до запроса; неоднозначный ответ/timeout UNKNOWN без retry и без выдуманного native idempotency. Реальный isolated model send/read отдельно от port source proof.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/control.rs`, `acceptance/native/opencode/`
      Результат: OpenCode submit correction on integrated candidate d7b560d3: Current is rejected before POST because steer cannot atomically enforce expected_turn; Queue remains supported. Source fix commit ba67c7ec. New Current regression passes; previous fixture changed to Queue. The 8-test OpenCode module suite passed 8/8, including exact receipt, one-POST timeout UNKNOWN/no retry, Current no POST, and Queue delivery. Capability contract updated at acceptance/contracts/opencode.md. No live OpenCode send repeated; V065LIVE receipt remains unchanged.
  - V072B · ✅ Готово · (ZCode: Нормализовать user и assistant с turn refs) · оценка 10 мин–15 мин · усилие 39 мин по часам · по часам 39 мин · волна 12 · зависит: V072A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: ZCode: Нормализовать user и assistant с turn refs. Частный результат исходного V072: Одна подтверждённая native read route → адреса/status/последние user+assistant. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V072A.
      Приёмка: Получен проверяемый результат: ZCode: Нормализовать user и assistant с turn refs. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/read.rs`
      Результат: Добавлены `ZcodeSessionReader::read_messages` и нормализация ответа legacy `zcode-agent.readSession` в `crates/herder/src/adapters/zcode/read.rs`; вызов строго использует `runtimePolicy=existing-only`, `messageLimit`, сверяет возвращённый native sessionId, сохраняет user/assistant messageId, parentMessageId, явный `metadata.turnId`, created timestamp и текст. Чужие роли пропускаются. Код закоммичен: aebfb3a9 и a9fe2ac6 (текущий detached HEAD). Изолированный временный Rust harness: 3/3 теста passed; `git diff --check` passed; harness удалён. Evidence: `/home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-herder-native-mcp-breaking/evidence/V072B/zcode-read-normalization.json`. Fixture синтетический, captured ZCode transcript не найден. Live native read непустой сессии НЕ доказан: свежий профиль пуст; `initialize.available=false` без настроенного provider; найденный fake-model CI fixture принадлежит Codex, не ZCode. inference=0; личный runtime не использован. Следующая проверка V072 должна подтвердить две реальные изолированные тестовые сессии с native roles/turn refs и остаётся незавершённой.
  - V076B · ✅ Готово · (ZCode: Применить поддерживаемые параметры и permission reply) · оценка 10 мин–15 мин · усилие 3 мин по часам · по часам 3 мин · волна 12 · зависит: V076A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: ZCode: Применить поддерживаемые параметры и permission reply. Частный результат исходного V076: Только доказанные stop/model/permission methods; unsupported явно, не успех. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V076A.
      Приёмка: Получен проверяемый результат: ZCode: Применить поддерживаемые параметры и permission reply. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/control.rs`
      Результат: Добавлен typed source boundary для подтверждённых ZCode setMode, setModel и respondPermission форм. Точный instance/session/request binding, allowlist unsupported отказов. Commit 6d6b1a62f2dd55f2a4ca60cc0c2f6c407c4e0d19; synthetic harness control tests 3/3 passed, rustfmt и diff-check чисты. Evidence: review-evidence/V076B/source-proof.txt. Live native transport и consumer registration этим leaf не доказаны.
  - V090B · ✅ Готово · (Z.ai: Нормализовать user и assistant с turn refs) · оценка 10 мин–15 мин · усилие не измерено · волна 12 · зависит: V090A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Z.ai: Нормализовать user и assistant с turn refs. Частный результат исходного V090: Одна подтверждённая native read route → адреса/status/последние user+assistant. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V090A.
      Приёмка: Получен проверяемый результат: Z.ai: Нормализовать user и assistant с turn refs. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/zai/mod.rs`, `acceptance/contracts/z-ai.md`
      Результат: Добавлен ZaiReader::recent_messages(chat_id): после native read_chat выбирает последние user и assistant записи по порядку полученного batch и преобразует их в общий RecentMessages. Сохраняются только наблюдаемые message_id и timestamp. Native fixture не содержит turn_id или явного assistant reply-to ID; turn_id/reply_to_input_id, derived assistant_replies_to_user, partial и truncated остаются None. Commit ad28cfc8 atop 208e81bc/origin/main f18149d3. Повторная проверка: 6 Z.ai tests passed; rustfmt и diff checks прошли. Live readback отдельно не выполнялся.
  - V108B · ⏸ Отложено владельцем · (Hub: сохранить request key, Task и диагностические ошибки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V108A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Hub: сохранить request key, Task и диагностические ошибки. Частный результат исходного V108: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V108A.
      Приёмка: Получен проверяемый результат: Hub: сохранить request key, Task и диагностические ошибки. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `consumer:hub:paths-from-target.json`
  - V111B · ⏸ Отложено владельцем · (LHC: сохранить request key, Task и диагностические ошибки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V111A · стоимость — вне сметы · отложено владельцем
      Описание задачи: LHC: сохранить request key, Task и диагностические ошибки. Частный результат исходного V111: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V111A.
      Приёмка: Получен проверяемый результат: LHC: сохранить request key, Task и диагностические ошибки. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `consumer:lhc:paths-from-target.json`
  - QBROWSERCLAIM · ✅ Готово · (Закрепить тестовую вкладку ChatGPT через готовый resource claim) · оценка 15 мин · усилие 5 ч 18 мин по часам · по часам 5 ч 18 мин · волна 13 · зависит: V040BCONSUMER · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Применить существующую ownership library к реальному QA resource без новой lease системы. Один test-only authority на server100, явно записанный в plan и manifest. Resource identity: mac-mini-2012.lan/gateway50260/page7/chat6aee9fd5-7ee0-83ea-a06f-a3ed148605e8. CI проверил marker/account hash и единственный browser operator. LinuxCLI/status/sharedowner.json, cross-client competingclaim busy, release/CAS byowner, no browser mutations.
      Приёмка: Exact canonical testauthority path/storage_id/principal/claim_id и resourceidentity в bounded private receipt; existingCLI status owned, competingclaim busy, CI read before sideeffect. Это кооперативное исключительное владение через общий authority, не CDP fencing. Последовательная передача CI→browser без второго storage. Native browser не трогать.
      Затрагиваемые файлы: `acceptance/native/browser/resource-scope.json`
      Результат: Server100 test-only file authority and registered QA resource prepared with ownership::resource::register_or_update; only `mac-mini-2012.lan/gateway50260/page7/chat6aee9fd5-7ee0-83ea-a06f-a3ed148605e8`, node scope mac-mini-2012.lan. Built supported `herder` CLI with cargo build --manifest-path crates/herder/Cargo.toml --bin herder. CLI proof: valid marker status=free; claim 21df64fc-3e0f-4f9e-8664-b40c39a840bb acquired (principal_ref linux-euid:1000, purpose designates CIlead01a1ac52); fresh status=owned; independent second UUID returned busy; resolve original=current. Private bounded receipt mode 0600: /home/roomhacker/.local/state/agent-herder/qa-browser-authority-receipt.json. Shared scope/commands manifest: acceptance/native/browser/resource-scope.json. Herder handoff accepted and activated before any browser mutation for CI session 01a1ac52-d25c-7050-a65d-3fca32642c26, inputId qbrowclaim-ready-qa-resource-20261108-ci-lead; turnId 01a1b846-1b0c-7be1-abe6-7e1fff021dd3. No browser or production resource was touched. CI's actual status read/side effect is intentionally not claimed; the delivered instructions require verifying the exact owner before proceeding and releasing it afterward.
  - V010 · ⏸ Отложено владельцем · (Подтвердить новый wire на реальном клиенте обоими транспортами) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V010B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить новый wire на реальном клиенте обоими транспортами. Частный результат исходного V010: Транспорт SDK, обязательная request metadata, shutdown; application entrypoint. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V010B.
      Приёмка: Основной клиент читает catalog обоими поддерживаемыми транспортами; wrong revision до эффекта. Это точка объединения всей цепочки V010A, V010B, V010.
      Затрагиваемые файлы: `crates/herder/src/mcp/transport.rs`
  - V015 · ⏸ Отложено владельцем · (Подтвердить восстановление после сбоя в admission) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V015B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить восстановление после сбоя в admission. Частный результат исходного V015: Restart dispatcher читает native receipt по стабильной корреляции, без send. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V015B.
      Приёмка: Kill после dispatching/admission даёт confirmed или unknown; unknown не получает safe retry. Это точка объединения всей цепочки V015A, V015B, V015.
      Затрагиваемые файлы: `crates/herder/src/application/reconcile.rs`
  - V022 · ✅ Готово · (Проверить происхождение после рестарта и unknown parent) · оценка 10 мин–15 мин · усилие 2 мин по часам · по часам 2 мин · волна 1 · зависит: V022B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Проверить происхождение после рестарта и unknown parent. Частный результат исходного V022: Создатель в create intent, native parent и происхождение отдельно. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V022B.
      Приёмка: Restart между intent и native receipt не меняет creator; неизвестное происхождение не угадано. Это точка объединения всей цепочки V022A, V022B, V022.
      Затрагиваемые файлы: `crates/herder/src/store/lineage.rs`
      Результат: Опубликован коммит 3ba01b0d6115a146a63f22d37776869630f7baab в origin/main; изменён только crates/herder/src/store/lineage.rs (rebase поверх 8d88b237). Добавлен durable SQLite restart acceptance: после prepare intent соединение закрывается/открывается заново, admission receipt записывается после рестарта, creator_ref в intent и lineage совпадает, неизвестный parent остаётся NULL. Проверка после rebase: cargo +stable test --manifest-path crates/herder/Cargo.toml store::lineage::tests::creator_survives_restart_before_receipt_and_unknown_parent_stays_unknown — 1 passed; rustfmt --check и git diff --check passed. Не доказано: application/MCP consumer wiring и пользовательский readback.
  - V030 · ⛔ Заблокировано · (Проверить обновление без полного обхода корпуса) · оценка 10 мин–15 мин · усилие не измерено · волна 1 · зависит: V030B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional · блокер: Полный FTS scan при update; схема и production ingestion требуют интеграции
      Описание задачи: Проверить обновление без полного обхода корпуса. Частный результат исходного V030: SQLite FTS и source cursors; обновление только изменённой сессии. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V030B.
      Приёмка: Одна новая запись не сканирует весь corpus; ACL и coverage сохраняются. Это точка объединения всей цепочки V030A, V030B, V030.
      Затрагиваемые файлы: `crates/herder/src/search/index.rs`
      Результат: Source fixture: 10 index tests и reopen/ACL test PASS; изменение одной записи сохраняет вторую, но no-full-scan acceptance и production ingestion не выполнены.
      Сохранённый статус: blocked
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T14:50:32+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b2f9-b32b-7802-b7c4-75bbe1d8475c
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; записан блокер (external_blocked)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: leaf: Полный FTS scan при update; схема и production ingestion требуют интеграции
  - V038 · ✅ Готово · (Подтвердить целый owner и UNKNOWN при сбое fsync) · оценка 10 мин–15 мин · усилие 2 мин по часам · по часам 2 мин · волна 2 · зависит: V038B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Подтвердить целый owner и UNKNOWN при сбое fsync. Частный результат исходного V038: Fault injection до/после rename/unlink/fsync; leftover temp cleanup под lock. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V038B.
      Приёмка: Полный old/new owner или отсутствие; fsync failure unknown; guard inode не заменён. Это точка объединения всей цепочки V038A, V038B, V038.
      Затрагиваемые файлы: `tests/ownership/crash.rs`
      Результат: Общая fault acceptance завершена: fail before rename даёт отсутствие owner/temp и повтор claim Acquired; after rename/до/после directory fsync оставляет один полный replayable owner; before unlink сохраняет owner, after unlink сообщает ошибку при уже удалённом owner (UNKNOWN, сверять состояние без повтора); abandoned owner temp убирается под guard lock; claim/renew/release сохраняют один guard inode. Проверка на актуальном origin/main c2cfd335: cargo test claim::crash_tests:: --lib — 5 passed, 0 failed, diff-check чистый. Собранный commit a5718e97 содержит V038A+B и inode guard check, интеграцию передаю Терe.
  - V039 · ✅ Готово · (Прочитать потерянный результат по nonce без повторного занятия) · оценка 10 мин–15 мин · усилие 3 мин по часам · по часам 3 мин · волна 2 · зависит: V039B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Прочитать потерянный результат по nonce без повторного занятия. Частный результат исходного V039: herder ownership без запуска daemon/SQLite/MCP; JSON и русские ошибки. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V039B.
      Приёмка: Потерянный claim response читается по nonce без automatic reclaim после release. Это точка объединения всей цепочки V039A, V039B, V039.
      Затрагиваемые файлы: `crates/herder/src/cli/ownership.rs`
      Результат: Добавлена read_by_claim_id в общей ownership-библиотеке и offline `ownership resolve`. Команда читает только актуальную owner.json: возвращает current+claim по совпавшему nonce; после release возвращает not_current/null без повторного claim. Изолированный CLI сценарий claim → resolve current (с исходным acquired_at) → release → resolve not_current → status free пройден. Commit fe8048d6 после rebase на origin/main 6edc8296; cargo check --bin herder и diff-check прошли. SHA передан Терe; центральная интеграция и R004/MCP consumer proof остаются отдельными.
  - V054 · ✅ Готово · (Codex: Сверить recent с независимым native чтением) · оценка 10 мин–15 мин · усилие 15 мин · по часам 2 мин · волна 5 · зависит: V054B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Codex: Сверить recent с независимым native чтением. Частный результат исходного V054: Одна подтверждённая native read route → адреса/status/последние user+assistant. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V054B.
      Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен. Это точка объединения всей цепочки V054A, V054B, V054.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/read.rs`
      Результат: Объединяющий V054 подтверждён на двух независимых тестовых сессиях: каждый fixture turn читался через CodexReader::list_messages и прямой Codex app-server thread/items/list. Обе сессии вернули собственные точные user/assistant IDs и общий для пары native turnId; session/turn refs между сессиями различаются. Fixture обработал ровно 2 запроса, сеть harness содержала только lo. Evidence: .tmp/v054-two-sessions-20261107/proof.json, transcript.jsonl, adapter-read.log. Частично: подтверждён native adapter/live profile; public MCP, установленный consumer и dev artifact остаются непроверенными и входят в последующие acceptance leaves.
  - V055C · ✅ Готово · (Codex: Реализовать native turn control порт для общего dispatcher) · оценка 10 мин–15 мин · усилие 47 мин по часам · по часам 47 мин · волна 13 · зависит: V006, V053, V054B · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Добавить Codex-specific реализацию существующего NativeSessionControl на CodexConnection; выдержать выбранный DispatchPlan/expected_turn, вернуть точный native turn receipt и честно классифицировать pre-send отказ против outcome unknown. Не менять core/store/application wiring.
      Приёмка: Isolated app-server harness подтверждает точный RPC/target/turn и native turn ID; явная pre-admission ошибка отличается от timeout/disconnect после send, который остаётся UNKNOWN и не повторяется.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/control.rs`
      Результат: Добавлен и scoped-committed `crates/herder/src/adapters/codex/control.rs`, commit `e3d24adc`. Реализованы instance/profile-bound Codex control, отдельный thread/start для fresh thread, turn/start только на локально созданной fresh session, turn/steer с expectedTurnId, fail-closed Queue и read-only clientUserMessageId lookup с pagination/ambiguity handling. Standalone Cargo harness компилирует файл и прогнал 3 теста: create/start+lookup, Queue DefinitelyNotSent, timeout OutcomeUnknown без retry. `rustfmt +stable` и `git diff --cached --check` прошли. Не доказаны: live fixture correlation/readback и application::target::deliver end-to-end; HumanStop/trusted snapshot/core wiring принадлежит Тере и остаётся отдельным gate.
  - V063 · ✅ Готово · (OpenCode: Сверить recent с независимым native чтением) · оценка 10 мин–15 мин · усилие 1 ч 03 мин по часам · по часам 1 ч 03 мин · волна 5 · зависит: V063B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: OpenCode: Сверить recent с независимым native чтением. Частный результат исходного V063: Одна подтверждённая native read route → адреса/status/последние user+assistant. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V063B.
      Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен. Это точка объединения всей цепочки V063A, V063B, V063.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/read.rs`
      Результат: Исходная приёмка выполнена через V063C. Независимая native OpenCode 2.2.4 HTTP history сверена с Rust recent_messages для двух изолированных сессий; IDs/roles/text совпали, partial=false, turn/reply refs unknown/null. Receipt: .tmp/v063-runtime/evidence.json. OpenCode/model fixture и task-сессии удалены/остановлены. V063A/B source и tests ранее подтверждены.
  - V065LIVE · ✅ Готово · (OpenCode: один dummy-provider turn с exact native readback) · оценка 15 мин · усилие 25 мин по часам · по часам 25 мин · волна 13 · зависит: V065PORT · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: После scoped submit source commit запустить один isolated official OpenCode 2.2.4 server + loopback test-model-server. Создать одну task-owned test session, выполнить один submit через OpenCodeSessionControl в доказанный queue mode, независимо прочитать тот же native input ID и завершённый marker-ответ, затем удалить только эту сессию. Не вызывать реальный provider и не повторять UNKNOWN.
      Приёмка: Ровно одна новая isolated session и один adapter submit; OpenCodeSessionControl подтверждает exact native session/message receipt; GET history содержит тот же user msg ID/marker и завершённый assistant HERDER_TEST_MODEL_OK; loopback model server зафиксировал запрос; DELETE exact session и post-delete GET подтверждает удаление. Секретов/реальных provider calls нет; fixture process/state очищены.
      Затрагиваемые файлы: `.tmp/v065live-runtime/`
      Результат: Из существующей live-квитанции сохранён durable evidence-файл evidence/V065LIVE/live-receipt.json (SHA-256 7fa679fdea160f52cad1cdb3f8828a75e479597af0e879726d0a7694af68d1ff); source+evidence commit 2413cbca1a7c2f7ce573d379ae2c8c2b63c6efd0. Один изолированный официальный OpenCode 2.2.4 session, ровно один OpenCodeSessionControl Queue submit; native history подтвердила тот же user msg ID/marker и завершённый assistant HERDER_TEST_MODEL_OK; loopback model requests=1, external provider calls=0. Удалена только task-created сессия; post-delete GET=not found. Receipt: deleted=true, submit_count=1, native_message_id=msg_1b543b6f90013beh79vyUTXfUt, session_id=ses_e4abc4925ffenmzC7c0XF6PkOX, request_key_metadata=v065-input-1794042472394619835, title=herder-v065live-1794042472394619835. UNKNOWN не повторялся.
  - V066B · ⏸ Отложено владельцем · (OpenCode: Нормализовать snapshot и обновить общий индекс) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V066A, V030B · стоимость — вне сметы · отложено владельцем
      Описание задачи: OpenCode: Нормализовать snapshot и обновить общий индекс. Частный результат исходного V066: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V066A.
      Приёмка: Получен проверяемый результат: OpenCode: Нормализовать snapshot и обновить общий индекс. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/transcript.rs`
  - V072 · ✅ Готово · (ZCode: Найти подтверждённый loopback fake-model сценарий) · оценка 10 мин–15 мин · усилие 2 ч 08 мин по часам · по часам 2 ч 08 мин · волна 5 · зависит: V072B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Read-only поиск существующего legacy CI пути для двух изолированных ZCode сессий, локального model fixture и native history readback.
      Приёмка: Найдены точные проверенные scripts/receipt и изолированная provider config схема; неизвестные поля не угадываются.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/read.rs`
      Результат: В read-only старом CI worktree `/home/roomhacker/.codex/worktrees/herder-native-ci/agent-herder` найден подтверждённый маршрут: scripts/zcode-official-probe.py конфигурирует providerId=fixture/baseUrl=loopback/herder-test, scripts/zcode-official-probe.mjs создаёт две native сессии, отправляет уникальный prompt через ZcodeAdapter и независимо читает readSession/readTranscript. Общая fixture — scripts/test-model-server.py; запуск был рассчитан на bwrap+unshare-net и отдельные временные HOME/server-root. Checkout содержит extensive чужой незакоммиченный WIP; файлы прочитаны, не изменялись и не запускались. Точные provider shape, createSession args и readSession call подтверждены source. Live probe ещё не запущен.
  - V075FEED · ✅ Готово · (ZCode: собрать страницы и проверить запись общего индекса) · оценка 10 мин–15 мин · усилие 14 мин по часам · по часам 14 мин · волна 13 · зависит: V075A, V030B · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Остаток V075B после module/build blocker: использовать существующий transcript WIP, подключить его к локальным тестам; собрать bounded snapshot и вызвать index_transcript_snapshot один раз.
      Приёмка: Ненулевые тесты partial/source_field и многостраничного snapshot; поздняя страница находится поиском, partial сохраняется, чужой snapshot/session отклонён, нет native вызовов. Commit owned source и handoff shared registration.
      Результат: Committed f5f27200: ZcodeTranscriptReader::index_snapshot_with_transport reads one existing bounded payload, assembles local pages with snapshot/cursor progress checks, and calls index_transcript_snapshot once after terminal assembly. Projection keeps truncated=true without verified completion signal and distinguishes content vs info.content. Actual connection.rs compiled in the existing source harness; 5 named transcript tests passed, including first/last page search, one native seam read, partial coverage and single session state row. RED/GREEN evidence: review-evidence/V075FEED/{partial-red,partial-green,source-field-red,source-field-green,transcript-green}. Native read not run; shared zcode::transcript module registration handed to Terra.
  - V090 · ✅ Готово · (Z.ai: Сверить recent с независимым native чтением) · оценка 10 мин–15 мин · усилие 4 мин по часам · по часам 4 мин · волна 5 · зависит: V090B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Z.ai: Сверить recent с независимым native чтением. Частный результат исходного V090: Одна подтверждённая native read route → адреса/status/последние user+assistant. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V090B.
      Приёмка: Две сессии возвращают свои роли/turn refs; partial отмечен. Это точка объединения всей цепочки V090A, V090B, V090.
      Затрагиваемые файлы: `crates/herder/src/adapters/zai/mod.rs`, `acceptance/contracts/z-ai.md`, `acceptance/native/z-ai/recent-two-chats.json`
      Результат: Joined Z.ai list/read/recent source path. Two isolated synthetic native payloads prove chat IDs keep separate user/assistant slots and message IDs. No turn/reply/completion metadata is present in captured shape; those refs plus partial/truncated remain None rather than inferred. Final commit a8bbdf7a atop origin/main f18149d3. cargo test --manifest-path crates/herder/Cargo.toml adapters::zai --offline — 6 passed; rustfmt +stable --edition 2024 --check and git diff --check passed. Live two-chat provider readback remains unverified.
  - V093B · ✅ Готово · (Z.ai: Нормализовать snapshot и обновить общий индекс) · оценка 10 мин–15 мин · усилие 7 мин по часам · по часам 7 мин · волна 13 · зависит: V093A, V030B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Source feed from a normalized Z.ai TranscriptPage into the existing index API. Use canonical full SessionAddress, snapshot_id and original text; preserve truncated=true into content_truncated. Source/fake SQLite fixture only; integrated v4/consumer proof remains in V093 and V030.
      Приёмка: Получен проверяемый результат: Z.ai: Нормализовать snapshot и обновить общий индекс. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/transcript.rs`
      Результат: The feed is now named `application::transcript_index::index_transcript_snapshot` and accepts only a locally assembled batch with `next_cursor=None`; continuation pages are rejected before any `update_session` write. Caller must gather all local pages first. The independent `truncated` bit is preserved as `content_truncated` to reflect bounded native history (including Z.ai's current 180-ID window); this does not claim full provider history. Text-only indexing, full SessionAddress validation, user/assistant search, cross-session ACL isolation, and Partial coverage remain covered by the in-memory SQLite fixture. Source feed commit 9ca0408c589a20da614f33c7b48e2b634097838e; pagination guard/regression commit 0c3ce215d8432f4152e64527c25ca36570351ca8. TDD evidence: evidence/V093B-pagination-red.txt shows `test result: FAILED. 0 passed; 1 failed`; evidence/V093B-pagination-green.txt shows the same test `1 passed; 0 failed`; evidence/V093B-post-pagination-green.txt shows all 3 feed tests passed. Exact focused GREEN SHA-256 c69543c65c5b06792b6eb516829f612b2a735e91705a6b4de3276d0ef0641db7; full fixture SHA-256 8d8fc0e48ed3f57776536b2dd46d01bb88171955ca077f1aa3e4dc96eb1f630d. Canonical bug Be6c689fb915b4de48926 is resolved with RED/GREEN receipts. Existing index implementation dependencies are 0342d129 and d7d6cbee; they were reused unchanged. The lib.rs registration hunk is carried by 9ca0408c for Terra to apply manually against current main, checking for an existing search module and avoiding duplicate exports. Production v4 schema/export and public consumer proof remain outside this source leaf.
  - V108 · ⏸ Отложено владельцем · (Hub: проверить отсутствие legacy alias и второго job lifecycle) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V108B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Hub: проверить отсутствие legacy alias и второго job lifecycle. Частный результат исходного V108: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V108B.
      Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены. Это точка объединения всей цепочки V108A, V108B, V108.
      Затрагиваемые файлы: `consumer:hub:paths-from-target.json`
  - V111 · ⏸ Отложено владельцем · (LHC: проверить отсутствие legacy alias и второго job lifecycle) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V111B · стоимость — вне сметы · отложено владельцем
      Описание задачи: LHC: проверить отсутствие legacy alias и второго job lifecycle. Частный результат исходного V111: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V111B.
      Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены. Это точка объединения всей цепочки V111A, V111B, V111.
      Затрагиваемые файлы: `consumer:lhc:paths-from-target.json`
  - QCHATCASE · ⌛ Ожидание · (ChatGPT: проверить общий core с готовым direct-CDP adapter) · оценка 10 мин–15 мин · усилие не измерено · ждёт: CI проверил dedicated gatewaypage7, exacttestchat/account; resource owner готовится QBROWSERCLAIM, existingtransport QMACREUSE. Общий Rust launch QAHAPLAUNCH пока blocked на точном refused/UNKNOWN resume Terra. Raw CDP target IDs не нужны для явно выбранного MacMiniChromeTransport и не подменяются gatewayID. · волна 14 · зависит: QBROWSERJOIN, QBROWSERSCOPE, QMACREUSE, QBROWSERCLAIM, QAHAPLAUNCH · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Использовать уже делегированный CI test scope после проверки текущих прав и exact account/context/target. Один свежий create/deliver/read через общий core, original receipt/no replay. Если scope недоступен, записать blocker только live части.
      Приёмка: Exact native IDs, один input/answer, transcript completeness и artifact identity подтверждены; локальный draft не выдан за native conversation.
      Сохранённый статус: waiting
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1b2b2-5685-7b52-a2bb-05eb931cafa4; source=mcp_metadata; at=2026-11-07T20:46:49+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=неизвестно · session_id=01a1b39a-d499-7320-809e-e3dbbfae0c33
      Плановая модель: неизвестно
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; внешнее ожидание (external_waiting)
      Незавершённые зависимости: QAHAPLAUNCH
      Причина ожидания / доставки: не записана
  - R004 · ⏸ Отложено владельцем · (Проверить перенос телефона и гонку владельцев общего ресурса) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: R003, V037, V039 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Fixture S21 и второго телефона; сменить attachment, выполнить конфликтующие claim через MCP и offline CLI.
      Приёмка: У каждого телефона свой ID; перенос не меняет claim; один победитель на ресурс; старый claim отвергнут.
      Затрагиваемые файлы: `tests/ownership/resources.rs`
  - V013A · ⏸ Отложено владельцем · (Отказывать клиенту без Tasks до intent и native эффекта) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V012, V010 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Отказывать клиенту без Tasks до intent и native эффекта. Частный результат исходного V013: SDK wire types и SQLite backend без in-memory authority. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V012, V010.
      Приёмка: Получен проверяемый результат: Отказывать клиенту без Tasks до intent и native эффекта. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/mcp/tasks.rs`
  - V016A · ⏸ Отложено владельцем · (Разделить сроки Task, текста и дедупликационной квитанции) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V015 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Разделить сроки Task, текста и дедупликационной квитанции. Частный результат исходного V016: Tombstone дедупликации/удалённого текста, правила expiry. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V015.
      Приёмка: Получен проверяемый результат: Разделить сроки Task, текста и дедупликационной квитанции. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/store/retention.rs`
  - V020A · ⏸ Отложено владельцем · (Выбирать origin node из точного адреса instance) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V010, V005 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Выбирать origin node из точного адреса instance. Частный результат исходного V020: Peer auth, точный instance, deadline и сохранение errors; без local fallback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V010, V005.
      Приёмка: Получен проверяемый результат: Выбирать origin node из точного адреса instance. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/peer/route.rs`
  - V027A · ✅ Готово · (Сохранять проверенного sender вместе с message_ref) · оценка 10 мин–15 мин · усилие 6 мин по часам · по часам 6 мин · волна 14 · зависит: V012, V022, V008 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Сохранять проверенного sender вместе с message_ref. Частный результат исходного V027: Transaction связывает sender/recipient/message_ref с intent; reply target берётся сервером. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V012, V022, V008.
      Приёмка: Получен проверяемый результат: Сохранять проверенного sender вместе с message_ref. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/store/correspondence.rs`
      Результат: V027A commits f756793b (durable correspondence) and follow-up 4179eb81 (dedup correction). record_correspondence now calls the shared prepare_intent_in_transaction helper, preserving Writer::prepare_intent key/payload semantics inside the same transaction. Same principal/recipient/request_key+payload with regenerated intent/task/message IDs returns Existing plus original refs; changed content or verified sender returns Conflict. RED reproduced the old Conflict for regenerated IDs; GREEN proves original refs returned and exactly one task/intent/message remains. Correspondence tests: 4 passed; existing intents tests: 4 passed; rustfmt and diff check passed. Earlier real SQLite close/reopen proof retained. No schema/lib/Cargo changes; module registration was the single-line hunk already sent to Terra. No external sends.
  - V041A · ✅ Готово · (Взять execution lock конкретной цели перед проверкой owner) · оценка 10 мин–15 мин · усилие 4 мин по часам · по часам 4 мин · волна 14 · зависит: V037, V039 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Взять execution lock конкретной цели перед проверкой owner. Частный результат исходного V041: Target-local lock, live claim check после lock, expected deployed revision. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V037, V039.
      Приёмка: Получен проверяемый результат: Взять execution lock конкретной цели перед проверкой owner. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/ownership/release_runner.rs`
      Результат: Добавлен ownership::release_runner::TargetExecutionLock: создаёт стабильный `execution.lock` у зарегистрированного ResourceRef, получает эксклюзивный File lock и после ожидания повторно сверяет marker identity; RAII держит lock до drop. Изолированный test проверяет эксклюзивность (contender получает TryLockError::WouldBlock) и получение того же lock после release; cargo test ownership::release_runner::tests:: — 1 passed, 0 failed после rebase на origin/main 82a3d2ca; diff-check чистый. Commit f539c9e6 (lib.rs добавлен ровно pub mod release_runner; + новый release_runner.rs); передан Терe.
  - V055D · ✅ Готово · (Codex: Подтвердить clientUserMessageId на изолированной native fixture) · оценка 15 мин · усилие 26 мин по часам · по часам 26 мин · волна 14 · зависит: V055C · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: На существующем отдельном Codex profile/fake-model fixture открыть control, выполнить один уникальный submit с clientUserMessageId и подтвердить тот же turn через read-only thread/items/list lookup. Сначала проверить fixture/session state и не повторять UNKNOWN; не трогать операторский профиль или core wiring.
      Приёмка: Standalone CodexControl открывается на точной существующей изолированной fixture; один уникальный submit даёт native admission; lookup по исходному RequestKey возвращает ровно тот же turn ID и совпадающий thread/instance; независимый native readback подтверждает userMessage.clientId и turnId; повторной отправки нет.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/control.rs`
      Результат: Native Codex acceptance завершена на Codex CLI 0.167.0 в отдельном fresh CODEX_HOME `.tmp/v055d-final` с fixture-only provider и loopback fake model. Один submit с `clientUserMessageId=herder-v055d-native-20261107-9f2931e9507940938527ded7c7c33ff3` дал thread `01a1b463-0d30-7323-9d8d-4b0439e8019d`, turn `01a1b463-0d71-7750-8521-99fac91979bd`; adapter lookup Found точный turn. Отдельный Codex app-server connection прочитал `thread/items/list`: userMessage.clientId и turnId совпали, assistant `HERDER_TEST_MODEL_OK` пришёл в тот же turn. Fixture requests: 0 до / 1 после. Полные receipts: `.tmp/v055d-final/target-before-submit.json`, `native-proof.json`, `fixture-before.json`, `fixture-after.json`; процесс fixture остановлен, порт 43887 закрыт. Предыдущие два partial isolated runs не повторялись; их receipts сохранены в `.tmp/v055d-isolated/` и `.tmp/v055d-success/`. Код lookup с bounded retries: commit `ab25d716`; standalone tests 3/3, `rustfmt +stable --check` прошёл. Не доказаны application::target::deliver, общий store/core HumanStop composition, production consumer или E001 acceptance; эти gates остаются у core/consumer plan.
  - V057A · ⏸ Отложено владельцем · (Codex: Прочитать native transcript страницами) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V053, V029, V030 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: Прочитать native transcript страницами. Частный результат исходного V057: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V053, V029, V030.
      Приёмка: Получен проверяемый результат: Codex: Прочитать native transcript страницами. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/transcript.rs`
  - V066 · ⏸ Отложено владельцем · (OpenCode: Сверить export и search с исходной историей) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V066B, V030 · стоимость — вне сметы · отложено владельцем
      Описание задачи: OpenCode: Сверить export и search с исходной историей. Частный результат исходного V066: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V066B.
      Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected. Это точка объединения всей цепочки V066A, V066B, V066.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/transcript.rs`
  - V072C · ✅ Готово · (ZCode: Поднять изолированный loopback provider fixture) · оценка 10 мин–15 мин · усилие 6 мин по часам · по часам 6 мин · волна 12 · зависит: V072 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Настроить установленный ZCode Server в новом HOME/server-root на точный fixture provider из legacy CI и проверить model-selection/initialize доступность.
      Приёмка: ZCode supervisor и native provider view видят только fixture/herder-test; fake-model listener loopback-only; user data/credentials отсутствуют.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/read.rs`
      Результат: На свежем временном ZCode profile/server-root поднят точный `fixture/herder-test` provider config из legacy CI source. Bubblewrap private network namespace содержал только loopback; authenticated official supervisor и native model-selection видели provider `fixture`; `zcode-agent.initialize.available=true`; fake server requests=0. ZCode CLI 0.16.9 / Server 3.17.2. Профиль, supervisor и fake server очищены. Evidence: `/home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-herder-native-mcp-breaking/evidence/V072C/zcode-provider-fixture.json`. Native session/create/input/readback не проверялись в этом leaf.
  - V075B · ⏸ Отложено владельцем · (ZCode: Нормализовать snapshot и обновить общий индекс) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V075FEED · стоимость — вне сметы · отложено владельцем
      Описание задачи: ZCode: Нормализовать snapshot и обновить общий индекс. Частный результат исходного V075: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V075A.
      Приёмка: Получен проверяемый результат: ZCode: Нормализовать snapshot и обновить общий индекс. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/transcript.rs`
  - V084A · ⏸ Отложено владельцем · (ChatGPT: Прочитать native transcript страницами) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V080, V029, V030 · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Прочитать native transcript страницами. Частный результат исходного V084: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V080, V029, V030.
      Приёмка: Получен проверяемый результат: ChatGPT: Прочитать native transcript страницами. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/transcript.rs`
  - V090SCOPE · ✅ Готово · (Z.ai: проверять account scope при чтении списка чатов) · оценка 15 мин · усилие 17 мин по часам · по часам 17 мин · волна 14 · зависит: V090 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Исправить подтверждённый source defect V090: origin не доказывает неизменность аккаунта после attach. Проверять связанный account scope на результате native чтения; неизвестная identity не успешный пустой список.
      Приёмка: Fake direct-CDP scenario attach A→response B отвергается AccountMismatch; identity unavailable не возвращает успешный список; A сохраняет IDs. Live account switching не нужно. Scoped commit и RED/GREEN, без общих schema/Cargo edits.
      Затрагиваемые файлы: `crates/herder/src/adapters/zai/mod.rs`, `acceptance/native/z-ai/`, `acceptance/contracts/z-ai.md`
      Результат: list_chats verifies the first returned chat belongs to the expected Z.ai account and rejects mismatched, empty, or unverifiable results. Implementation + source tests: commit 35b1337692bc0dcc7cd6c16f8d2b84d94a61fd5b. Exact embedded Rust expression executed in Node VM with stubbed fetch/hash: 7 scenarios, TAP 8 passed, 0 failed; saved output evidence/V090SCOPE-expression-green.txt (SHA-256 23e1bc2e2ab423a8a10894d6b8617d69e74f73c2c708a25e233979fa09220289). Fake-CDP regressions and Rust account-bound snapshot checks are recorded in evidence/V090SCOPE-green.txt and evidence/V090-V093-delta-green.txt. No live provider list read claimed.
  - V093 · ⏸ Отложено владельцем · (Z.ai: Сверить export и search с исходной историей) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V093B, V030 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Z.ai: Сверить export и search с исходной историей. Частный результат исходного V093: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V093B.
      Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected. Это точка объединения всей цепочки V093A, V093B, V093.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/transcript.rs`
  - V109A · ⏸ Отложено владельцем · (Hub: выполнить основной сценарий через обычного потребителя) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V108 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Hub: выполнить основной сценарий через обычного потребителя. Частный результат исходного V109: Один изолированный сценарий через обычного потребителя и native result. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V108.
      Приёмка: Получен проверяемый результат: Hub: выполнить основной сценарий через обычного потребителя. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/consumers/hub/`
  - V112A · ⏸ Отложено владельцем · (LHC: выполнить основной сценарий через обычного потребителя) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V111 · стоимость — вне сметы · отложено владельцем
      Описание задачи: LHC: выполнить основной сценарий через обычного потребителя. Частный результат исходного V112: Один изолированный сценарий через обычного потребителя и native result. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V111.
      Приёмка: Получен проверяемый результат: LHC: выполнить основной сценарий через обычного потребителя. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/consumers/lhc/`
  - R006A · ⏸ Отложено владельцем · (Подключить владение планом LHC к общему resource: точный вход) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: R004, V111 · стоимость — вне сметы · отложено владельцем
      Описание задачи: LHC хранит план и историю; Herder хранит external_ref и владельца редактирования. Запись LHC проверяет claim.
      Приёмка: Записаны callable entrypoint, writer, разрешённые paths и сценарий проверки. Недоступность — точный blocker.
      Затрагиваемые файлы: `integrations/resources/lhc/target.json`
  - V013B · ⏸ Отложено владельцем · (Сохранять стандартный Task до ответа через SQLite backend) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V013A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сохранять стандартный Task до ответа через SQLite backend. Частный результат исходного V013: SDK wire types и SQLite backend без in-memory authority. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V013A.
      Приёмка: Получен проверяемый результат: Сохранять стандартный Task до ответа через SQLite backend. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/mcp/tasks.rs`
  - V016B · ⏸ Отложено владельцем · (Сохранять tombstone после удаления текста и Task) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V016A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сохранять tombstone после удаления текста и Task. Частный результат исходного V016: Tombstone дедупликации/удалённого текста, правила expiry. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V016A.
      Приёмка: Получен проверяемый результат: Сохранять tombstone после удаления текста и Task. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/store/retention.rs`
  - V020B · ⏸ Отложено владельцем · (Передавать identity, deadline и исходную ошибку peer) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V020A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Передавать identity, deadline и исходную ошибку peer. Частный результат исходного V020: Peer auth, точный instance, deadline и сохранение errors; без local fallback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V020A.
      Приёмка: Получен проверяемый результат: Передавать identity, deadline и исходную ошибку peer. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/peer/route.rs`
  - V027B · ✅ Готово · (Разрешать reply_to только получателю исходного сообщения) · оценка 10 мин–15 мин · усилие 1 мин по часам · по часам 1 мин · волна 15 · зависит: V027A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Разрешать reply_to только получателю исходного сообщения. Частный результат исходного V027: Transaction связывает sender/recipient/message_ref с intent; reply target берётся сервером. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V027A.
      Приёмка: Получен проверяемый результат: Разрешать reply_to только получателю исходного сообщения. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/store/correspondence.rs`
      Результат: Commit 00775275 adds Writer::resolve_reply_target in store/correspondence.rs. Resolver accepts only message_ref and VerifiedSelfBinding, verifies stored incoming message/session_ref, exact recipient_ref and associated intent target, then returns the persisted sender_ref as server-selected destination. Real SQLite file is closed/reopened before checks: verified recipient session-b resolves message-c-b to session-c; creator session-a and unrelated session-x receive Denied; missing ref returns NotFound. Combined correspondence test suite: 3 passed. No outbound/native delivery occurred; no schema/lib/Cargo changes. This is source and local SQLite proof, not integrated MCP consumer proof.
  - V041B · ✅ Готово · (Проверить текущий claim и deployed revision под lock) · оценка 10 мин–15 мин · усилие 2 мин по часам · по часам 2 мин · волна 15 · зависит: V041A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Проверить текущий claim и deployed revision под lock. Частный результат исходного V041: Target-local lock, live claim check после lock, expected deployed revision. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V041A.
      Приёмка: Получен проверяемый результат: Проверить текущий claim и deployed revision под lock. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/ownership/release_runner.rs`
      Результат: TargetExecutionLock получил verify_current_claim: пока lock удерживается, читает актуальный descriptor, сравнивает expected_revision и затем требует точного текущего claim_id через общую read_by_claim_id. Изолированный test: текущая пара resource/revision/claim проходит; чужой claim_id отвергнут PermissionDenied; устаревшая revision отвергнута WouldBlock; lock contention остаётся эксклюзивным. cargo test ownership::release_runner::tests:: — 1 passed после rebase на origin/main d77d739d; diff-check чистый. Commit b4720ad7, только release_runner.rs; передан Терe.
  - V055A1 · ✅ Готово · (Codex: Добавить native create port для thread/start) · оценка 15 мин · усилие 5 мин по часам · по часам 5 мин · волна 15 · зависит: V053, V055D · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Отдельный адаптерный срез под готовый application::target::NativeCreateControl (fa84e08c). Реализовать в adapters/codex/create.rs однократный thread/start из точного выбранного CodexInstance, вернуть только ответившую native identity/receipt; не менять core/store/HumanStop и не объявлять V055A/public MCP завершёнными.
      Приёмка: Codex create adapter реализует точный core NativeCreateControl contract; запускает thread/start ровно один раз в cwd выбранного процесса, возвращает Confirmed с исходным request key, точным bound instance и native thread id только по успешному native response; ошибка/timeout становится Unknown и не делает retry. Standalone compile/test проходит; уже сохранённый isolated V055D receipt подтверждает тот же native thread/start response и независимую native identity.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/create.rs`
      Результат: Добавлен `crates/herder/src/adapters/codex/create.rs`, commit `2d411261`. `CodexCreateControl::open` привязывает control и cwd к одной переданной `CodexInstance`; реализация `NativeCreateControl::create_once` вызывает `CodexControl::start_thread` один раз, формирует Confirmed только из его точного `SessionAddress`, эхо-ключ относится к текущему вызову (native API не даёт idempotency), а любые ошибки/timeout дают Unknown без повтора. `specification` остаётся core intent: пустой `thread/start` не превращает её в user message. Standalone harness с интерфейсом `NativeCreateControl` из `fa84e08c` прошёл 5/5 тестов: success exact mapping, timeout Unknown/no second thread/start, плюс 3 Codex control regression tests; `rustfmt +stable --check` и `git diff --cached --check` прошли. Переиспользован реальный isolated native proof из `.tmp/v055d-final`: точный thread `01a1b463-0d30-7323-9d8d-4b0439e8019d`, turn `01a1b463-0d71-7750-8521-99fac91979bd`, независимый native readback подтвердил эту thread identity. Не доказаны экспорт модуля в lib.rs, общий application create/store mapping, V023 readback gate, HumanStop composition или public MCP; V055A/full V055 остаются открыты.
  - V057B · ⏸ Отложено владельцем · (Codex: Нормализовать snapshot и обновить общий индекс) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V057A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: Нормализовать snapshot и обновить общий индекс. Частный результат исходного V057: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V057A.
      Приёмка: Получен проверяемый результат: Codex: Нормализовать snapshot и обновить общий индекс. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/transcript.rs`
  - V072D · ⛔ Заблокировано · (ZCode: Создать две тестовые native сессии и turns) · оценка 10 мин–15 мин · усилие не измерено · волна 12 · зависит: V072C · стоимость — модель не выбрана · лист не назвал ни модель, ни класс · блокер: The isolated native session writer subprocess timed out after a mutation sequence began; exact accepted state is unknown and the temporary server/session receipt was not captured.
      Описание задачи: На изолированном V072C профиле создать две native session, отправить по одному уникальному marker в локальную модель и дождаться ответа.
      Приёмка: Две разные native session IDs; каждая имеет точный user marker, HERDER_TEST_MODEL_OK и native turn/input refs; fake model зафиксировал только тестовые requests.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/read.rs`
      Результат: Provider fixture was available and loopback-only. First direct create returned a known rejection; second writer sequence timed out and is UNKNOWN. Evidence: /home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-herder-native-mcp-breaking/evidence/V072D/zcode-native-session-timeout.json. The leftover provider-only test directory was inspected and cleaned. No retry was sent. Native session IDs, delivered prompts, fake-model request count, and history remain unproven.
      Сохранённый статус: blocked
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T11:43:53+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b39a-83ab-7ea2-a343-25d92b900488
      Плановая модель: неизвестно
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; записан блокер (external_blocked)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: leaf: The isolated native session writer subprocess timed out after a mutation sequence began; exact accepted state is unknown and the temporary server/session receipt was not captured.
  - V072RUNNER · ✅ Готово · (ZCode: сохранять пошаговые receipts при timeout тестового runner) · оценка 15 мин · усилие 25 мин по часам · по часам 25 мин · волна 15 · зависит: V072C · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Исправить диагностический дефект испытательного runner, который потерял IDs и fake-model count при таймауте. Использовать существующий owned runner/history; не повторять UNKNOWN native create/send.
      Приёмка: Offline fake subprocess emits one step receipt then hangs: receipt survives timeout, stdout/stderr and fixture count persisted, owned process cleanup proven, test state retained on failure. No native create/send or real provider. V072D outcome stays UNKNOWN; later live proof separate.
      Затрагиваемые файлы: `acceptance/native/zcode/`
      Результат: Scoped commit a79ed7f8 adds acceptance/native/zcode/runner.py, test_runner.py, journal.mjs. Offline command `python3 -m unittest acceptance/native/zcode/test_runner.py`: 1 test passed; confirmed durable step receipt before hanging child, timeout/reap, fixture request count, stdout/stderr retained and profile preserved. No ZCode launch or native create/send. README remains uncommitted; unrelated Cargo/lib/contract WIP excluded.
  - V075 · ⏸ Отложено владельцем · (ZCode: Сверить export и search с исходной историей) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V075B, V030 · стоимость — вне сметы · отложено владельцем
      Описание задачи: ZCode: Сверить export и search с исходной историей. Частный результат исходного V075: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V075B.
      Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected. Это точка объединения всей цепочки V075A, V075B, V075.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/transcript.rs`
  - V084B · ⏸ Отложено владельцем · (ChatGPT: Нормализовать snapshot и обновить общий индекс) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V084A · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Нормализовать snapshot и обновить общий индекс. Частный результат исходного V084: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V084A.
      Приёмка: Получен проверяемый результат: ChatGPT: Нормализовать snapshot и обновить общий индекс. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/transcript.rs`
  - V109 · ⏸ Отложено владельцем · (Hub: сверить native результат и версии без повторной отправки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V109A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Hub: сверить native результат и версии без повторной отправки. Частный результат исходного V109: Один изолированный сценарий через обычного потребителя и native result. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V109A.
      Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль. Это точка объединения всей цепочки V109A, V109.
      Затрагиваемые файлы: `acceptance/consumers/hub/`
  - V112 · ⏸ Отложено владельцем · (LHC: сверить native результат и версии без повторной отправки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V112A · стоимость — вне сметы · отложено владельцем
      Описание задачи: LHC: сверить native результат и версии без повторной отправки. Частный результат исходного V112: Один изолированный сценарий через обычного потребителя и native result. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V112A.
      Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль. Это точка объединения всей цепочки V112A, V112.
      Затрагиваемые файлы: `acceptance/consumers/lhc/`
  - R006B · ⏸ Отложено владельцем · (Подключить владение планом LHC к общему resource: единая проверка владения) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: R006A · стоимость — вне сметы · отложено владельцем
      Описание задачи: LHC хранит план и историю; Herder хранит external_ref и владельца редактирования. Запись LHC проверяет claim.
      Приёмка: Названный entrypoint использует общий claim; второй mutable owner store не остаётся.
      Затрагиваемые файлы: `integrations/resources/lhc/target.json`
  - V013 · ⏸ Отложено владельцем · (Прочитать тот же Task и результат после перезапуска) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V013B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Прочитать тот же Task и результат после перезапуска. Частный результат исходного V013: SDK wire types и SQLite backend без in-memory authority. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V013B.
      Приёмка: Task сохранён до ответа, polling после рестарта читает тот же ID/result. Клиент без Tasks capability отклоняется до создания исполнимой Task, постановки dispatch и native side effect; ошибка содержит effect=none и понятное исправление. Тест проверяет отсутствие submit и выполнения Task, не только код ответа. Это точка объединения всей цепочки V013A, V013B, V013.
      Затрагиваемые файлы: `crates/herder/src/mcp/tasks.rs`
  - V016 · ⏸ Отложено владельцем · (Проверить старый request_key после истечения Task) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V016B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить старый request_key после истечения Task. Частный результат исходного V016: Tombstone дедупликации/удалённого текста, правила expiry. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V016B.
      Приёмка: Истёкший Task и удалённый transcript не позволяют повтор request_key выполнить эффект. Это точка объединения всей цепочки V016A, V016B, V016.
      Затрагиваемые файлы: `crates/herder/src/store/retention.rs`
  - V020 · ⏸ Отложено владельцем · (Проверить недоступный origin без локального fallback) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V020B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить недоступный origin без локального fallback. Частный результат исходного V020: Peer auth, точный instance, deadline и сохранение errors; без local fallback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V020B.
      Приёмка: Две конфигурируемые ноды; чужой scope denied, недоступный origin остаётся unavailable. Это точка объединения всей цепочки V020A, V020B, V020.
      Затрагиваемые файлы: `crates/herder/src/peer/route.rs`
  - V027 · ⋯ В очереди · (Проверить ответ C вместо creator A и запрет чужого reply) · оценка 10 мин–15 мин · усилие не измерено · ждёт: Pure reply routing source32bc8099 принят, handoff Terra доставлен Astra. Осталось соединить PreparedReply с существующим fenced deliver/request_key и проверить реального consumer; native no-replay ещё не доказан. · волна 1 · зависит: V027A, V027B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Вход durable correspondence+resolve_reply_target и source32bc8099. Подключить готовый reply route к application: A creator B, C sender B; reply_to выбирает C из store. Проверка чужого recipient и reopen; не изобретать второй sender store.
      Приёмка: C→B и ответ B адресованы C; A creator не подменяется; чужой reply_to denied. Это точка объединения всей цепочки V027A, V027B, V027.
      Затрагиваемые файлы: `crates/herder/src/application/correspondence.rs`
      Результат: Source-only pure reply-route composition at final local commit 32bc8099, rebased onto current origin/main be341a2a. `prepare_reply` returns the stored sender route after verified identity and exact recipient/sender Write-grant checks. Targeted tests: 3 passed after rebase using a temporary module registration. The registration hunk was removed before commit; handoff attempt to shared owner failed because AppServerManager RPC was unavailable. No native submit, canonical deliver retry proof, deployment, or native consumer acceptance.
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:12:48+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b341-e06b-7583-8fd4-352423ca22cb
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: неизвестно; назначение не подтверждено (assignment_unknown)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - V041 · ✅ Готово · (Отклонить старого владельца и второй маршрут runner) · оценка 10 мин–15 мин · усилие не измерено · волна 2 · зависит: V041B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Отклонить старого владельца и второй маршрут runner. Частный результат исходного V041: Target-local lock, live claim check после lock, expected deployed revision. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V041B.
      Приёмка: Задержавшийся старый claim отвергнут; второй runner path запрещён конфигурацией. Это точка объединения всей цепочки V041A, V041B, V041.
      Затрагиваемые файлы: `crates/herder/src/ownership/release_runner.rs`
      Результат: Собрана V041 цепочка: target-local RAII lock, проверка expected descriptor revision/current claim под lock, отказ задержанному владельцу после release/reclaim и отказ runner при AuthorityRoute::Ssh (только локальный маршрут включён в данной реализации). Тест на изолированном authority подтвердил contender WouldBlock, повторный acquire после unlock, current owner accepted, неверный/stale claim PermissionDenied, устаревшая revision WouldBlock, remote route Unsupported. cargo test ownership::release_runner::tests:: — 1 passed после rebase на свежий origin/main e4e8f8ae; diff-check чистый. Commit 662b7ad1, только release_runner.rs; передан Терe. Реальный deployment effect/доставка не запускались в этом leaf.
  - V044A · ✅ Готово · (Собрать self, creator и последних отправителей из durable данных) · оценка 10 мин–15 мин · усилие не измерено · волна 16 · зависит: V027A, V027B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Прочитать self/creator/последних sender из существующих durable lineage/correspondence. Выход — одна ограниченная context projection с IDs/freshness и ACL, без текста чужих диалогов. Проверка reopen существующей SQLite fixture; source-only не выдавать за model injection.
      Приёмка: Получен проверяемый результат: Собрать self, creator и последних отправителей из durable данных. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/context.rs`
      Результат: Committed 5a8bcd65c7bc758be34d97be2a5e7b2d42b398f6 adding only crates/herder/src/application/context.rs. project_self_context reuses existing Writer lineage/messages/intents, requires verified self plus exact session Read ACL, returns IDs and original source timestamps only (no correspondence text), bounds recent senders at 8, and distinguishes creator missing and sender missing/complete/partial. Existing SQLite create/close/reopen fixture, recipient ACL denial, private-text exclusion and partial cap tests: 3 passed. Evidence: evidence/v044a-context-source-green.txt. Tests used temporary module export, removed before commit. Export hunk sent to Terra; no shared lib/Cargo/schema diff. Model-visible injection and runtime acceptance are not proven.
  - V055A2 · ✅ Готово · (Codex: Добавить exact native turn interrupt adapter) · оценка 15 мин · усилие 11 мин по часам · по часам 11 мин · волна 16 · зависит: V053, V055A1 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Реализовать bounded stop adapter slice в crates/herder/src/adapters/codex/control.rs: проверять адрес instance/thread и точный active turn через read-only thread/turns/list; выполнять ровно один turn/interrupt для переданного turn_id; pre-send refusal отделять от UNKNOWN, а при неопределённом результате делать только read-only exact-turn readback без повтора. Не менять HumanStop core/store, create.rs или чужой leaf.
      Приёмка: Unit/fake-server tests доказывают точную пару thread/turn, mismatch/stale отказ до interrupt, один interrupt при timeout, и readback interrupted против inProgress. Формат request/response соответствует локальной официальной schema. Rustfmt и scoped tests проходят. Изолированный live test only when test profile isolated; иначе явно ограничить доказательство fixtures.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/control.rs`
      Результат: Добавлен `CodexControl::interrupt_exact(&SessionAddress, native_turn_id)` в `crates/herder/src/adapters/codex/control.rs`, commit `c261af7b`. Перед send сверяются точный instance/thread/turn, и read-only thread/turns/list подтверждает active status; stale/mismatch отказываются до interrupt. Отправляется ровно один turn/interrupt; pre-send/remote refusal отделён от transport UNKNOWN, после неопределённой отправки выполняется только read-only exact-turn readback: interrupted подтверждается, inProgress/ошибка остаются UNKNOWN без retry. Fake-server тесты: 7/7 прошли; rustfmt +stable --edition 2024 --check и git diff --check прошли. RED/GREEN для ETXTBSY fixture зарегистрирован и закрыт (bug Ba9635d8b1c884ec8a969), доказательства в плане .tmp/v055a2. Не доказаны экспорт control-модуля, live isolated Codex interrupt, интеграция с HumanStop authority/core, public MCP или общий HumanStop PASS. Commit создан в переданной detached worktree, не опубликован в ветку.
  - V057 · ⏸ Отложено владельцем · (Codex: Сверить export и search с исходной историей) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V057B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: Сверить export и search с исходной историей. Частный результат исходного V057: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V057B.
      Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected. Это точка объединения всей цепочки V057A, V057B, V057.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/transcript.rs`
  - V072E · ⛔ Заблокировано · (ZCode: Независимо прочитать native history Rust reader-ом) · оценка 10 мин–15 мин · усилие не измерено · волна 12 · зависит: V072D · стоимость — модель не выбрана · лист не назвал ни модель, ни класс · блокер: V072D produced no recoverable native session IDs, and its mutation outcome is UNKNOWN; the independent Rust read cannot target a specific session without those IDs.
      Описание задачи: Подключить Rust ZcodeSessionReader к тому же exact supervisor, прочитать обе сессии через existing-only readSession и сверить IDs, roles, text, parent/turn refs с native test source.
      Приёмка: Две независимые Rust reads возвращают собственные user/assistant сообщения и подтверждённые refs; snapshots остаются в scope exact instance/session; live receipt и cleanup доказаны.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/read.rs`
      Сохранённый статус: blocked
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T11:43:53+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b39a-83ab-7ea2-a343-25d92b900488
      Плановая модель: неизвестно
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; записан блокер (external_blocked)
      Незавершённые зависимости: V072D
      Причина ожидания / доставки: leaf: V072D produced no recoverable native session IDs, and its mutation outcome is UNKNOWN; the independent Rust read cannot target a specific session without those IDs.
  - V084 · ⏸ Отложено владельцем · (ChatGPT: Сверить export и search с исходной историей) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V084B · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Сверить export и search с исходной историей. Частный результат исходного V084: Подтверждённая native history route, snapshot cursor/raw blocks, feed индекса. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V084B.
      Приёмка: Первая/последняя страница и role blocks не теряются; чужой cursor rejected. Это точка объединения всей цепочки V084A, V084B, V084.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/transcript.rs`
  - R005A · ⏸ Отложено владельцем · (Подключить существующую точку управления S21 к resource claim: точный вход) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: R004, V041 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сначала назвать точный действующий вход s21-lease/runner и владельца пути; использовать одну authority владения; переключение исключает два параллельных writer. Без тестовых звонков.
      Приёмка: Записаны callable entrypoint, writer, разрешённые paths и сценарий проверки. Недоступность — точный blocker.
      Затрагиваемые файлы: `integrations/resources/s21/target.json`
  - R006 · ⏸ Отложено владельцем · (Подключить владение планом LHC к общему resource) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: R006B · стоимость — вне сметы · отложено владельцем
      Описание задачи: LHC хранит план и историю; Herder хранит external_ref и владельца редактирования. Запись LHC проверяет claim.
      Приёмка: Два редактора одного plan ref получают конфликт; читать разрешено по ACL; содержимое плана не копируется в Herder.
      Затрагиваемые файлы: `integrations/resources/lhc/target.json`
  - T012 · ⏸ Отложено владельцем · (Проверить межсессионную изоляцию translator на real Herder) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: T011, V013, V017 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Реализовать только этот проверяемый шаг по COMPATIBILITY.md. Входы: T011, V013, V017. При неизвестном SDK/consumer маршруте сначала назвать минимальный пробел; не форкать Codex.
      Приёмка: Два разрешённых test caller не видят чужие Task/resources, нет повышения privilege и секретов в errors.
      Затрагиваемые файлы: `crates/herder-compat/`, `acceptance/compat/`
  - V014A · ⏸ Отложено владельцем · (Сохранять pending input и однократное принятие ответа) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V013 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сохранять pending input и однократное принятие ответа. Частный результат исходного V014: Persist pending inputs и ответы по ключам; cancel intent отдельно от effect outcome. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V013.
      Приёмка: Получен проверяемый результат: Сохранять pending input и однократное принятие ответа. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/store/task_inputs.rs`
  - V021A · ⏸ Отложено владельцем · (Сохранять origin Task ref без второго lifecycle) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V020, V013, V017 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сохранять origin Task ref без второго lifecycle. Частный результат исходного V021: Origin Task ref и маршрутизация standard polling/cancel/read по ACL. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V020, V013, V017.
      Приёмка: Получен проверяемый результат: Сохранять origin Task ref без второго lifecycle. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/peer/tasks.rs`
  - V023A · ⏸ Отложено владельцем · (Проверять instance, права и capability перед локальным create) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V022, V006, V013 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверять instance, права и capability перед локальным create. Частный результат исходного V023: Application create проверяет capability/auth и связывает intent с native ID. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V022, V006, V013.
      Приёмка: Получен проверяемый результат: Проверять instance, права и capability перед локальным create. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/create.rs`
  - V024A · ⏸ Отложено владельцем · (Разобрать current, queue и start без подмены режима) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V012, V013, V015, V006 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Разобрать current, queue и start без подмены режима. Частный результат исходного V024: current/queue/start, expected turn; implicit create и delayed send отсутствуют. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V012, V013, V015, V006.
      Приёмка: Получен проверяемый результат: Разобрать current, queue и start без подмены режима. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/deliver.rs`
  - V042A · ✅ Готово · (Записать request_key и durable receipt до spawn) · оценка 10 мин–15 мин · усилие 4 мин по часам · по часам 4 мин · волна 17 · зависит: V041 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Записать request_key и durable receipt до spawn. Частный результат исходного V042: Request key/hash, admitted/confirmed/unknown; child удерживает execution lock. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V041.
      Приёмка: Получен проверяемый результат: Записать request_key и durable receipt до spawn. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/ownership/release_receipt.rs`
      Результат: Добавлен ownership::release_receipt::admit: под удерживаемым TargetExecutionLock перепроверяет актуальную revision и claim ID, затем до spawn пишет в authority `release-receipts/<request_key>.json` immutable receipt со статусом admitted, storage/resource/claim identities, UUID request_key и 64-char request_hash. Файл mode 0600, sync_all + directory fsync. Точный повтор того же key/payload возвращает исходный receipt; тот же key с иным hash отклоняется InvalidInput. Изолированный тест прошёл после rebase на origin/main fa84e08c: cargo test ownership::release_receipt::tests:: — 1 passed; diff-check чистый. Commit 48fd3744; затронуты lib.rs (одна строка export) и новый release_receipt.rs. Интеграция передана Терe. Child spawn/lock transfer и readback outcome пока не доказаны, они следующие leaves V042B/V042.
  - V044B · ⋯ В очереди · (Добавить peers, worktrees и занятые ресурсы с coverage) · оценка 10 мин–15 мин · усилие не измерено · ждёт: причина не названа · волна 17 · зависит: V044A, V031C · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Добавить к той же context projection уже готовые inventory peers/worktrees/resource claims; explicit observed_at/partial/offline. Не создавать отдельный roster store. Проверка двух peers, один недоступен: отсутствие данных не означает 'я один'.
      Приёмка: Получен проверяемый результат: Добавить peers, worktrees и занятые ресурсы с coverage. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/context.rs`
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:12:44+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b399-4210-7471-8286-93750dff10b7
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; ждёт зависимостей (dependencies_unmet)
      Незавершённые зависимости: V031C
      Причина ожидания / доставки: не записана
  - V055A3 · ✅ Готово · (Codex: Проверить exact interrupt на двух isolated native turns) · оценка 15 мин · усилие 17 мин по часам · по часам 17 мин · волна 17 · зависит: V055A2 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Новый isolated Codex CODEX_HOME и loopback fake model с hold/release: получить два активных native turn в разных threads, вызвать interrupt_exact ровно для первого и независимым native thread/turn readback подтвердить interrupted для первого и отсутствие воздействия на второй; после release второй должен завершиться. Не использовать operator profile, credentials, production provider и старые завершённые threads. Один interrupt; UNKNOWN — только readback.
      Приёмка: Доказано на Codex app-server 0.167.0 в отдельном network namespace, где существует только lo: новый CODEX_HOME, fixture-only loopback endpoint, два свежих native thread/turn с обоими статусами inProgress; выполнен один interrupt_exact для точного turn A; нативный thread/turns/list readback через действующее соединение показывает A interrupted и B inProgress; после release B завершается с fixture assistant marker, A остаётся interrupted. Затем отдельный Codex app-server выполняет независимые read-only thread/turns/list и thread/items/list уже после settle: A interrupted, B completed, marker совпадает, новых model requests 0. UNKNOWN не возникал, retry не выполнялся; все процессы теста завершены.
      Затрагиваемые файлы: `.tmp/v055a3/*`
      Результат: Native acceptance прошла на source, точно совпадающем с интегрированным commit d52e3ac5: SHA256 crates/herder/src/adapters/codex/control.rs = 7a6dfdc0f3cedecff9b870ae090e25762622e455daf69fcc58912f718be28b78. Proof `.tmp/v055a3/native-proof.json`, тестовый лог `.tmp/v055a3/native-test.log`, independent readback `.tmp/v055a3/independent-readback.log`; полный scoped runner и локальная модель также сохранены в `.tmp/v055a3/`. Network namespace показал только lo. Результат: A inProgress → interrupt_exact(точные instance/thread/turn) → interrupted; B оставался inProgress и завершился с HERDER_TEST_MODEL_OK; независимый второй native app-server после завершения подтвердил A interrupted и B completed без новых model requests. Один вызов interrupt_exact, UNKNOWN отсутствовал, повторов не было. Подтверждён cleanup: fixture и scoped Codex app-server child завершены; посторонний app-server proxy не тронут. Ранее провалившийся probe запускал второй app-server на том же активном CODEX_HOME; это исправлено в acceptance harness и bug B9e7dea2e16624d1b8910 закрыт RED/GREEN. Не проверялась общая интеграция HumanStop authority, пользовательский MCP или full HumanStop PASS.
  - V078A · ⏸ Отложено владельцем · (ZCode: Установить текущий dev artifact в изолированный native контур) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V072E · стоимость — вне сметы · отложено владельцем
      Описание задачи: ZCode: Установить текущий dev artifact в изолированный native контур. Частный результат исходного V078: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V072, V074, V075, V076, V077, V051, V016.
      Приёмка: Получен проверяемый результат: ZCode: Установить текущий dev artifact в изолированный native контур. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/native/zcode/`
  - V129A · ⏸ Отложено владельцем · (Сопоставить сохраняемые поля holds, intents и receipts) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V011, V022, V027, R001 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сопоставить сохраняемые поля holds, intents и receipts. Частный результат исходного V129: Узкие схемы только сохраняемого state: holds/intents/lineage/messages/settings/ownership. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V011, V022, V027, R001.
      Приёмка: Получен проверяемый результат: Сопоставить сохраняемые поля holds, intents и receipts. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `migration/state-map.md`
  - R005B · ⏸ Отложено владельцем · (Подключить существующую точку управления S21 к resource claim: единая проверка владения) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: R005A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сначала назвать точный действующий вход s21-lease/runner и владельца пути; использовать одну authority владения; переключение исключает два параллельных writer. Без тестовых звонков.
      Приёмка: Названный entrypoint использует общий claim; второй mutable owner store не остаётся.
      Затрагиваемые файлы: `integrations/resources/s21/target.json`
  - T013 · ⏸ Отложено владельцем · (Пройти стандартные Tasks/Skills/listen через real Herder и Codex) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: T012, V018, V019 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Реализовать только этот проверяемый шаг по COMPATIBILITY.md. Входы: T012, V018, V019. При неизвестном SDK/consumer маршруте сначала назвать минимальный пробел; не форкать Codex.
      Приёмка: Реальный native Herder хранит один Task через restart translator; read/input/cancel/Skill/resync подтверждены trace.
      Затрагиваемые файлы: `crates/herder-compat/`, `acceptance/compat/`
  - V014B · ⏸ Отложено владельцем · (Провести cancel через intent с отдельным исходом эффекта) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V014A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Провести cancel через intent с отдельным исходом эффекта. Частный результат исходного V014: Persist pending inputs и ответы по ключам; cancel intent отдельно от effect outcome. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V014A.
      Приёмка: Получен проверяемый результат: Провести cancel через intent с отдельным исходом эффекта. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/store/task_inputs.rs`
  - V021B · ⏸ Отложено владельцем · (Маршрутизировать get, cancel и resource read к origin) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V021A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Маршрутизировать get, cancel и resource read к origin. Частный результат исходного V021: Origin Task ref и маршрутизация standard polling/cancel/read по ACL. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V021A.
      Приёмка: Получен проверяемый результат: Маршрутизировать get, cancel и resource read к origin. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/peer/tasks.rs`
  - V023B · ⏸ Отложено владельцем · (Связать сохранённый intent с native session ID) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V023A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Связать сохранённый intent с native session ID. Частный результат исходного V023: Application create проверяет capability/auth и связывает intent с native ID. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V023A.
      Приёмка: Получен проверяемый результат: Связать сохранённый intent с native session ID. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/create.rs`
  - V024B · ⏸ Отложено владельцем · (Отправлять сохранённый intent с expected turn) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V024A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Отправлять сохранённый intent с expected turn. Частный результат исходного V024: current/queue/start, expected turn; implicit create и delayed send отсутствуют. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V024A.
      Приёмка: Получен проверяемый результат: Отправлять сохранённый intent с expected turn. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/deliver.rs`
  - V042B · ✅ Готово · (Передать удержание execution lock процессу изменения) · оценка 10 мин–15 мин · усилие 4 мин по часам · по часам 4 мин · волна 18 · зависит: V042A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Передать удержание execution lock процессу изменения. Частный результат исходного V042: Request key/hash, admitted/confirmed/unknown; child удерживает execution lock. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V042A.
      Приёмка: Получен проверяемый результат: Передать удержание execution lock процессу изменения. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/ownership/release_receipt.rs`
      Результат: Добавлен `spawn_with_execution_lock`: на Unix дочерний процесс получает дубликат уже захваченного target lock fd на зарезервированный descriptor 198; родительский handle можно закрыть после spawn, lock удерживается процессом до выхода. Результат записывает `HERDER_EXECUTION_LOCK_FD`; не-Unix route отказывает Unsupported. Изолированный child process test: после spawn contender получает WouldBlock, после завершения child lock доступен. Receipt admission/replay/hash checks также прошли в том же тесте. Проверка после rebase на origin/main d48aa421: cargo test ownership::release_receipt::tests:: — 1 passed; diff-check чистый. Commit 84a339cb, затронуты Cargo.toml/Cargo.lock, release_runner.rs и release_receipt.rs. Передано Терe. Проверка UNKNOWN после смерти родителя — следующий V042.
  - V044 · ⏸ Отложено владельцем · (Проверить ограниченный context с курсорами без скрытых участников) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V044B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить ограниченный context с курсорами без скрытых участников. Частный результат исходного V044: Один bounded snapshot с адресами, scopes, coverage и курсорами. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V044B.
      Приёмка: A creator и C sender восстанавливаются без transcript memory; чужие closed sessions скрыты. Это точка объединения всей цепочки V044A, V044B, V044.
      Затрагиваемые файлы: `crates/herder/src/application/context.rs`
  - V045A · ⋯ В очереди · (Сохранить разрешённую проекцию context в JSON) · оценка 10 мин–15 мин · усилие не измерено · ждёт: причина не названа · волна 18 · зависит: V044B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Записать разрешённый context JSON snapshot атомарно рядом с каноническим manifest, указав generated_at/partial/authority location. Проверка чтения при выключенном тестовом MCP; snapshot не даёт owner authority и не содержит секретов. Existing claim library reuse.
      Приёмка: Получен проверяемый результат: Сохранить разрешённую проекцию context в JSON. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/ownership/context_snapshot.rs`
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=неизвестно · session_id=неизвестно; source=unknown; at=2026-11-07T16:12:46+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b399-4210-7471-8286-93750dff10b7
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; ждёт зависимостей (dependencies_unmet)
      Незавершённые зависимости: V044B
      Причина ожидания / доставки: не записана
  - V055PIPE · ✅ Готово · (Codex: ограничить запись запроса общим deadline) · оценка 15 мин · усилие 7 мин по часам · по часам 7 мин · волна 18 · зависит: V055A3 · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Подготовительный дефект V055BOUND: stdin.write_all/flush в connection.request выполняются до deadline и могут зависнуть на backpressure. Один owner Codex; core/launcher не менять.
      Приёмка: Детерминированный RED с не читающим fixture app-server; GREEN возвращает bounded failure при заполненной pipe без surviving local writer. Deadline учитывает write+read; при частичной/возможной отправке UNKNOWN и без replay. Сохранить корректный полный JSON framing либо признать соединение непригодным после частичного write; не продолжать повреждённый stream.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/connection.rs`, `crates/herder/src/adapters/codex/control.rs`
      Результат: origin/main f18149d3, после SUPPORTED review: 100ms deadline включает pipe write и response; stalled pipe RED >700ms, GREEN ~110ms; частичная запись инвалидирует stdin, existing error mapping UNKNOWN; 10 Codex tests. Mutex/startup вне scope.
  - V078B · ⏸ Отложено владельцем · (ZCode: Пройти create, deliver, read и export через публичный MCP) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V078A · стоимость — вне сметы · отложено владельцем
      Описание задачи: ZCode: Пройти create, deliver, read и export через публичный MCP. Частный результат исходного V078: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V078A.
      Приёмка: Получен проверяемый результат: ZCode: Пройти create, deliver, read и export через публичный MCP. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/native/zcode/`
  - V129B · ⏸ Отложено владельцем · (Сопоставить lineage, settings, сообщения и resource refs) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V129A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сопоставить lineage, settings, сообщения и resource refs. Частный результат исходного V129: Узкие схемы только сохраняемого state: holds/intents/lineage/messages/settings/ownership. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V129A.
      Приёмка: Получен проверяемый результат: Сопоставить lineage, settings, сообщения и resource refs. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `migration/state-map.md`
  - R005 · ⏸ Отложено владельцем · (Подключить существующую точку управления S21 к resource claim) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: R005B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сначала назвать точный действующий вход s21-lease/runner и владельца пути; использовать одну authority владения; переключение исключает два параллельных writer. Без тестовых звонков.
      Приёмка: Обычная точка управления проверяет актуальный claim и отвергает старого владельца; доказано чтением разрешённого тестового состояния, без звонков или уведомлений человеку.
      Затрагиваемые файлы: `integrations/resources/s21/target.json`
  - T014 · ⏸ Отложено владельцем · (Удалить compatibility из тестовой сборки и проверить native путь) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: T013, V010 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Реализовать только этот проверяемый шаг по COMPATIBILITY.md. Входы: T013, V010. При неизвестном SDK/consumer маршруте сначала назвать минимальный пробел; не форкать Codex.
      Приёмка: Без legacy crate/config native build и direct read/create/deliver остаются работоспособны; native core не зависит от translator.
      Затрагиваемые файлы: `crates/herder-compat/`, `acceptance/compat/`
  - V014 · ⏸ Отложено владельцем · (Проверить повтор input и отмену уже принятой операции) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V014B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить повтор input и отмену уже принятой операции. Частный результат исходного V014: Persist pending inputs и ответы по ключам; cancel intent отдельно от effect outcome. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V014B.
      Приёмка: Повтор input не продолжает дважды; cancel после admission не выдаёт отмену эффекта. Это точка объединения всей цепочки V014A, V014B, V014.
      Затрагиваемые файлы: `crates/herder/src/store/task_inputs.rs`
  - V021 · ⏸ Отложено владельцем · (Проверить proxy restart и запрет чужого результата) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V021B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить proxy restart и запрет чужого результата. Частный результат исходного V021: Origin Task ref и маршрутизация standard polling/cancel/read по ACL. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V021B.
      Приёмка: Proxy restart не дублирует native intent; origin task/result остаются теми же. Это точка объединения всей цепочки V021A, V021B, V021.
      Затрагиваемые файлы: `crates/herder/src/peer/tasks.rs`
  - V023 · ⏸ Отложено владельцем · (Подтвердить одну созданную сессию точным readback) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V023B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить одну созданную сессию точным readback. Частный результат исходного V023: Application create проверяет capability/auth и связывает intent с native ID. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V023B.
      Приёмка: Fake native create вызывается один раз; completion только после session readback. Это точка объединения всей цепочки V023A, V023B, V023.
      Затрагиваемые файлы: `crates/herder/src/application/create.rs`
  - V024 · ⏸ Отложено владельцем · (Подтвердить busy и unsupported без неявного create) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V024B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить busy и unsupported без неявного create. Частный результат исходного V024: current/queue/start, expected turn; implicit create и delayed send отсутствуют. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V024B.
      Приёмка: Busy/unsupported не подменяют режим; persisted intent предшествует submit. Это точка объединения всей цепочки V024A, V024B, V024.
      Затрагиваемые файлы: `crates/herder/src/application/deliver.rs`
  - V042 · ✅ Готово · (Проверить смерть родителя и UNKNOWN без повторного запуска) · оценка 10 мин–15 мин · усилие 2 мин по часам · по часам 2 мин · волна 2 · зависит: V042B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Проверить смерть родителя и UNKNOWN без повторного запуска. Частный результат исходного V042: Request key/hash, admitted/confirmed/unknown; child удерживает execution lock. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V042B.
      Приёмка: Crash родителя не отпускает live child; unknown external effect блокирует новый конфликтующий effect. Это точка объединения всей цепочки V042A, V042B, V042.
      Затрагиваемые файлы: `crates/herder/src/ownership/release_receipt.rs`
      Результат: V042 завершён: durable receipt допускает первый spawn только при `newly_admitted=true`; повтор того же key/hash возвращает `newly_admitted=false`, changed hash отклоняется. Child получает наследуемый target-lock fd; после закрытия родительского handle contender всё ещё блокирован до выхода child. После выхода и reacquire target lock `resolve_after_lock` переводит оставшийся admitted receipt в UNKNOWN. Повтор исходного key не разрешает spawn; новый конфликтующий request на этот target блокируется WouldBlock; terminal UNKNOWN нельзя переписать CONFIRMED. Проверка после rebase на origin/main 01426b46: focused receipt test 1 passed; cargo check --bin herder и diff-check чистые. Commit 3ab3bffc включает предыдущий V042B `spawn_with_execution_lock`; передан Терe. Доказан отказ replay и lifetime lock semantics; дочерний production effect/consumer ещё не подключён.
  - V045B · ⏸ Отложено владельцем · (Показывать generated_at и partial при offline чтении) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V045A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Показывать generated_at и partial при offline чтении. Частный результат исходного V045: Atomic JSON projection c generated_at, coverage и безопасными routes. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V045A.
      Приёмка: Получен проверяемый результат: Показывать generated_at и partial при offline чтении. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/ownership/context_snapshot.rs`
  - V055BOUND · ✅ Готово · (Codex: предоставить штатный bounded create/submit порт) · оценка 15 мин · усилие не измерено · волна 19 · зависит: V055PIPE · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Выделенная native часть V025PROD, выполняется владельцем Codex. Вывести существующий synchronous bounded RPC из async-only оболочки в обычные методы, которые используют и native trait, и HumanStop composition. Без test-only poll-once и без нового writer.
      Приёмка: Штатные bounded методы create/submit сохраняют exact instance/ref, timeout и DefinitelyNotSent/UNKNOWN. Вызов возвращается только после ограниченного native RPC; никакой отложенный writer не получает возможность писать после возврата. Async port переиспользует тот же код. Fake tests подтверждают один native write и no replay; production MCP proof отдельно.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/control.rs`, `crates/herder/src/adapters/codex/create.rs`
      Результат: origin/main d317129c: sync Codex create/submit и busy try_lock, Linux cfg; независимый review SUPPORTED, 11 Codex tests. Mac build и production MCP не доказаны; create classification и interrupt вынесены.
  - V129 · ⏸ Отложено владельцем · (Зафиксировать writers и отказ от угадывания происхождения) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V129B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Зафиксировать writers и отказ от угадывания происхождения. Частный результат исходного V129: Узкие схемы только сохраняемого state: holds/intents/lineage/messages/settings/ownership. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V129B.
      Приёмка: Unknown provenance остаётся unknown; список active writers и read-only export для этих схем назван. Это точка объединения всей цепочки V129A, V129B, V129.
      Затрагиваемые файлы: `migration/state-map.md`
  - V025A · ⏸ Отложено владельцем · (Записать HumanStop перед попыткой interrupt) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V024 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Записать HumanStop перед попыткой interrupt. Частный результат исходного V025: Durable hold перед interrupt; dispatch/stop сериализуют admission. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V024.
      Приёмка: Получен проверяемый результат: Записать HumanStop перед попыткой interrupt. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/stop.rs`
  - V025PORT · ✅ Готово · (Codex: bounded handoff под scoped gate) · оценка 10 мин–15 мин · усилие 1 ч 04 мин по часам · по часам 1 ч 04 мин · волна 20 · зависит: V025GUARD1, V055BOUND · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Реальный transport выполняет ограниченный native submit, пока gate удерживается; завершает все отправляющие операции до освобождения gate.
      Приёмка: Barrier tests доказывают handoff/stop ordering, ошибки до отправки и UNKNOWN без повтора; тесты штатного Codex port.
      Результат: origin/main 03eccbc2: live fixture uses actual Codex bounded traits under scoped guard, 19 unit/barrier tests + isolated native test pass; unique thread/turn readback interrupted and next claim denied. Independent Astra review SUPPORTED; public MCP composition not proven.
  - V034A · ⏸ Отложено владельцем · (Прочитать конкретный pending native permission request) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V014, V008, V006 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Прочитать конкретный pending native permission request. Частный результат исходного V034: Pending request identity и authorized answer, без wildcard approvals. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V014, V008, V006.
      Приёмка: Получен проверяемый результат: Прочитать конкретный pending native permission request. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/permission.rs`
  - V043A · ✅ Готово · (Воспроизвести смену owner во время принятого release) · оценка 10 мин–15 мин · усилие 4 мин по часам · по часам 4 мин · волна 20 · зависит: V042 · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Воспроизвести смену owner во время принятого release. Частный результат исходного V043: Test runner делает безопасный локальный file revision effect; delay/crash/partition. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V042.
      Приёмка: Получен проверяемый результат: Воспроизвести смену owner во время принятого release. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `tests/ownership/release_races.rs`
      Результат: Создан isolated file-effect reproduction: owner A проходит durable admission, claim A снимается и ресурс захватывает B, после чего незаменённый `spawn_with_execution_lock` всё ещё выполняет child effect под старым admitted claim. Readback подтверждает effect-файл `x` и текущего owner B. Это наблюдаемый дефект границы admission→spawn; исправление остаётся V043B. Проверка после rebase на origin/main 3c56a3f3: cargo test --lib claim::crash_tests::release_races:: — 1 passed; diff-check чистый. Commit 9040bcb6, только crash.rs модульная регистрация и новый tests/ownership/release_races.rs.
  - V045 · ⏸ Отложено владельцем · (Подтвердить отсутствие закрытых текстов и owner authority в snapshot) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V045B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить отсутствие закрытых текстов и owner authority в snapshot. Частный результат исходного V045: Atomic JSON projection c generated_at, coverage и безопасными routes. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V045B.
      Приёмка: Без daemon читается stale snapshot; это не owner или delivery receipt. Это точка объединения всей цепочки V045A, V045B, V045.
      Затрагиваемые файлы: `crates/herder/src/ownership/context_snapshot.rs`
  - V055A · ⏸ Отложено владельцем · (Codex: Вызвать native create из общего application) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V053, V023 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: Вызвать native create из общего application. Частный результат исходного V055: Одна native create route; request correlation и readback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V053, V023.
      Приёмка: Получен проверяемый результат: Codex: Вызвать native create из общего application. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/create.rs`
  - V055CREATE · ✅ Готово · (Сохранить доказанное отсутствие native create) · оценка 10 мин–15 мин · усилие 8 мин по часам · по часам 8 мин · волна 20 · зависит: V055BOUND · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Протянуть типизированные DefinitelyNotSent и UNKNOWN от Codex thread/start через bounded create и durable intent.
      Приёмка: RED/GREEN: busy/pre-write отказ сохраняется как definitely-not-sent без повтора старого key; неизвестный исход остаётся UNKNOWN без replay.
      Результат: origin/main 309fd821: typed definitely-not-sent на async и scoped bounded пути, атомарно rejected+Task result reason, no replay прежнего key; независимое review SUPPORTED, 28 tests pass +1 ignored. Task lifecycle status и человекочитаемая public диагностика требуют проверки на V025PUBLIC.
  - V055STOP · ✅ Готово · (Ограничить native interrupt общим сроком) · оценка 10 мин–15 мин · усилие не измерено · волна 20 · зависит: V055BOUND · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Ограничить весь путь exact interrupt, включая ожидание control mutex и дополнительные readback запросы.
      Приёмка: Barrier tests busy и timeout: корректный неизвестный исход без повторного interrupt, deadline охватывает весь путь.
      Результат: origin/main 9eafde2d: bounded interrupt с try_lock и единым deadline через status pages, одну отправку и readback; 13 Codex tests passed, независимый review SUPPORTED. Реальный MCP stop пока не доказан.
  - V064A · ⏸ Отложено владельцем · (OpenCode: подключить готовый create через минимальный AHAP bridge) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V062, V023, V064PORT · стоимость — вне сметы · отложено владельцем
      Описание задачи: Новый functional application вызывает existing OpenCodeAdapter.createSession через тонкий AHAP runner/client. Переиспользовать AHAPv0.1 и native logic; не переписывать OpenCode transport. Core authority/mapping у Terra, runner/adapter seam у существующего OpenCode owner.
      Приёмка: Fake AHAP→existing adapter invocation с exact instance/request/session binding; one create, unsupported до эффекта, uncertain result не повторяется. Реальный public readback остаётся V064. Источники/commit/проверка записаны; общий core glue отдельно у Terra.
      Затрагиваемые файлы: `src/ahap-opencode-runner.ts`, `tests/ahap-opencode-runner.test.ts`
      Результат: Минимальный TS AHAP runner переиспользует OpenCodeAdapter; protocol v2 pinned, Queue suppresses implicit wake, native message ID retained, mutation exceptions unknown, null/scalar/array frames handled. Source commits a3a514fa+c3b5aa58, source-only. Public/native consumer ещё не доказан.
  - V073A · ⏸ Отложено владельцем · (ZCode: Вызвать native create из общего application) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V071, V023, V073PORT · стоимость — вне сметы · отложено владельцем
      Описание задачи: ZCode: Вызвать native create из общего application. Частный результат исходного V073: Одна native create route; request correlation и readback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V071, V023.
      Приёмка: Получен проверяемый результат: ZCode: Вызвать native create из общего application. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/create.rs`
  - V082A · ⏸ Отложено владельцем · (ChatGPT: Вызвать native create из общего application) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V080, V023 · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Вызвать native create из общего application. Частный результат исходного V082: Одна native create route; request correlation и readback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V080, V023.
      Приёмка: Получен проверяемый результат: ChatGPT: Вызвать native create из общего application. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/create.rs`
  - V091A · ⏸ Отложено владельцем · (Z.ai: Вызвать native create из общего application) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V089, V023 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Z.ai: Вызвать native create из общего application. Частный результат исходного V091: Одна native create route; request correlation и readback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V089, V023.
      Приёмка: Получен проверяемый результат: Z.ai: Вызвать native create из общего application. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/create.rs`
  - V119A · ⏸ Отложено владельцем · (ExManager Board: найти один вызывающий Herder маршрут и владельца путей) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V009, V023, V024 · стоимость — вне сметы · отложено владельцем
      Описание задачи: ExManager Board: найти один вызывающий Herder маршрут и владельца путей. Частный результат исходного V119: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V009, V023, V024.
      Приёмка: Получен проверяемый результат: ExManager Board: найти один вызывающий Herder маршрут и владельца путей. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `integrations/consumers/board/target.json`
  - V130A · ⏸ Отложено владельцем · (Импортировать HumanStop и неизменные request keys) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V129, V016 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Импортировать HumanStop и неизменные request keys. Частный результат исходного V130: Offline importer сохраняет request keys, неизвестные исходы и tombstones; не исполняет ничего. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V129, V016.
      Приёмка: Получен проверяемый результат: Импортировать HumanStop и неизменные request keys. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `migration/import_effects.rs`
  - V131A · ⏸ Отложено владельцем · (Преобразовать creator, native parent и sender отдельно) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V129 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Преобразовать creator, native parent и sender отдельно. Частный результат исходного V131: Explicit schema transform, sender evidence, потерянный текст помечен. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V129.
      Приёмка: Получен проверяемый результат: Преобразовать creator, native parent и sender отдельно. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `migration/import_context.rs`
  - V025B · ⏸ Отложено владельцем · (Сериализовать hold и dispatch на admission boundary) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V025A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сериализовать hold и dispatch на admission boundary. Частный результат исходного V025: Durable hold перед interrupt; dispatch/stop сериализуют admission. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V025A.
      Приёмка: Получен проверяемый результат: Сериализовать hold и dispatch на admission boundary. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/stop.rs`
  - V025OWNER · ✅ Готово · (Подключить явный trusted owner stdio profile) · оценка 10 мин–15 мин · усилие не измерено · волна 21 · зависит: V025LAUNCH, V025PORT · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Проверенный source результат V025COMPOSE: owner policy на existing ledger, динамические exact grants и real Codex port composition в штатном launcher.
      Приёмка: Protected explicit profile, default Unknown/self=None, exact receipt membership/current generation и source fake stdio create/read/reopen/import deny. Native consumer отдельно.
      Результат: a3517774 поверх NativeReader d6cb17b4: independent Nietzsche SUPPORTED,2 policy+2 launcher tests PASS. Exact protected profile/instance/principal/receipt/scopes/generation, DB/gate inode recheck, no nested gate/no second grants store. Real reader DTO source compatible. Fake RPC only; прямой Task current grants/reconciliation ещё у Tesla.
  - V025READHOLD · ✅ Готово · (Проверить scoped read и durable hold в MCP application) · оценка 10 мин–15 мин · усилие не измерено · волна 21 · зависит: V025LAUNCH, V025PORT · стоимость — модель не выбрана · лист не назвал ни модель, ни класс
      Описание задачи: Выделенный завершённый source срез V025COMPOSE: exact ACL/instance/scope read и stop под общим waiting gate.
      Приёмка: Fake wire и source review подтверждают read ACL, отказ imported scope и сохранение hold после handoff; native interruption и production ingress отдельно.
      Затрагиваемые файлы: `crates/herder/src/application/scoped_stop/mcp_read.rs`, `crates/herder/src/application/scoped_stop/mcp_stop.rs`, `crates/herder/tests/scoped_stop_gate.rs`
      Результат: e3fdac67+dde52b0b опубликованы main d21cf281+34c55e2d. Независимый review SUPPORTED после RED/GREEN исправления resolve-before-wait race. Stop валидирует exact scoped mapping и пишет durable hold под одним waiting gate; сообщает required_or_reconcile после handoff, не утверждает подтверждённый interrupt. Read exact grant отдельно от Write. Source/fake proof; production ingress не заявлен.
  - V034B · ⏸ Отложено владельцем · (Передать авторизованный ответ по точному request ID) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V034A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Передать авторизованный ответ по точному request ID. Частный результат исходного V034: Pending request identity и authorized answer, без wildcard approvals. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V034A.
      Приёмка: Получен проверяемый результат: Передать авторизованный ответ по точному request ID. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/permission.rs`
  - V043B · ✅ Готово · (Отклонить задержанный запрос прежнего владельца) · оценка 10 мин–15 мин · усилие 3 мин по часам · по часам 3 мин · волна 21 · зависит: V043A · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Отклонить задержанный запрос прежнего владельца. Частный результат исходного V043: Test runner делает безопасный локальный file revision effect; delay/crash/partition. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V043A.
      Приёмка: Получен проверяемый результат: Отклонить задержанный запрос прежнего владельца. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `tests/ownership/release_races.rs`
      Результат: Исправлена гонка admission→spawn. `claim::release` теперь сначала берёт target execution lock; новый claim не может сменить владельца, пока старый effect child держит lock. Добавлен `spawn_admitted`: требует newly_admitted=true, точный target, текущий claim ID и expected revision непосредственно перед spawn; низкоуровневый spawn скрыт за crate boundary. Race test: releaser блокируется на lock, после release новый principal B занимает ресурс; задержанный admission A затем отвергается PermissionDenied, effect-файл не создаётся, владелец B остаётся. Проверка на origin/main 3c56a3f3: `cargo test --lib ownership::` — 18 passed; `cargo check --bin herder`, diff-check чистые. Commit a35057e3; файлы claim.rs, release_receipt.rs, release_races.rs.
  - V055B · ⏸ Отложено владельцем · (Codex: Связать receipt с точным session ID) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V055A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: Связать receipt с точным session ID. Частный результат исходного V055: Одна native create route; request correlation и readback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V055A.
      Приёмка: Получен проверяемый результат: Codex: Связать receipt с точным session ID. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/create.rs`
  - V064B · ⏸ Отложено владельцем · (OpenCode: Связать receipt с точным session ID) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V064A · стоимость — вне сметы · отложено владельцем
      Описание задачи: OpenCode: Связать receipt с точным session ID. Частный результат исходного V064: Одна native create route; request correlation и readback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V064A.
      Приёмка: Получен проверяемый результат: OpenCode: Связать receipt с точным session ID. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/create.rs`
  - V073B · ⏸ Отложено владельцем · (ZCode: Связать receipt с точным session ID) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V073A · стоимость — вне сметы · отложено владельцем
      Описание задачи: ZCode: Связать receipt с точным session ID. Частный результат исходного V073: Одна native create route; request correlation и readback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V073A.
      Приёмка: Получен проверяемый результат: ZCode: Связать receipt с точным session ID. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/create.rs`
  - V082B · ⏸ Отложено владельцем · (ChatGPT: Связать receipt с точным session ID) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V082A · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Связать receipt с точным session ID. Частный результат исходного V082: Одна native create route; request correlation и readback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V082A.
      Приёмка: Получен проверяемый результат: ChatGPT: Связать receipt с точным session ID. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/create.rs`
  - V091B · ⏸ Отложено владельцем · (Z.ai: Связать receipt с точным session ID) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V091A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Z.ai: Связать receipt с точным session ID. Частный результат исходного V091: Одна native create route; request correlation и readback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V091A.
      Приёмка: Получен проверяемый результат: Z.ai: Связать receipt с точным session ID. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/create.rs`
  - V119 · ⏸ Отложено владельцем · (ExManager Board: записать target.json с точным контрактом и тестовым маршрутом) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V119A · стоимость — вне сметы · отложено владельцем
      Описание задачи: ExManager Board: записать target.json с точным контрактом и тестовым маршрутом. Частный результат исходного V119: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V119A.
      Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции. Это точка объединения всей цепочки V119A, V119.
      Затрагиваемые файлы: `integrations/consumers/board/target.json`
  - V125A · ⏸ Отложено владельцем · (Написать одну локальную инструкцию поиска authority и claim) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V019, V039, V045 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Написать одну локальную инструкцию поиска authority и claim. Частный результат исходного V125: Один исходник инструкции и manifest template; expose Skills и package local copy. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V019, V039, V045.
      Приёмка: Получен проверяемый результат: Написать одну локальную инструкцию поиска authority и claim. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `skills/herder-recovery/SKILL.md`
  - V130B · ⏸ Отложено владельцем · (Импортировать UNKNOWN и tombstones без запуска эффектов) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V130A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Импортировать UNKNOWN и tombstones без запуска эффектов. Частный результат исходного V130: Offline importer сохраняет request keys, неизвестные исходы и tombstones; не исполняет ничего. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V130A.
      Приёмка: Получен проверяемый результат: Импортировать UNKNOWN и tombstones без запуска эффектов. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `migration/import_effects.rs`
  - V131B · ⏸ Отложено владельцем · (Преобразовать settings и неполную correspondence) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V131A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Преобразовать settings и неполную correspondence. Частный результат исходного V131: Explicit schema transform, sender evidence, потерянный текст помечен. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V131A.
      Приёмка: Получен проверяемый результат: Преобразовать settings и неполную correspondence. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `migration/import_context.rs`
  - V025 · ⏸ Отложено владельцем · (Проверить гонку stop с отправкой и фактический interrupt) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V025B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить гонку stop с отправкой и фактический interrupt. Частный результат исходного V025: Durable hold перед interrupt; dispatch/stop сериализуют admission. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V025B.
      Приёмка: Race stop/deliver: post-hold send не стартует; уже принятое действие отражено честно. Это точка объединения всей цепочки V025A, V025B, V025.
      Затрагиваемые файлы: `crates/herder/src/application/stop.rs`
  - V025COMPOSE · ⏸ Отложено владельцем · (Подключить проверенную authority к MCP application) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V025OWNER, V025TASKRECON, V025CREATETASK · стоимость — вне сметы · отложено владельцем
      Описание задачи: Соединить trusted scoped authority, проверенный principal и точные grants с create/deliver/stop без доверия к metadata и без новой базы.
      Приёмка: Изолированное authenticated приложение выполняет целевые операции, spoofed identity и imported scope запрещены; статус задачи и причины отказа читаются.
  - V034 · ⏸ Отложено владельцем · (Проверить истёкший запрос и повтор ответа) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V034B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить истёкший запрос и повтор ответа. Частный результат исходного V034: Pending request identity и authorized answer, без wildcard approvals. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V034B.
      Приёмка: Expired ID не отвечает другому request; duplicate answer идемпотентен. Это точка объединения всей цепочки V034A, V034B, V034.
      Затрагиваемые файлы: `crates/herder/src/application/permission.rs`
  - V043 · ✅ Готово · (Подтвердить максимум один эффект и сверку UNKNOWN) · оценка 10 мин–15 мин · усилие не измерено · волна 2 · зависит: V043B · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Подтвердить максимум один эффект и сверку UNKNOWN. Частный результат исходного V043: Test runner делает безопасный локальный file revision effect; delay/crash/partition. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V043B.
      Приёмка: Максимум один эффект; повтор key только readback; lost authority запрещает новый admission. Это точка объединения всей цепочки V043A, V043B, V043.
      Затрагиваемые файлы: `tests/ownership/release_races.rs`
      Результат: V043 race/effect acceptance объединена. На свежей базе releaser ждёт target lock, после смены владельца задержанный admitted request отклоняется до spawn и effect-файл остаётся отсутствующим. Для подтверждённого request key проходит ровно один child effect; finish_under_lock сохраняет confirmed receipt; повтор key возвращает readback (`newly_admitted=false`) и второй spawn отклонён, содержимое остаётся ровно `x`. V042 test path дополнительно доказывает UNKNOWN после lost completion и запрет конфликтующего admission. Проверка после rebase на origin/main 564b6821: `cargo test --lib ownership::` — 19 passed, 0 failed; `cargo check --bin herder` и diff-check чистые. Aggregate head dfed20e9 включает V043A/B + single-effect test; передано Терe. MCP/offline standard resource consumer R003/R004 всё ещё ждёт отдельный V017/R003 путь.
  - V055 · ⏸ Отложено владельцем · (Codex: Сверить единственную созданную сессию через public MCP) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V055B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: Сверить единственную созданную сессию через public MCP. Частный результат исходного V055: Одна native create route; request correlation и readback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V055B.
      Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create. Это точка объединения всей цепочки V055A, V055B, V055.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/create.rs`
  - V064 · ⏸ Отложено владельцем · (OpenCode: Сверить единственную созданную сессию через public MCP) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V064B · стоимость — вне сметы · отложено владельцем
      Описание задачи: OpenCode: Сверить единственную созданную сессию через public MCP. Частный результат исходного V064: Одна native create route; request correlation и readback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V064B.
      Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create. Это точка объединения всей цепочки V064A, V064B, V064.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/create.rs`
  - V073 · ⏸ Отложено владельцем · (ZCode: Сверить единственную созданную сессию через public MCP) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V073B · стоимость — вне сметы · отложено владельцем
      Описание задачи: ZCode: Сверить единственную созданную сессию через public MCP. Частный результат исходного V073: Одна native create route; request correlation и readback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V073B.
      Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create. Это точка объединения всей цепочки V073A, V073B, V073.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/create.rs`
  - V082 · ⏸ Отложено владельцем · (ChatGPT: Сверить единственную созданную сессию через public MCP) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V082B · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Сверить единственную созданную сессию через public MCP. Частный результат исходного V082: Одна native create route; request correlation и readback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V082B.
      Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create. Это точка объединения всей цепочки V082A, V082B, V082.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/create.rs`
  - V091 · ⏸ Отложено владельцем · (Z.ai: Сверить единственную созданную сессию через public MCP) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V091B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Z.ai: Сверить единственную созданную сессию через public MCP. Частный результат исходного V091: Одна native create route; request correlation и readback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V091B.
      Приёмка: Точное native ID, creator сохраняется; disconnect не запускает второй create. Это точка объединения всей цепочки V091A, V091B, V091.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/create.rs`
  - V120A · ⏸ Отложено владельцем · (ExManager Board: заменить вызов на общий typed API) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V119 · стоимость — вне сметы · отложено владельцем
      Описание задачи: ExManager Board: заменить вызов на общий typed API. Частный результат исходного V120: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V119.
      Приёмка: Получен проверяемый результат: ExManager Board: заменить вызов на общий typed API. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `consumer:board:paths-from-target.json`
  - V125B · ⏸ Отложено владельцем · (Упаковать тот же исходник как MCP Skill) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V125A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Упаковать тот же исходник как MCP Skill. Частный результат исходного V125: Один исходник инструкции и manifest template; expose Skills и package local copy. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V125A.
      Приёмка: Получен проверяемый результат: Упаковать тот же исходник как MCP Skill. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `skills/herder-recovery/SKILL.md`
  - V130 · ⏸ Отложено владельцем · (Проверить повторы по digest и числу записей) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V130B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить повторы по digest и числу записей. Частный результат исходного V130: Offline importer сохраняет request keys, неизвестные исходы и tombstones; не исполняет ничего. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V130B.
      Приёмка: Fixture повторов и HumanStop после импорта остаётся тем же; input digest/counts записаны. Это точка объединения всей цепочки V130A, V130B, V130.
      Затрагиваемые файлы: `migration/import_effects.rs`
  - V131 · ⏸ Отложено владельцем · (Проверить повтор импорта без склейки чужих refs) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V131B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить повтор импорта без склейки чужих refs. Частный результат исходного V131: Explicit schema transform, sender evidence, потерянный текст помечен. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V131B.
      Приёмка: Creator не заменён sender; foreign refs не склеены; повтор import безопасен. Это точка объединения всей цепочки V131A, V131B, V131.
      Затрагиваемые файлы: `migration/import_context.rs`
  - V025PUBLIC · ⏸ Отложено владельцем · (Проверить публичный MCP путь с HumanStop) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V025COMPOSE, V025TASKRECON, V025CREATETASK · стоимость — вне сметы · отложено владельцем
      Описание задачи: Связать public MCP consumer с authority и проверить полный цикл на изолированной свежей сессии.
      Приёмка: Fresh create→deliver→native readback→stop→next denied; receipt и UNKNOWN no replay, отдельный результат от fixture.
  - V026A · ⏸ Отложено владельцем · (Проводить одноразовый resume через общий intent) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V025 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проводить одноразовый resume через общий intent. Частный результат исходного V026: Один request_key → один native turn; HumanStop требует отдельного человеческого права на снятие. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V025.
      Приёмка: Получен проверяемый результат: Проводить одноразовый resume через общий intent. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/resume.rs`
  - V046A · ⏸ Отложено владельцем · (Отмечать generation после resume и compaction) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V044, V018, V025 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Отмечать generation после resume и compaction. Частный результат исходного V046: Projector snapshot/delta, новый context generation не подавляется fingerprint. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V044, V018, V025.
      Приёмка: Получен проверяемый результат: Отмечать generation после resume и compaction. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `integrations/hooks/context_client.rs`
  - V056A · ⏸ Отложено владельцем · (Codex: Передать message с request key в поддерживаемом режиме) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V055, V024, V025 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: Передать message с request key в поддерживаемом режиме. Частный результат исходного V056: Одна native send route; поддерживаемые modes кодируются явно; native receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V055, V024, V025.
      Приёмка: Получен проверяемый результат: Codex: Передать message с request key в поддерживаемом режиме. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/deliver.rs`
  - V058A · ⏸ Отложено владельцем · (Codex: Привязать interrupt к точному native turn) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V053, V025, V034, V032 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: Привязать interrupt к точному native turn. Частный результат исходного V058: Только доказанные stop/model/permission methods; unsupported явно, не успех. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V053, V025, V034, V032.
      Приёмка: Получен проверяемый результат: Codex: Привязать interrupt к точному native turn. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/control.rs`
  - V065A · ⏸ Отложено владельцем · (OpenCode: доставить через готовый adapter и общий admission) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V064, V024, V025, V065PORT · стоимость — вне сметы · отложено владельцем
      Описание задачи: Functional core admission→тонкий AHAP mapping→existing OpenCodeAdapter.sendMessage/Queue. Legacy result map сохраняет admitted/confirmed/unknown, без mutation fallback/retry. Переиспользовать доказанные native операции.
      Приёмка: Получен проверяемый результат: OpenCode: Передать message с request key в поддерживаемом режиме. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/deliver.rs`
  - V067A · ⏸ Отложено владельцем · (OpenCode: Привязать interrupt к точному native turn) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V062, V025, V034, V032 · стоимость — вне сметы · отложено владельцем
      Описание задачи: OpenCode: Привязать interrupt к точному native turn. Частный результат исходного V067: Только доказанные stop/model/permission methods; unsupported явно, не успех. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V062, V025, V034, V032.
      Приёмка: Получен проверяемый результат: OpenCode: Привязать interrupt к точному native turn. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/control.rs`
  - V074A · ⏸ Отложено владельцем · (ZCode: Передать message с request key в поддерживаемом режиме) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V073, V024, V025 · стоимость — вне сметы · отложено владельцем
      Описание задачи: ZCode: Передать message с request key в поддерживаемом режиме. Частный результат исходного V074: Одна native send route; поддерживаемые modes кодируются явно; native receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V073, V024, V025.
      Приёмка: Получен проверяемый результат: ZCode: Передать message с request key в поддерживаемом режиме. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/deliver.rs`
  - V076 · ⏸ Отложено владельцем · (ZCode: Проверить stop, stale request и границы capability) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V076B, V025, V034, V032 · стоимость — вне сметы · отложено владельцем
      Описание задачи: ZCode: Проверить stop, stale request и границы capability. Частный результат исходного V076: Только доказанные stop/model/permission methods; unsupported явно, не успех. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V076B.
      Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control. Это точка объединения всей цепочки V076A, V076B, V076.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/control.rs`
  - V083A · ⏸ Отложено владельцем · (ChatGPT: Передать message с request key в поддерживаемом режиме) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V082, V024, V025 · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Передать message с request key в поддерживаемом режиме. Частный результат исходного V083: Одна native send route; поддерживаемые modes кодируются явно; native receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V082, V024, V025.
      Приёмка: Получен проверяемый результат: ChatGPT: Передать message с request key в поддерживаемом режиме. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/deliver.rs`
  - V085A · ⏸ Отложено владельцем · (ChatGPT: Привязать interrupt к точному native turn) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V080, V025, V034, V032 · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Привязать interrupt к точному native turn. Частный результат исходного V085: Только доказанные stop/model/permission methods; unsupported явно, не успех. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V080, V025, V034, V032.
      Приёмка: Получен проверяемый результат: ChatGPT: Привязать interrupt к точному native turn. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/control.rs`
  - V092A · ⏸ Отложено владельцем · (Z.ai: Передать message с request key в поддерживаемом режиме) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V091, V024, V025 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Z.ai: Передать message с request key в поддерживаемом режиме. Частный результат исходного V092: Одна native send route; поддерживаемые modes кодируются явно; native receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V091, V024, V025.
      Приёмка: Получен проверяемый результат: Z.ai: Передать message с request key в поддерживаемом режиме. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/deliver.rs`
  - V094A · ⏸ Отложено владельцем · (Z.ai: Привязать interrupt к точному native turn) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V089, V025, V034, V032 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Z.ai: Привязать interrupt к точному native turn. Частный результат исходного V094: Только доказанные stop/model/permission methods; unsupported явно, не успех. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V089, V025, V034, V032.
      Приёмка: Получен проверяемый результат: Z.ai: Привязать interrupt к точному native turn. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/control.rs`
  - V120B · ⏸ Отложено владельцем · (ExManager Board: сохранить request key, Task и диагностические ошибки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V120A · стоимость — вне сметы · отложено владельцем
      Описание задачи: ExManager Board: сохранить request key, Task и диагностические ошибки. Частный результат исходного V120: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V120A.
      Приёмка: Получен проверяемый результат: ExManager Board: сохранить request key, Task и диагностические ошибки. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `consumer:board:paths-from-target.json`
  - V125 · ⏸ Отложено владельцем · (Проверить команды при выключенном MCP и нестандартном root) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V125B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить команды при выключенном MCP и нестандартном root. Частный результат исходного V125: Один исходник инструкции и manifest template; expose Skills и package local copy. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V125B.
      Приёмка: Отключённый MCP не мешает найти путь; команды read/claim с подставленным locator и без секретов. Это точка объединения всей цепочки V125A, V125B, V125.
      Затрагиваемые файлы: `skills/herder-recovery/SKILL.md`
  - V132A · ⏸ Отложено владельцем · (Остановить старых writers и сверить активные эффекты) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V130, V131, V043, R004 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Остановить старых writers и сверить активные эффекты. Частный результат исходного V132: Stop writers → проверка receipts → JSON owner import → старые writers остаются выключены. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V130, V131, V043, R004.
      Приёмка: Получен проверяемый результат: Остановить старых writers и сверить активные эффекты. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `migration/ownership.rs`
  - V025PROD · ⏸ Отложено владельцем · (Подключить HumanStop gate к реальному native handoff) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V025PUBLIC · стоимость — вне сметы · отложено владельцем
      Описание задачи: Связать проверенный scoped authority и межпроцессный gate со штатным MCP launcher, фактическим bounded Codex transport и единым stop writer; legacy scopes без доказанного handoff denied.
      Приёмка: Реальный consumer fresh create→deliver→native readback→stop→next denied; barrier races, UNKNOWN без replay и production authority отдельно подтверждены.
      Затрагиваемые файлы: `crates/herder/src/application/scoped_stop.rs`, `crates/herder/src/mcp/`
  - V026B · ⏸ Отложено владельцем · (Отделить право снять HumanStop от флага модели) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V026A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Отделить право снять HumanStop от флага модели. Частный результат исходного V026: Один request_key → один native turn; HumanStop требует отдельного человеческого права на снятие. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V026A.
      Приёмка: Получен проверяемый результат: Отделить право снять HumanStop от флага модели. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/resume.rs`
  - V046B · ⏸ Отложено владельцем · (Вставлять карточку через поддерживаемую native точку) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V046A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Вставлять карточку через поддерживаемую native точку. Частный результат исходного V046: Projector snapshot/delta, новый context generation не подавляется fingerprint. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V046A.
      Приёмка: Получен проверяемый результат: Вставлять карточку через поддерживаемую native точку. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `integrations/hooks/context_client.rs`
  - V056B · ⏸ Отложено владельцем · (Codex: Найти input в точном native turn или queue) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V056A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: Найти input в точном native turn или queue. Частный результат исходного V056: Одна native send route; поддерживаемые modes кодируются явно; native receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V056A.
      Приёмка: Получен проверяемый результат: Codex: Найти input в точном native turn или queue. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/deliver.rs`
  - V058B · ⏸ Отложено владельцем · (Codex: Применить поддерживаемые параметры и permission reply) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V058A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: Применить поддерживаемые параметры и permission reply. Частный результат исходного V058: Только доказанные stop/model/permission methods; unsupported явно, не успех. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V058A.
      Приёмка: Получен проверяемый результат: Codex: Применить поддерживаемые параметры и permission reply. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/control.rs`
  - V065B · ⏸ Отложено владельцем · (OpenCode: Найти input в точном native turn или queue) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V065A · стоимость — вне сметы · отложено владельцем
      Описание задачи: OpenCode: Найти input в точном native turn или queue. Частный результат исходного V065: Одна native send route; поддерживаемые modes кодируются явно; native receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V065A.
      Приёмка: Получен проверяемый результат: OpenCode: Найти input в точном native turn или queue. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/deliver.rs`
  - V067B · ⏸ Отложено владельцем · (OpenCode: Применить поддерживаемые параметры и permission reply) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V067A · стоимость — вне сметы · отложено владельцем
      Описание задачи: OpenCode: Применить поддерживаемые параметры и permission reply. Частный результат исходного V067: Только доказанные stop/model/permission methods; unsupported явно, не успех. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V067A.
      Приёмка: Получен проверяемый результат: OpenCode: Применить поддерживаемые параметры и permission reply. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/control.rs`
  - V074B · ⏸ Отложено владельцем · (ZCode: Найти input в точном native turn или queue) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V074A · стоимость — вне сметы · отложено владельцем
      Описание задачи: ZCode: Найти input в точном native turn или queue. Частный результат исходного V074: Одна native send route; поддерживаемые modes кодируются явно; native receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V074A.
      Приёмка: Получен проверяемый результат: ZCode: Найти input в точном native turn или queue. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/deliver.rs`
  - V083B · ⏸ Отложено владельцем · (ChatGPT: Найти input в точном native turn или queue) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V083A · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Найти input в точном native turn или queue. Частный результат исходного V083: Одна native send route; поддерживаемые modes кодируются явно; native receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V083A.
      Приёмка: Получен проверяемый результат: ChatGPT: Найти input в точном native turn или queue. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/deliver.rs`
  - V085B · ⏸ Отложено владельцем · (ChatGPT: Применить поддерживаемые параметры и permission reply) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V085A · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Применить поддерживаемые параметры и permission reply. Частный результат исходного V085: Только доказанные stop/model/permission methods; unsupported явно, не успех. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V085A.
      Приёмка: Получен проверяемый результат: ChatGPT: Применить поддерживаемые параметры и permission reply. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/control.rs`
  - V092B · ⏸ Отложено владельцем · (Z.ai: Найти input в точном native turn или queue) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V092A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Z.ai: Найти input в точном native turn или queue. Частный результат исходного V092: Одна native send route; поддерживаемые modes кодируются явно; native receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V092A.
      Приёмка: Получен проверяемый результат: Z.ai: Найти input в точном native turn или queue. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/deliver.rs`
  - V094B · ⏸ Отложено владельцем · (Z.ai: Применить поддерживаемые параметры и permission reply) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V094A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Z.ai: Применить поддерживаемые параметры и permission reply. Частный результат исходного V094: Только доказанные stop/model/permission methods; unsupported явно, не успех. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V094A.
      Приёмка: Получен проверяемый результат: Z.ai: Применить поддерживаемые параметры и permission reply. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/control.rs`
  - V120 · ⏸ Отложено владельцем · (ExManager Board: проверить отсутствие legacy alias и второго job lifecycle) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V120B · стоимость — вне сметы · отложено владельцем
      Описание задачи: ExManager Board: проверить отсутствие legacy alias и второго job lifecycle. Частный результат исходного V120: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V120B.
      Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены. Это точка объединения всей цепочки V120A, V120B, V120.
      Затрагиваемые файлы: `consumer:board:paths-from-target.json`
  - V128A · ⏸ Отложено владельцем · (Выключить тестовый daemon и найти authority по manifest) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V125, V043, V112 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Выключить тестовый daemon и найти authority по manifest. Частный результат исходного V128: Остановить только test daemon; read markers→claim→безопасный release через runner→receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V125, V043, V112.
      Приёмка: Получен проверяемый результат: Выключить тестовый daemon и найти authority по manifest. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/recovery/offline/`
  - V132B · ⏸ Отложено владельцем · (Импортировать владельцев в единственный resource store) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V132A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Импортировать владельцев в единственный resource store. Частный результат исходного V132: Stop writers → проверка receipts → JSON owner import → старые writers остаются выключены. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V132A.
      Приёмка: Получен проверяемый результат: Импортировать владельцев в единственный resource store. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `migration/ownership.rs`
  - V026 · ⏸ Отложено владельцем · (Проверить повтор resume без второго хода) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V026B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить повтор resume без второго хода. Частный результат исходного V026: Один request_key → один native turn; HumanStop требует отдельного человеческого права на снятие. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V026B.
      Приёмка: Дубликат resume не создаёт ход; флаг humanRequested от модели не снимает hold. Это точка объединения всей цепочки V026A, V026B, V026.
      Затрагиваемые файлы: `crates/herder/src/application/resume.rs`
  - V046 · ⏸ Отложено владельцем · (Подтвердить восстановление при неизменном fingerprint) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V046B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить восстановление при неизменном fingerprint. Частный результат исходного V046: Projector snapshot/delta, новый context generation не подавляется fingerprint. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V046B.
      Приёмка: Fake compact event вызывает snapshot без нового model turn и без снятия STOP. Это точка объединения всей цепочки V046A, V046B, V046.
      Затрагиваемые файлы: `integrations/hooks/context_client.rs`
  - V056 · ⏸ Отложено владельцем · (Codex: Подтвердить доставку и отказ от повторения UNKNOWN) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V056B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: Подтвердить доставку и отказ от повторения UNKNOWN. Частный результат исходного V056: Одна native send route; поддерживаемые modes кодируются явно; native receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V056B.
      Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay. Это точка объединения всей цепочки V056A, V056B, V056.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/deliver.rs`
  - V058 · ⏸ Отложено владельцем · (Codex: Проверить stop, stale request и границы capability) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V058B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: Проверить stop, stale request и границы capability. Частный результат исходного V058: Только доказанные stop/model/permission methods; unsupported явно, не успех. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V058B.
      Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control. Это точка объединения всей цепочки V058A, V058B, V058.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/control.rs`
  - V065 · ⏸ Отложено владельцем · (OpenCode: Подтвердить доставку и отказ от повторения UNKNOWN) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V065B · стоимость — вне сметы · отложено владельцем
      Описание задачи: OpenCode: Подтвердить доставку и отказ от повторения UNKNOWN. Частный результат исходного V065: Одна native send route; поддерживаемые modes кодируются явно; native receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V065B.
      Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay. Это точка объединения всей цепочки V065A, V065B, V065.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/deliver.rs`
  - V067 · ⏸ Отложено владельцем · (OpenCode: Проверить stop, stale request и границы capability) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V067B · стоимость — вне сметы · отложено владельцем
      Описание задачи: OpenCode: Проверить stop, stale request и границы capability. Частный результат исходного V067: Только доказанные stop/model/permission methods; unsupported явно, не успех. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V067B.
      Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control. Это точка объединения всей цепочки V067A, V067B, V067.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/control.rs`
  - V074 · ⏸ Отложено владельцем · (ZCode: Подтвердить доставку и отказ от повторения UNKNOWN) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V074B · стоимость — вне сметы · отложено владельцем
      Описание задачи: ZCode: Подтвердить доставку и отказ от повторения UNKNOWN. Частный результат исходного V074: Одна native send route; поддерживаемые modes кодируются явно; native receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V074B.
      Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay. Это точка объединения всей цепочки V074A, V074B, V074.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/deliver.rs`
  - V083 · ⏸ Отложено владельцем · (ChatGPT: Подтвердить доставку и отказ от повторения UNKNOWN) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V083B · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Подтвердить доставку и отказ от повторения UNKNOWN. Частный результат исходного V083: Одна native send route; поддерживаемые modes кодируются явно; native receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V083B.
      Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay. Это точка объединения всей цепочки V083A, V083B, V083.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/deliver.rs`
  - V085 · ⏸ Отложено владельцем · (ChatGPT: Проверить stop, stale request и границы capability) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V085B · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Проверить stop, stale request и границы capability. Частный результат исходного V085: Только доказанные stop/model/permission methods; unsupported явно, не успех. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V085B.
      Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control. Это точка объединения всей цепочки V085A, V085B, V085.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/control.rs`
  - V092 · ⏸ Отложено владельцем · (Z.ai: Подтвердить доставку и отказ от повторения UNKNOWN) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V092B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Z.ai: Подтвердить доставку и отказ от повторения UNKNOWN. Частный результат исходного V092: Одна native send route; поддерживаемые modes кодируются явно; native receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V092B.
      Приёмка: Один input readback; unsupported mode до send; unknown после разрыва не replay. Это точка объединения всей цепочки V092A, V092B, V092.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/deliver.rs`
  - V094 · ⏸ Отложено владельцем · (Z.ai: Проверить stop, stale request и границы capability) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V094B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Z.ai: Проверить stop, stale request и границы capability. Частный результат исходного V094: Только доказанные stop/model/permission methods; unsupported явно, не успех. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V094B.
      Приёмка: Stop реального тестового turn; fixture подтверждает mapping каждого заявленного control. Это точка объединения всей цепочки V094A, V094B, V094.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/control.rs`
  - V121A · ⏸ Отложено владельцем · (ExManager Board: выполнить основной сценарий через обычного потребителя) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V120 · стоимость — вне сметы · отложено владельцем
      Описание задачи: ExManager Board: выполнить основной сценарий через обычного потребителя. Частный результат исходного V121: Один изолированный сценарий через обычного потребителя и native result. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V120.
      Приёмка: Получен проверяемый результат: ExManager Board: выполнить основной сценарий через обычного потребителя. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/consumers/board/`
  - V128B · ⏸ Отложено владельцем · (Занять свободный ресурс и выполнить тестовый release через runner) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V128A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Занять свободный ресурс и выполнить тестовый release через runner. Частный результат исходного V128: Остановить только test daemon; read markers→claim→безопасный release через runner→receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V128A.
      Приёмка: Получен проверяемый результат: Занять свободный ресурс и выполнить тестовый release через runner. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/recovery/offline/`
  - V132 · ⏸ Отложено владельцем · (Подтвердить отсутствие прежнего fallback после остановки MCP) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V132B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить отсутствие прежнего fallback после остановки MCP. Частный результат исходного V132: Stop writers → проверка receipts → JSON owner import → старые writers остаются выключены. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V132B.
      Приёмка: Git/DB fallback не активируется при падении MCP; fencing assumptions заменены target runner проверками. Это точка объединения всей цепочки V132A, V132B, V132.
      Затрагиваемые файлы: `migration/ownership.rs`
  - E001 · ⏸ Отложено владельцем · (Показать первый native ответ Codex через новый MCP) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V056, V054, V051, T011, V025 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Установить dev сборку. Реальный клиент создаёт сессию, доставляет уникальный input и читает ответ лжемодели с native refs. Эта ранняя проверка не заменяет полный V060.
      Приёмка: Установить dev сборку. Реальный клиент создаёт сессию, доставляет уникальный input и читает ответ лжемодели с native refs. Эта ранняя проверка не заменяет полный V060.
      Затрагиваемые файлы: `acceptance/early/codex/`
  - V035A · ⏸ Отложено владельцем · (Сопоставить MCP input с исходным Task и сессией) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V014, V026, V008 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сопоставить MCP input с исходным Task и сессией. Частный результат исходного V035: MRTR/Task input и external correlation используют одну delivery boundary. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V014, V026, V008.
      Приёмка: Получен проверяемый результат: Сопоставить MCP input с исходным Task и сессией. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/human.rs`
  - V047A · ⏸ Отложено владельцем · (Описать typed schedule и autopilot без общего workflow языка) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V033, V026 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Описать typed schedule и autopilot без общего workflow языка. Частный результат исходного V047: Schedule/one-shot и autopilot в одном CRUD; timezone, missed/overlap, CAS. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V033, V026.
      Приёмка: Получен проверяемый результат: Описать typed schedule и autopilot без общего workflow языка. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/automation/rules.rs`
  - V059A · ⏸ Отложено владельцем · (Codex: Подключить native точку вставки context) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V053, V046 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: Подключить native точку вставки context. Частный результат исходного V059: Привязка self и один подтверждённый startup/resume/compact hook; absence явная. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V053, V046.
      Приёмка: Получен проверяемый результат: Codex: Подключить native точку вставки context. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/context.rs`
  - V068A · ⏸ Отложено владельцем · (OpenCode: Подключить native точку вставки context) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V062, V046 · стоимость — вне сметы · отложено владельцем
      Описание задачи: OpenCode: Подключить native точку вставки context. Частный результат исходного V068: Привязка self и один подтверждённый startup/resume/compact hook; absence явная. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V062, V046.
      Приёмка: Получен проверяемый результат: OpenCode: Подключить native точку вставки context. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/context.rs`
  - V077A · ⏸ Отложено владельцем · (ZCode: Подключить native точку вставки context) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V071, V046 · стоимость — вне сметы · отложено владельцем
      Описание задачи: ZCode: Подключить native точку вставки context. Частный результат исходного V077: Привязка self и один подтверждённый startup/resume/compact hook; absence явная. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V071, V046.
      Приёмка: Получен проверяемый результат: ZCode: Подключить native точку вставки context. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/context.rs`
  - V086A · ⏸ Отложено владельцем · (ChatGPT: Подключить native точку вставки context) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V080, V046 · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Подключить native точку вставки context. Частный результат исходного V086: Привязка self и один подтверждённый startup/resume/compact hook; absence явная. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V080, V046.
      Приёмка: Получен проверяемый результат: ChatGPT: Подключить native точку вставки context. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/context.rs`
  - V095A · ⏸ Отложено владельцем · (Z.ai: Подключить native точку вставки context) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V089, V046 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Z.ai: Подключить native точку вставки context. Частный результат исходного V095: Привязка self и один подтверждённый startup/resume/compact hook; absence явная. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V089, V046.
      Приёмка: Получен проверяемый результат: Z.ai: Подключить native точку вставки context. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/context.rs`
  - V097A · ⏸ Отложено владельцем · (Установить dev артефакт с Codex и OpenCode) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V060, V069, T013, V044, V046 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Установить dev артефакт с Codex и OpenCode. Частный результат исходного V097: Установленный dev artifact и один основной MCP client с durable Task polling. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V060, V069, V003, V044, V046.
      Приёмка: Получен проверяемый результат: Установить dev артефакт с Codex и OpenCode. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/dev-vertical/`
  - V121 · ⏸ Отложено владельцем · (ExManager Board: сверить native результат и версии без повторной отправки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V121A · стоимость — вне сметы · отложено владельцем
      Описание задачи: ExManager Board: сверить native результат и версии без повторной отправки. Частный результат исходного V121: Один изолированный сценарий через обычного потребителя и native result. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V121A.
      Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль. Это точка объединения всей цепочки V121A, V121.
      Затрагиваемые файлы: `acceptance/consumers/board/`
  - V128 · ⏸ Отложено владельцем · (Включить MCP и подтвердить прежнего owner и одну квитанцию) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V128B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Включить MCP и подтвердить прежнего owner и одну квитанцию. Частный результат исходного V128: Остановить только test daemon; read markers→claim→безопасный release через runner→receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V128B.
      Приёмка: Ноль вопросов о назначении свободного owner, одна операция; повтор MCP видит тот же owner. Это точка объединения всей цепочки V128A, V128B, V128.
      Затрагиваемые файлы: `acceptance/recovery/offline/`
  - V035B · ⏸ Отложено владельцем · (Связать внешний вопрос и callback через тот же admission) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V035A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Связать внешний вопрос и callback через тот же admission. Частный результат исходного V035: MRTR/Task input и external correlation используют одну delivery boundary. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V035A.
      Приёмка: Получен проверяемый результат: Связать внешний вопрос и callback через тот же admission. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/application/human.rs`
  - V047B · ⏸ Отложено владельцем · (Сохранять правила по CAS для точной сессии) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V047A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сохранять правила по CAS для точной сессии. Частный результат исходного V047: Schedule/one-shot и autopilot в одном CRUD; timezone, missed/overlap, CAS. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V047A.
      Приёмка: Получен проверяемый результат: Сохранять правила по CAS для точной сессии. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/automation/rules.rs`
  - V059B · ⏸ Отложено владельцем · (Codex: Восстановить generation при поддерживаемом resume или compaction) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V059A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: Восстановить generation при поддерживаемом resume или compaction. Частный результат исходного V059: Привязка self и один подтверждённый startup/resume/compact hook; absence явная. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V059A.
      Приёмка: Получен проверяемый результат: Codex: Восстановить generation при поддерживаемом resume или compaction. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/context.rs`
  - V068B · ⏸ Отложено владельцем · (OpenCode: Восстановить generation при поддерживаемом resume или compaction) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V068A · стоимость — вне сметы · отложено владельцем
      Описание задачи: OpenCode: Восстановить generation при поддерживаемом resume или compaction. Частный результат исходного V068: Привязка self и один подтверждённый startup/resume/compact hook; absence явная. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V068A.
      Приёмка: Получен проверяемый результат: OpenCode: Восстановить generation при поддерживаемом resume или compaction. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/context.rs`
  - V077B · ⏸ Отложено владельцем · (ZCode: Восстановить generation при поддерживаемом resume или compaction) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V077A · стоимость — вне сметы · отложено владельцем
      Описание задачи: ZCode: Восстановить generation при поддерживаемом resume или compaction. Частный результат исходного V077: Привязка self и один подтверждённый startup/resume/compact hook; absence явная. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V077A.
      Приёмка: Получен проверяемый результат: ZCode: Восстановить generation при поддерживаемом resume или compaction. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/context.rs`
  - V086B · ⏸ Отложено владельцем · (ChatGPT: Восстановить generation при поддерживаемом resume или compaction) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V086A · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Восстановить generation при поддерживаемом resume или compaction. Частный результат исходного V086: Привязка self и один подтверждённый startup/resume/compact hook; absence явная. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V086A.
      Приёмка: Получен проверяемый результат: ChatGPT: Восстановить generation при поддерживаемом resume или compaction. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/context.rs`
  - V095B · ⏸ Отложено владельцем · (Z.ai: Восстановить generation при поддерживаемом resume или compaction) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V095A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Z.ai: Восстановить generation при поддерживаемом resume или compaction. Частный результат исходного V095: Привязка self и один подтверждённый startup/resume/compact hook; absence явная. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V095A.
      Приёмка: Получен проверяемый результат: Z.ai: Восстановить generation при поддерживаемом resume или compaction. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/context.rs`
  - V097B · ⏸ Отложено владельцем · (Пройти create, deliver и context через основной MCP client) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V097A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Пройти create, deliver и context через основной MCP client. Частный результат исходного V097: Установленный dev artifact и один основной MCP client с durable Task polling. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V097A.
      Приёмка: Получен проверяемый результат: Пройти create, deliver и context через основной MCP client. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/dev-vertical/`
  - V035 · ⏸ Отложено владельцем · (Проверить повтор callback без второго resume на тестовом контакте) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V035B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить повтор callback без второго resume на тестовом контакте. Частный результат исходного V035: MRTR/Task input и external correlation используют одну delivery boundary. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V035B.
      Приёмка: Ответ относится одной сессии, повтор callback не даёт два resume; внешняя отправка только в test route. Это точка объединения всей цепочки V035A, V035B, V035.
      Затрагиваемые файлы: `crates/herder/src/application/human.rs`
  - V047 · ⏸ Отложено владельцем · (Проверить неверную цель, режим и права) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V047B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить неверную цель, режим и права. Частный результат исходного V047: Schedule/one-shot и autopilot в одном CRUD; timezone, missed/overlap, CAS. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V047B.
      Приёмка: Неверный cron объясняется; настройка не создаёт parallel job API. Это точка объединения всей цепочки V047A, V047B, V047.
      Затрагиваемые файлы: `crates/herder/src/automation/rules.rs`
  - V059 · ⏸ Отложено владельцем · (Codex: Подтвердить видимость карточки агенту и честный unsupported) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V059B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: Подтвердить видимость карточки агенту и честный unsupported. Частный результат исходного V059: Привязка self и один подтверждённый startup/resume/compact hook; absence явная. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V059B.
      Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся. Это точка объединения всей цепочки V059A, V059B, V059.
      Затрагиваемые файлы: `crates/herder/src/adapters/codex/context.rs`
  - V068 · ⏸ Отложено владельцем · (OpenCode: Подтвердить видимость карточки агенту и честный unsupported) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V068B · стоимость — вне сметы · отложено владельцем
      Описание задачи: OpenCode: Подтвердить видимость карточки агенту и честный unsupported. Частный результат исходного V068: Привязка self и один подтверждённый startup/resume/compact hook; absence явная. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V068B.
      Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся. Это точка объединения всей цепочки V068A, V068B, V068.
      Затрагиваемые файлы: `crates/herder/src/adapters/opencode/context.rs`
  - V077 · ⏸ Отложено владельцем · (ZCode: Подтвердить видимость карточки агенту и честный unsupported) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V077B · стоимость — вне сметы · отложено владельцем
      Описание задачи: ZCode: Подтвердить видимость карточки агенту и честный unsupported. Частный результат исходного V077: Привязка self и один подтверждённый startup/resume/compact hook; absence явная. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V077B.
      Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся. Это точка объединения всей цепочки V077A, V077B, V077.
      Затрагиваемые файлы: `crates/herder/src/adapters/zcode/context.rs`
  - V086 · ⏸ Отложено владельцем · (ChatGPT: Подтвердить видимость карточки агенту и честный unsupported) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V086B · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Подтвердить видимость карточки агенту и честный unsupported. Частный результат исходного V086: Привязка self и один подтверждённый startup/resume/compact hook; absence явная. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V086B.
      Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся. Это точка объединения всей цепочки V086A, V086B, V086.
      Затрагиваемые файлы: `crates/herder/src/adapters/chatgpt/context.rs`
  - V095 · ⏸ Отложено владельцем · (Z.ai: Подтвердить видимость карточки агенту и честный unsupported) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V095B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Z.ai: Подтвердить видимость карточки агенту и честный unsupported. Частный результат исходного V095: Привязка self и один подтверждённый startup/resume/compact hook; absence явная. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V095B.
      Приёмка: Новая generation получает карточку; если инъекции нет, capability manual-only и acceptance gap остаётся. Это точка объединения всей цепочки V095A, V095B, V095.
      Затрагиваемые файлы: `crates/herder/src/adapters/z_ai/context.rs`
  - V097 · ⏸ Отложено владельцем · (Сохранить native readback и durable Task после рестарта) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V097B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сохранить native readback и durable Task после рестарта. Частный результат исходного V097: Установленный dev artifact и один основной MCP client с durable Task polling. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V097B.
      Приёмка: Create/deliver/context работают через реальные adapters; missing extension не скрыт. Это точка объединения всей цепочки V097A, V097B, V097.
      Затрагиваемые файлы: `release/dev-vertical/`
  - V048A · ⏸ Отложено владельцем · (Принять триггер в общий intent executor с request_key) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V047 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Принять триггер в общий intent executor с request_key. Частный результат исходного V048: Trigger ID + правило + native turn → постоянный delivery request_key. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V047.
      Приёмка: Получен проверяемый результат: Принять триггер в общий intent executor с request_key. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/automation/executor.rs`
  - V060A · ⏸ Отложено владельцем · (Codex: Установить текущий dev artifact в изолированный native контур) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V054, V056, V057, V058, V059, V051, V016 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: Установить текущий dev artifact в изолированный native контур. Частный результат исходного V060: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V054, V056, V057, V058, V059, V051, V016.
      Приёмка: Получен проверяемый результат: Codex: Установить текущий dev artifact в изолированный native контур. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/native/codex/`
  - V069A · ⏸ Отложено владельцем · (OpenCode: Установить текущий dev artifact в изолированный native контур) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V063, V065, V066, V067, V068, V051, V016 · стоимость — вне сметы · отложено владельцем
      Описание задачи: OpenCode: Установить текущий dev artifact в изолированный native контур. Частный результат исходного V069: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V063, V065, V066, V067, V068, V051, V016.
      Приёмка: Получен проверяемый результат: OpenCode: Установить текущий dev artifact в изолированный native контур. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/native/opencode/`
  - V087A · ⏸ Отложено владельцем · (ChatGPT: Установить текущий dev artifact в изолированный native контур) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V081, V083, V084, V085, V086, V051, V016 · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Установить текущий dev artifact в изолированный native контур. Частный результат исходного V087: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V081, V083, V084, V085, V086, V051, V016.
      Приёмка: Получен проверяемый результат: ChatGPT: Установить текущий dev artifact в изолированный native контур. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/native/chatgpt/`
  - V096A · ⏸ Отложено владельцем · (Z.ai: Установить текущий dev artifact в изолированный native контур) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V090, V092, V093, V094, V095, V051, V016 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Z.ai: Установить текущий dev artifact в изолированный native контур. Частный результат исходного V096: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V090, V092, V093, V094, V095, V051, V016.
      Приёмка: Получен проверяемый результат: Z.ai: Установить текущий dev artifact в изолированный native контур. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/native/z-ai/`
  - V101A · ⏸ Отложено владельцем · (Настроить два endpoint и проверить origin identity) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V097, V021 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Настроить два endpoint и проверить origin identity. Частный результат исходного V101: Codex→OpenCode через объявленные endpoints; exact origin refs. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V097, V021.
      Приёмка: Получен проверяемый результат: Настроить два endpoint и проверить origin identity. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/multi/nodes/`
  - V102A · ⏸ Отложено владельцем · (Создать B от A и доставить B сообщение от C) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V097, V044, V046, V027 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Создать B от A и доставить B сообщение от C. Частный результат исходного V102: A создаёт B, C пишет B; очистить context и рестарт Herder; B отвечает C. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V097, V044, V046, V027.
      Приёмка: Получен проверяемый результат: Создать B от A и доставить B сообщение от C. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/context/compaction/`
  - V103A · ⏸ Отложено владельцем · (Проверить сбой до native вызова) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V097, V015 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить сбой до native вызова. Частный результат исходного V103: Три точки сбоя: до вызова, после admission, после completion до ответа. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V097, V015.
      Приёмка: Получен проверяемый результат: Проверить сбой до native вызова. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/native/crash/`
  - V104A · ⏸ Отложено владельцем · (Подключить CLI create и deliver к общим DTO) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V097, V009 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подключить CLI create и deliver к общим DTO. Частный результат исходного V104: Subcommands из тех же DTO/application, polling Tasks и чтение ресурсов. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V097, V009.
      Приёмка: Получен проверяемый результат: Подключить CLI create и deliver к общим DTO. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/cli/main.rs`
  - V105A · ⏸ Отложено владельцем · (Подключить список и recent к typed web client) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V097, V017 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подключить список и recent к typed web client. Частный результат исходного V105: Typed client sessions/recent/transcript, partial/turn refs. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V097, V017.
      Приёмка: Получен проверяемый результат: Подключить список и recent к typed web client. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `web/src/session.ts`
  - V113A · ⏸ Отложено владельцем · (Notice Place: найти один вызывающий Herder маршрут и владельца путей) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V009, V035 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Notice Place: найти один вызывающий Herder маршрут и владельца путей. Частный результат исходного V113: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V009, V035.
      Приёмка: Получен проверяемый результат: Notice Place: найти один вызывающий Herder маршрут и владельца путей. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `integrations/consumers/noticeplace/target.json`
  - V116A · ⏸ Отложено владельцем · (UserIO: найти один вызывающий Herder маршрут и владельца путей) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V009, V035 · стоимость — вне сметы · отложено владельцем
      Описание задачи: UserIO: найти один вызывающий Herder маршрут и владельца путей. Частный результат исходного V116: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V009, V035.
      Приёмка: Получен проверяемый результат: UserIO: найти один вызывающий Herder маршрут и владельца путей. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `integrations/consumers/userio/target.json`
  - V141A · ⏸ Отложено владельцем · (Подготовить фиксированный корпус и границы нагрузки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V097, V030, V018 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подготовить фиксированный корпус и границы нагрузки. Частный результат исходного V141: Фиксированный corpus, concurrent read/send/index и slow subscriber; baseline metrics. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V097, V030, V018.
      Приёмка: Получен проверяемый результат: Подготовить фиксированный корпус и границы нагрузки. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/performance/`
  - V048B · ⏸ Отложено владельцем · (Проверить HumanStop непосредственно перед admission) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V048A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить HumanStop непосредственно перед admission. Частный результат исходного V048: Trigger ID + правило + native turn → постоянный delivery request_key. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V048A.
      Приёмка: Получен проверяемый результат: Проверить HumanStop непосредственно перед admission. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/automation/executor.rs`
  - V060B · ⏸ Отложено владельцем · (Codex: Пройти create, deliver, read и export через публичный MCP) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V060A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: Пройти create, deliver, read и export через публичный MCP. Частный результат исходного V060: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V060A.
      Приёмка: Получен проверяемый результат: Codex: Пройти create, deliver, read и export через публичный MCP. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/native/codex/`
  - V069B · ⏸ Отложено владельцем · (OpenCode: Пройти create, deliver, read и export через публичный MCP) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V069A · стоимость — вне сметы · отложено владельцем
      Описание задачи: OpenCode: Пройти create, deliver, read и export через публичный MCP. Частный результат исходного V069: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V069A.
      Приёмка: Получен проверяемый результат: OpenCode: Пройти create, deliver, read и export через публичный MCP. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/native/opencode/`
  - V087B · ⏸ Отложено владельцем · (ChatGPT: Пройти create, deliver, read и export через публичный MCP) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V087A · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: Пройти create, deliver, read и export через публичный MCP. Частный результат исходного V087: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V087A.
      Приёмка: Получен проверяемый результат: ChatGPT: Пройти create, deliver, read и export через публичный MCP. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/native/chatgpt/`
  - V096B · ⏸ Отложено владельцем · (Z.ai: Пройти create, deliver, read и export через публичный MCP) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V096A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Z.ai: Пройти create, deliver, read и export через публичный MCP. Частный результат исходного V096: Один candidate на изолированном стенде: create→deliver→recent→export/search→stop. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V096A.
      Приёмка: Получен проверяемый результат: Z.ai: Пройти create, deliver, read и export через публичный MCP. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/native/z-ai/`
  - V101B · ⏸ Отложено владельцем · (Создать удалённый Task и прочитать его результат) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V101A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Создать удалённый Task и прочитать его результат. Частный результат исходного V101: Codex→OpenCode через объявленные endpoints; exact origin refs. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V101A.
      Приёмка: Получен проверяемый результат: Создать удалённый Task и прочитать его результат. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/multi/nodes/`
  - V102B · ⏸ Отложено владельцем · (Очистить context и перезапустить тестовый Herder) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V102A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Очистить context и перезапустить тестовый Herder. Частный результат исходного V102: A создаёт B, C пишет B; очистить context и рестарт Herder; B отвечает C. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V102A.
      Приёмка: Получен проверяемый результат: Очистить context и перезапустить тестовый Herder. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/context/compaction/`
  - V103B · ⏸ Отложено владельцем · (Проверить сбой после admission до фиксации результата) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V103A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить сбой после admission до фиксации результата. Частный результат исходного V103: Три точки сбоя: до вызова, после admission, после completion до ответа. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V103A.
      Приёмка: Получен проверяемый результат: Проверить сбой после admission до фиксации результата. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/native/crash/`
  - V104B · ⏸ Отложено владельцем · (Показать Task polling и resource read в CLI) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V104A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Показать Task polling и resource read в CLI. Частный результат исходного V104: Subcommands из тех же DTO/application, polling Tasks и чтение ресурсов. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V104A.
      Приёмка: Получен проверяемый результат: Показать Task polling и resource read в CLI. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/cli/main.rs`
  - V105B · ⏸ Отложено владельцем · (Отобразить transcript и partial с turn refs) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V105A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Отобразить transcript и partial с turn refs. Частный результат исходного V105: Typed client sessions/recent/transcript, partial/turn refs. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V105A.
      Приёмка: Получен проверяемый результат: Отобразить transcript и partial с turn refs. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `web/src/session.ts`
  - V113 · ⏸ Отложено владельцем · (Notice Place: записать target.json с точным контрактом и тестовым маршрутом) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V113A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Notice Place: записать target.json с точным контрактом и тестовым маршрутом. Частный результат исходного V113: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V113A.
      Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции. Это точка объединения всей цепочки V113A, V113.
      Затрагиваемые файлы: `integrations/consumers/noticeplace/target.json`
  - V116 · ⏸ Отложено владельцем · (UserIO: записать target.json с точным контрактом и тестовым маршрутом) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V116A · стоимость — вне сметы · отложено владельцем
      Описание задачи: UserIO: записать target.json с точным контрактом и тестовым маршрутом. Частный результат исходного V116: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V116A.
      Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции. Это точка объединения всей цепочки V116A, V116.
      Затрагиваемые файлы: `integrations/consumers/userio/target.json`
  - V141B · ⏸ Отложено владельцем · (Запустить чтение, индексирование и медленного подписчика) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V141A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Запустить чтение, индексирование и медленного подписчика. Частный результат исходного V141: Фиксированный corpus, concurrent read/send/index и slow subscriber; baseline metrics. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V141A.
      Приёмка: Получен проверяемый результат: Запустить чтение, индексирование и медленного подписчика. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/performance/`
  - V048 · ⏸ Отложено владельцем · (Проверить повтор события без второго resume) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V048B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить повтор события без второго resume. Частный результат исходного V048: Trigger ID + правило + native turn → постоянный delivery request_key. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V048B.
      Приёмка: Hook/observer/end-turn повтор не создаёт второй continuation; hold всегда проверен. Это точка объединения всей цепочки V048A, V048B, V048.
      Затрагиваемые файлы: `crates/herder/src/automation/executor.rs`
  - V101 · ⏸ Отложено владельцем · (Отключить origin и подтвердить partial без локального повтора) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V101B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Отключить origin и подтвердить partial без локального повтора. Частный результат исходного V101: Codex→OpenCode через объявленные endpoints; exact origin refs. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V101B.
      Приёмка: Чтение result с удалённой ноды доступно клиенту; offline coverage partial, no local retry. Это точка объединения всей цепочки V101A, V101B, V101.
      Затрагиваемые файлы: `acceptance/multi/nodes/`
  - V102 · ⏸ Отложено владельцем · (Подтвердить восстановление creator A и единственный ответ C) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V102B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить восстановление creator A и единственный ответ C. Частный результат исходного V102: A создаёт B, C пишет B; очистить context и рестарт Herder; B отвечает C. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V102B.
      Приёмка: Native readback одного ответа C; A остался creator; доказана инъекция, не только resource read. Это точка объединения всей цепочки V102A, V102B, V102.
      Затрагиваемые файлы: `acceptance/context/compaction/`
  - V103 · ⏸ Отложено владельцем · (Проверить сбой после completion без повторной отправки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V103B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить сбой после completion без повторной отправки. Частный результат исходного V103: Три точки сбоя: до вызова, после admission, после completion до ответа. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V103B.
      Приёмка: Повтор key не создаёт input; unknown без native lookup остаётся unknown. Это точка объединения всей цепочки V103A, V103B, V103.
      Затрагиваемые файлы: `acceptance/native/crash/`
  - V104 · ⏸ Отложено владельцем · (Проверить admission, completion и исправляемую ошибку) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V104B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить admission, completion и исправляемую ошибку. Частный результат исходного V104: Subcommands из тех же DTO/application, polling Tasks и чтение ресурсов. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V104B.
      Приёмка: create/deliver/read ошибки и completion показаны раздельно; old routes отсутствуют. Это точка объединения всей цепочки V104A, V104B, V104.
      Затрагиваемые файлы: `crates/herder/src/cli/main.rs`
  - V105 · ⏸ Отложено владельцем · (Подтвердить обе роли и remote resource после reload) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V105B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить обе роли и remote resource после reload. Частный результат исходного V105: Typed client sessions/recent/transcript, partial/turn refs. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V105B.
      Приёмка: Обычный браузер показывает обе роли после reload и remote resource. Это точка объединения всей цепочки V105A, V105B, V105.
      Затрагиваемые файлы: `web/src/session.ts`
  - V114A · ⏸ Отложено владельцем · (Notice Place: заменить вызов на общий typed API) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V113 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Notice Place: заменить вызов на общий typed API. Частный результат исходного V114: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V113.
      Приёмка: Получен проверяемый результат: Notice Place: заменить вызов на общий typed API. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `consumer:noticeplace:paths-from-target.json`
  - V117A · ⏸ Отложено владельцем · (UserIO: заменить вызов на общий typed API) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V116 · стоимость — вне сметы · отложено владельцем
      Описание задачи: UserIO: заменить вызов на общий typed API. Частный результат исходного V117: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V116.
      Приёмка: Получен проверяемый результат: UserIO: заменить вызов на общий typed API. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `consumer:userio:paths-from-target.json`
  - V141 · ⏸ Отложено владельцем · (Записать latency и RSS и проверить ограниченность очередей) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V141B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Записать latency и RSS и проверить ограниченность очередей. Частный результат исходного V141: Фиксированный corpus, concurrent read/send/index и slow subscriber; baseline metrics. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V141B.
      Приёмка: Нет busy loop/unbounded queue; latency/RSS и границы workload записаны, starvation не наблюдается. Это точка объединения всей цепочки V141A, V141B, V141.
      Затрагиваемые файлы: `acceptance/performance/`
  - V049A · ⏸ Отложено владельцем · (Вычислять следующий срок с timezone и DST) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V048 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Вычислять следующий срок с timezone и DST. Частный результат исходного V049: Clock как вход pure reducer; bounded catch-up и no overlap. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V048.
      Приёмка: Получен проверяемый результат: Вычислять следующий срок с timezone и DST. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `tests/automation/schedule.rs`
  - V050A · ⏸ Отложено владельцем · (Остановить autopilot по достигнутой цели или бюджету) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V048 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Остановить autopilot по достигнутой цели или бюджету. Частный результат исходного V050: Existing goal judge contract как input; bounded continuation, явный failure. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V048.
      Приёмка: Получен проверяемый результат: Остановить autopilot по достигнутой цели или бюджету. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/automation/autopilot.rs`
  - V106A · ⏸ Отложено владельцем · (Подключить create, deliver и stop к общему client) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V105, V033 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подключить create, deliver и stop к общему client. Частный результат исходного V106: Create/deliver/stop/settings; standard polling и cancelled/unknown rendering. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V105, V033.
      Приёмка: Получен проверяемый результат: Подключить create, deliver и stop к общему client. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `web/src/control.ts`
  - V114B · ⏸ Отложено владельцем · (Notice Place: сохранить request key, Task и диагностические ошибки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V114A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Notice Place: сохранить request key, Task и диагностические ошибки. Частный результат исходного V114: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V114A.
      Приёмка: Получен проверяемый результат: Notice Place: сохранить request key, Task и диагностические ошибки. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `consumer:noticeplace:paths-from-target.json`
  - V117B · ⏸ Отложено владельцем · (UserIO: сохранить request key, Task и диагностические ошибки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V117A · стоимость — вне сметы · отложено владельцем
      Описание задачи: UserIO: сохранить request key, Task и диагностические ошибки. Частный результат исходного V117: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V117A.
      Приёмка: Получен проверяемый результат: UserIO: сохранить request key, Task и диагностические ошибки. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `consumer:userio:paths-from-target.json`
  - V126A · ⏸ Отложено владельцем · (Описать context, сообщения, reply_to и ресурс в одном Skill) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V019, V102 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Описать context, сообщения, reply_to и ресурс в одном Skill. Частный результат исходного V126: context→messages→reply_to, roster/worktree и errors; один источник примеров. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V019, V102.
      Приёмка: Получен проверяемый результат: Описать context, сообщения, reply_to и ресурс в одном Skill. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `skills/herder/SKILL.md`
  - V133A · ⏸ Отложено владельцем · (Сделать снимок fixture и запустить импорт дважды) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V132, V103 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сделать снимок fixture и запустить импорт дважды. Частный результат исходного V133: Checksums/counts, run importer дважды, restart, no-send readback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V132, V103.
      Приёмка: Получен проверяемый результат: Сделать снимок fixture и запустить импорт дважды. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/migration/rehearsal/`
  - V049B · ⏸ Отложено владельцем · (Сохранять pause и исход выполнявшегося события при рестарте) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V049A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сохранять pause и исход выполнявшегося события при рестарте. Частный результат исходного V049: Clock как вход pure reducer; bounded catch-up и no overlap. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V049A.
      Приёмка: Получен проверяемый результат: Сохранять pause и исход выполнявшегося события при рестарте. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `tests/automation/schedule.rs`
  - V050B · ⏸ Отложено владельцем · (Сохранять причину остановки и HumanStop) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V050A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сохранять причину остановки и HumanStop. Частный результат исходного V050: Existing goal judge contract как input; bounded continuation, явный failure. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V050A.
      Приёмка: Получен проверяемый результат: Сохранять причину остановки и HumanStop. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `crates/herder/src/automation/autopilot.rs`
  - V106B · ⏸ Отложено владельцем · (Показать settings и стандартные состояния Task) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V106A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Показать settings и стандартные состояния Task. Частный результат исходного V106: Create/deliver/stop/settings; standard polling и cancelled/unknown rendering. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V106A.
      Приёмка: Получен проверяемый результат: Показать settings и стандартные состояния Task. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `web/src/control.ts`
  - V114 · ⏸ Отложено владельцем · (Notice Place: проверить отсутствие legacy alias и второго job lifecycle) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V114B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Notice Place: проверить отсутствие legacy alias и второго job lifecycle. Частный результат исходного V114: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V114B.
      Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены. Это точка объединения всей цепочки V114A, V114B, V114.
      Затрагиваемые файлы: `consumer:noticeplace:paths-from-target.json`
  - V117 · ⏸ Отложено владельцем · (UserIO: проверить отсутствие legacy alias и второго job lifecycle) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V117B · стоимость — вне сметы · отложено владельцем
      Описание задачи: UserIO: проверить отсутствие legacy alias и второго job lifecycle. Частный результат исходного V117: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V117B.
      Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены. Это точка объединения всей цепочки V117A, V117B, V117.
      Затрагиваемые файлы: `consumer:userio:paths-from-target.json`
  - V126B · ⏸ Отложено владельцем · (Сверить примеры с реальными схемами каталога) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V126A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сверить примеры с реальными схемами каталога. Частный результат исходного V126: context→messages→reply_to, roster/worktree и errors; один источник примеров. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V126A.
      Приёмка: Получен проверяемый результат: Сверить примеры с реальными схемами каталога. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `skills/herder/SKILL.md`
  - V133B · ⏸ Отложено владельцем · (Перезапустить новый daemon и сверить holds и UNKNOWN) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V133A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Перезапустить новый daemon и сверить holds и UNKNOWN. Частный результат исходного V133: Checksums/counts, run importer дважды, restart, no-send readback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V133A.
      Приёмка: Получен проверяемый результат: Перезапустить новый daemon и сверить holds и UNKNOWN. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/migration/rehearsal/`
  - V049 · ⏸ Отложено владельцем · (Проверить пропущенный срок без повторения UNKNOWN) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V049B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить пропущенный срок без повторения UNKNOWN. Частный результат исходного V049: Clock как вход pure reducer; bounded catch-up и no overlap. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V049B.
      Приёмка: DST fold/gap, restart после admission и pause не дают дубля. Это точка объединения всей цепочки V049A, V049B, V049.
      Затрагиваемые файлы: `tests/automation/schedule.rs`
  - V050 · ⏸ Отложено владельцем · (Подтвердить отсутствие нового хода после остановки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V050B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить отсутствие нового хода после остановки. Частный результат исходного V050: Existing goal judge contract как input; bounded continuation, явный failure. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V050B.
      Приёмка: Goal done, quota unknown/denied и HumanStop не вызывают retry-loop; одна continuation на turn. Это точка объединения всей цепочки V050A, V050B, V050.
      Затрагиваемые файлы: `crates/herder/src/automation/autopilot.rs`
  - V106 · ⏸ Отложено владельцем · (Проверить двойной клик и UNKNOWN без предложения resend) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V106B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить двойной клик и UNKNOWN без предложения resend. Частный результат исходного V106: Create/deliver/stop/settings; standard polling и cancelled/unknown rendering. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V106B.
      Приёмка: Повтор кнопки не даёт duplicate; unknown не предлагает повторную отправку. Это точка объединения всей цепочки V106A, V106B, V106.
      Затрагиваемые файлы: `web/src/control.ts`
  - V115A · ⏸ Отложено владельцем · (Notice Place: выполнить основной сценарий через обычного потребителя) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V114 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Notice Place: выполнить основной сценарий через обычного потребителя. Частный результат исходного V115: Один изолированный сценарий через обычного потребителя и native result. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V114.
      Приёмка: Получен проверяемый результат: Notice Place: выполнить основной сценарий через обычного потребителя. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/consumers/noticeplace/`
  - V118A · ⏸ Отложено владельцем · (UserIO: выполнить основной сценарий через обычного потребителя) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V117 · стоимость — вне сметы · отложено владельцем
      Описание задачи: UserIO: выполнить основной сценарий через обычного потребителя. Частный результат исходного V118: Один изолированный сценарий через обычного потребителя и native result. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V117.
      Приёмка: Получен проверяемый результат: UserIO: выполнить основной сценарий через обычного потребителя. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/consumers/userio/`
  - V126 · ⏸ Отложено владельцем · (Проверить краткий путь координации без специальных команд harness) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V126B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить краткий путь координации без специальных команд harness. Частный результат исходного V126: context→messages→reply_to, roster/worktree и errors; один источник примеров. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V126B.
      Приёмка: Каталог/schema примеров совпадают; read skill и activation отмечены отдельно. Это точка объединения всей цепочки V126A, V126B, V126.
      Затрагиваемые файлы: `skills/herder/SKILL.md`
  - V133 · ⏸ Отложено владельцем · (Подтвердить ноль send и отказ на повреждённом входе) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V133B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить ноль send и отказ на повреждённом входе. Частный результат исходного V133: Checksums/counts, run importer дважды, restart, no-send readback. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V133B.
      Приёмка: Ноль native send/create; все holds/UNKNOWN сохранены; корректный отказ при corrupt input. Это точка объединения всей цепочки V133A, V133B, V133.
      Затрагиваемые файлы: `acceptance/migration/rehearsal/`
  - V115 · ⏸ Отложено владельцем · (Notice Place: сверить native результат и версии без повторной отправки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V115A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Notice Place: сверить native результат и версии без повторной отправки. Частный результат исходного V115: Один изолированный сценарий через обычного потребителя и native result. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V115A.
      Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль. Это точка объединения всей цепочки V115A, V115.
      Затрагиваемые файлы: `acceptance/consumers/noticeplace/`
  - V118 · ⏸ Отложено владельцем · (UserIO: сверить native результат и версии без повторной отправки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V118A · стоимость — вне сметы · отложено владельцем
      Описание задачи: UserIO: сверить native результат и версии без повторной отправки. Частный результат исходного V118: Один изолированный сценарий через обычного потребителя и native result. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V118A.
      Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль. Это точка объединения всей цепочки V118A, V118.
      Затрагиваемые файлы: `acceptance/consumers/userio/`
  - V122A · ⏸ Отложено владельцем · (Секретарь: найти один вызывающий Herder маршрут и владельца путей) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V009, V049 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Секретарь: найти один вызывающий Herder маршрут и владельца путей. Частный результат исходного V122: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V009, V049.
      Приёмка: Получен проверяемый результат: Секретарь: найти один вызывающий Herder маршрут и владельца путей. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `integrations/consumers/secretary/target.json`
  - V127A · ⏸ Отложено владельцем · (Дать свежему агенту задачу найти коллег и отправителя) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V126, V106, V104 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Дать свежему агенту задачу найти коллег и отправителя. Частный результат исходного V127: Свежий контекст без исходников: найти роли, исправить wrong mode/field и ответить отправителю. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V126, V106, V104.
      Приёмка: Получен проверяемый результат: Дать свежему агенту задачу найти коллег и отправителя. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/usability/`
  - V134A · ⏸ Отложено владельцем · (Описать maintenance и сохранение нового ledger при откате) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V133 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Описать maintenance и сохранение нового ledger при откате. Частный результат исходного V134: Maintenance + сохранённый ledger + предыдущий новый binary/schema compatible; старый daemon не включать без reverse proof. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V133.
      Приёмка: Получен проверяемый результат: Описать maintenance и сохранение нового ledger при откате. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/rollback.md`
  - V136A · ⏸ Отложено владельцем · (linux/amd64: собрать locked binary с UI и Skills) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V104, V106, V125 · стоимость — вне сметы · отложено владельцем
      Описание задачи: linux/amd64: собрать locked binary с UI и Skills. Частный результат исходного V136: Reproducible locked build с embedded UI/Skills, digest и platform manifest. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V104, V106, V125.
      Приёмка: Получен проверяемый результат: linux/amd64: собрать locked binary с UI и Skills. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/build/linux-amd64/`
  - V137A · ⏸ Отложено владельцем · (linux/arm64: собрать locked binary с UI и Skills) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V104, V106, V125 · стоимость — вне сметы · отложено владельцем
      Описание задачи: linux/arm64: собрать locked binary с UI и Skills. Частный результат исходного V137: Reproducible locked build с embedded UI/Skills, digest и platform manifest. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V104, V106, V125.
      Приёмка: Получен проверяемый результат: linux/arm64: собрать locked binary с UI и Skills. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/build/linux-arm64/`
  - V138A · ⏸ Отложено владельцем · (macOS/arm64: собрать locked binary с UI и Skills) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V104, V106, V125 · стоимость — вне сметы · отложено владельцем
      Описание задачи: macOS/arm64: собрать locked binary с UI и Skills. Частный результат исходного V138: Reproducible locked build с embedded UI/Skills, digest и platform manifest. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V104, V106, V125.
      Приёмка: Получен проверяемый результат: macOS/arm64: собрать locked binary с UI и Skills. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/build/macos-arm64/`
  - V139A · ⏸ Отложено владельцем · (macOS/amd64: собрать locked binary с UI и Skills) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V104, V106, V125 · стоимость — вне сметы · отложено владельцем
      Описание задачи: macOS/amd64: собрать locked binary с UI и Skills. Частный результат исходного V139: Reproducible locked build с embedded UI/Skills, digest и platform manifest. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V104, V106, V125.
      Приёмка: Получен проверяемый результат: macOS/amd64: собрать locked binary с UI и Skills. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/build/macos-amd64/`
  - V122 · ⏸ Отложено владельцем · (Секретарь: записать target.json с точным контрактом и тестовым маршрутом) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V122A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Секретарь: записать target.json с точным контрактом и тестовым маршрутом. Частный результат исходного V122: Узко прочитать только вызывающий Herder маршрут и назвать repo/files, owner, versions и test route. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V122A.
      Приёмка: target.json содержит точные writable paths и нативный сценарий; не общее обследование. Нет полномочий — blocker этой интеграции. Это точка объединения всей цепочки V122A, V122.
      Затрагиваемые файлы: `integrations/consumers/secretary/target.json`
  - V127B · ⏸ Отложено владельцем · (Попросить исправить неверный аргумент по сообщению ошибки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V127A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Попросить исправить неверный аргумент по сообщению ошибки. Частный результат исходного V127: Свежий контекст без исходников: найти роли, исправить wrong mode/field и ответить отправителю. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V127A.
      Приёмка: Получен проверяемый результат: Попросить исправить неверный аргумент по сообщению ошибки. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/usability/`
  - V134B · ⏸ Отложено владельцем · (Проверить совместимость предыдущего нового binary со schema) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V134A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить совместимость предыдущего нового binary со schema. Частный результат исходного V134: Maintenance + сохранённый ledger + предыдущий новый binary/schema compatible; старый daemon не включать без reverse proof. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V134A.
      Приёмка: Получен проверяемый результат: Проверить совместимость предыдущего нового binary со schema. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/rollback.md`
  - V136B · ⏸ Отложено владельцем · (linux/amd64: записать digest и platform manifest) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V136A · стоимость — вне сметы · отложено владельцем
      Описание задачи: linux/amd64: записать digest и platform manifest. Частный результат исходного V136: Reproducible locked build с embedded UI/Skills, digest и platform manifest. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V136A.
      Приёмка: Получен проверяемый результат: linux/amd64: записать digest и platform manifest. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/build/linux-amd64/`
  - V137B · ⏸ Отложено владельцем · (linux/arm64: записать digest и platform manifest) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V137A · стоимость — вне сметы · отложено владельцем
      Описание задачи: linux/arm64: записать digest и platform manifest. Частный результат исходного V137: Reproducible locked build с embedded UI/Skills, digest и platform manifest. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V137A.
      Приёмка: Получен проверяемый результат: linux/arm64: записать digest и platform manifest. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/build/linux-arm64/`
  - V138B · ⏸ Отложено владельцем · (macOS/arm64: записать digest и platform manifest) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V138A · стоимость — вне сметы · отложено владельцем
      Описание задачи: macOS/arm64: записать digest и platform manifest. Частный результат исходного V138: Reproducible locked build с embedded UI/Skills, digest и platform manifest. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V138A.
      Приёмка: Получен проверяемый результат: macOS/arm64: записать digest и platform manifest. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/build/macos-arm64/`
  - V139B · ⏸ Отложено владельцем · (macOS/amd64: записать digest и platform manifest) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V139A · стоимость — вне сметы · отложено владельцем
      Описание задачи: macOS/amd64: записать digest и platform manifest. Частный результат исходного V139: Reproducible locked build с embedded UI/Skills, digest и platform manifest. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V139A.
      Приёмка: Получен проверяемый результат: macOS/amd64: записать digest и platform manifest. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/build/macos-amd64/`
  - V123A · ⏸ Отложено владельцем · (Секретарь: заменить вызов на общий typed API) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V122 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Секретарь: заменить вызов на общий typed API. Частный результат исходного V123: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V122.
      Приёмка: Получен проверяемый результат: Секретарь: заменить вызов на общий typed API. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `consumer:secretary:paths-from-target.json`
  - V127 · ⏸ Отложено владельцем · (Подтвердить один правильный повтор и отсутствие resend UNKNOWN) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V127B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить один правильный повтор и отсутствие resend UNKNOWN. Частный результат исходного V127: Свежий контекст без исходников: найти роли, исправить wrong mode/field и ответить отправителю. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V127B.
      Приёмка: Trace показывает исправление за один повтор без новых effects; UNKNOWN/forbidden не вызывают unsafe retry. Это точка объединения всей цепочки V127A, V127B, V127.
      Затрагиваемые файлы: `acceptance/usability/`
  - V134 · ⏸ Отложено владельцем · (Зафиксировать отказ от запуска старого writer без reverse proof) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V134B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Зафиксировать отказ от запуска старого writer без reverse proof. Частный результат исходного V134: Maintenance + сохранённый ledger + предыдущий новый binary/schema compatible; старый daemon не включать без reverse proof. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V134B.
      Приёмка: New hold/receipt переживают откат; old writer не получает ownership; rollback отдельно от release. Это точка объединения всей цепочки V134A, V134B, V134.
      Затрагиваемые файлы: `release/rollback.md`
  - V136 · ⏸ Отложено владельцем · (linux/amd64: запустить артефакт на соответствующем native runner) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V136B · стоимость — вне сметы · отложено владельцем
      Описание задачи: linux/amd64: запустить артефакт на соответствующем native runner. Частный результат исходного V136: Reproducible locked build с embedded UI/Skills, digest и platform manifest. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V136B.
      Приёмка: Binary запускается в целевой среде/соответствующем runner; cross-compile отдельно от native run; Node daemon не нужен. Это точка объединения всей цепочки V136A, V136B, V136.
      Затрагиваемые файлы: `release/build/linux-amd64/`
  - V137 · ⏸ Отложено владельцем · (linux/arm64: запустить артефакт на соответствующем native runner) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V137B · стоимость — вне сметы · отложено владельцем
      Описание задачи: linux/arm64: запустить артефакт на соответствующем native runner. Частный результат исходного V137: Reproducible locked build с embedded UI/Skills, digest и platform manifest. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V137B.
      Приёмка: Binary запускается в целевой среде/соответствующем runner; cross-compile отдельно от native run; Node daemon не нужен. Это точка объединения всей цепочки V137A, V137B, V137.
      Затрагиваемые файлы: `release/build/linux-arm64/`
  - V138 · ⏸ Отложено владельцем · (macOS/arm64: запустить артефакт на соответствующем native runner) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V138B · стоимость — вне сметы · отложено владельцем
      Описание задачи: macOS/arm64: запустить артефакт на соответствующем native runner. Частный результат исходного V138: Reproducible locked build с embedded UI/Skills, digest и platform manifest. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V138B.
      Приёмка: Binary запускается в целевой среде/соответствующем runner; cross-compile отдельно от native run; Node daemon не нужен. Это точка объединения всей цепочки V138A, V138B, V138.
      Затрагиваемые файлы: `release/build/macos-arm64/`
  - V139 · ⏸ Отложено владельцем · (macOS/amd64: запустить артефакт на соответствующем native runner) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V139B · стоимость — вне сметы · отложено владельцем
      Описание задачи: macOS/amd64: запустить артефакт на соответствующем native runner. Частный результат исходного V139: Reproducible locked build с embedded UI/Skills, digest и platform manifest. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V139B.
      Приёмка: Binary запускается в целевой среде/соответствующем runner; cross-compile отдельно от native run; Node daemon не нужен. Это точка объединения всей цепочки V139A, V139B, V139.
      Затрагиваемые файлы: `release/build/macos-amd64/`
  - V123B · ⏸ Отложено владельцем · (Секретарь: сохранить request key, Task и диагностические ошибки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V123A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Секретарь: сохранить request key, Task и диагностические ошибки. Частный результат исходного V123: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V123A.
      Приёмка: Получен проверяемый результат: Секретарь: сохранить request key, Task и диагностические ошибки. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `consumer:secretary:paths-from-target.json`
  - V135A · ⏸ Отложено владельцем · (Принять новый тестовый intent до отката) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V134 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Принять новый тестовый intent до отката. Частный результат исходного V135: Изолированный candidate принимает тестовый intent, rollback читает его без replay. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V134.
      Приёмка: Получен проверяемый результат: Принять новый тестовый intent до отката. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/migration/rollback/`
  - V140A · ⏸ Отложено владельцем · (Установить binary и assets в параметризованный root) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V136, V137, V138, V139 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Установить binary и assets в параметризованный root. Частный результат исходного V140: Install artifact/config/manifest/local instruction, preserve data; explicit paths и service launcher. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V136, V137, V138, V139.
      Приёмка: Получен проверяемый результат: Установить binary и assets в параметризованный root. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/install/`
  - V123 · ⏸ Отложено владельцем · (Секретарь: проверить отсутствие legacy alias и второго job lifecycle) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V123B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Секретарь: проверить отсутствие legacy alias и второго job lifecycle. Частный результат исходного V123: Заменить old API на typed contract с exact session/task/message refs в подтверждённых target.json путях. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V123B.
      Приёмка: Contract check показывает сохранение effect/receipt/errors; aliases и duplicate jobs не добавлены. Это точка объединения всей цепочки V123A, V123B, V123.
      Затрагиваемые файлы: `consumer:secretary:paths-from-target.json`
  - V135B · ⏸ Отложено владельцем · (Выполнить откат совместимого нового binary на том же ledger) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V135A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Выполнить откат совместимого нового binary на том же ledger. Частный результат исходного V135: Изолированный candidate принимает тестовый intent, rollback читает его без replay. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V135A.
      Приёмка: Получен проверяемый результат: Выполнить откат совместимого нового binary на том же ledger. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/migration/rollback/`
  - V140B · ⏸ Отложено владельцем · (Установить manifest и launcher с сохранением данных) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V140A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Установить manifest и launcher с сохранением данных. Частный результат исходного V140: Install artifact/config/manifest/local instruction, preserve data; explicit paths и service launcher. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V140A.
      Приёмка: Получен проверяемый результат: Установить manifest и launcher с сохранением данных. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/install/`
  - V124A · ⏸ Отложено владельцем · (Секретарь: выполнить основной сценарий через обычного потребителя) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V123 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Секретарь: выполнить основной сценарий через обычного потребителя. Частный результат исходного V124: Один изолированный сценарий через обычного потребителя и native result. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V123.
      Приёмка: Получен проверяемый результат: Секретарь: выполнить основной сценарий через обычного потребителя. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/consumers/secretary/`
  - V135 · ⏸ Отложено владельцем · (Подтвердить HumanStop и UNKNOWN без replay) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V135B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить HumanStop и UNKNOWN без replay. Частный результат исходного V135: Изолированный candidate принимает тестовый intent, rollback читает его без replay. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V135B.
      Приёмка: Unknown/confirmed и HumanStop не потеряны; incompatible schema останавливает writes. Это точка объединения всей цепочки V135A, V135B, V135.
      Затрагиваемые файлы: `acceptance/migration/rollback/`
  - V140 · ⏸ Отложено владельцем · (Проверить offline CLI и повтор установки без чужих изменений) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V140B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить offline CLI и повтор установки без чужих изменений. Частный результат исходного V140: Install artifact/config/manifest/local instruction, preserve data; explicit paths и service launcher. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V140B.
      Приёмка: Нестандартный root работает; offline CLI доступен без daemon; чужой service/config не меняется. Это точка объединения всей цепочки V140A, V140B, V140.
      Затрагиваемые файлы: `release/install/`
  - T015 · ⏸ Отложено владельцем · (Упаковать translator и инструкции подключения и удаления) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: T014, V140 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Реализовать только этот проверяемый шаг по COMPATIBILITY.md. Входы: T014, V140. При неизвестном SDK/consumer маршруте сначала назвать минимальный пробел; не форкать Codex.
      Приёмка: Отдельный binary/config; старый клиент подключается штатно; удаление пакета не требует менять core или данные.
      Затрагиваемые файлы: `crates/herder-compat/`, `acceptance/compat/`
  - V124 · ⏸ Отложено владельцем · (Секретарь: сверить native результат и версии без повторной отправки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V124A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Секретарь: сверить native результат и версии без повторной отправки. Частный результат исходного V124: Один изолированный сценарий через обычного потребителя и native result. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V124A.
      Приёмка: Artifact/consumer version + exact receipt; accepted не completed; Notice Place только test contact, звонков людям ноль. Это точка объединения всей цепочки V124A, V124.
      Затрагиваемые файлы: `acceptance/consumers/secretary/`
  - V142A · ⏸ Отложено владельцем · (Проверить diff общих boundaries и ошибок) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V060, V069, V078, V087, V096, V109, V112, V115, V118, V121, V124, V102, V098, V099, V100, V101, V103, V127, V128, V141, V135, V050, R004, R005, R006, T013, T014 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить diff общих boundaries и ошибок. Частный результат исходного V142: Один diff review по boundaries/errors/ownership/cutover; конкретный журнал дефектов. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V060, V069, V078, V087, V096, V109, V112, V115, V118, V121, V124, V102, V098, V099, V100, V101, V103, V127, V128, V141, V135, V050, R004, R005, R006.
      Приёмка: Получен проверяемый результат: Проверить diff общих boundaries и ошибок. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/review/`
  - V142B · ⏸ Отложено владельцем · (Проверить ownership, UNKNOWN и cutover в том же diff) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V142A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить ownership, UNKNOWN и cutover в том же diff. Частный результат исходного V142: Один diff review по boundaries/errors/ownership/cutover; конкретный журнал дефектов. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V142A.
      Приёмка: Получен проверяемый результат: Проверить ownership, UNKNOWN и cutover в том же diff. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/review/`
  - V142 · ⏸ Отложено владельцем · (Назначить конкретные исправления с доказательствами до RC) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V142B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Назначить конкретные исправления с доказательствами до RC. Частный результат исходного V142: Один diff review по boundaries/errors/ownership/cutover; конкретный журнал дефектов. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V142B.
      Приёмка: Все найденные defects имеют owned fix/retest leaf до release; review не выдаёт будущий PASS. Это точка объединения всей цепочки V142A, V142B, V142.
      Затрагиваемые файлы: `acceptance/review/`
  - V143A · ⏸ Отложено владельцем · (Выявить заменённые runtime entrypoints по reviewed diff) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V142, V140 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Выявить заменённые runtime entrypoints по reviewed diff. Частный результат исходного V143: Удалить заменённые TS daemon/job API/_async/aliases из source и package entrypoints. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V142, V140.
      Приёмка: Получен проверяемый результат: Выявить заменённые runtime entrypoints по reviewed diff. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `legacy-removal:runtime paths resolved in reviewed diff`
  - V143B · ⏸ Отложено владельцем · (Удалить старый daemon, jobs и aliases из source и packaging) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V143A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Удалить старый daemon, jobs и aliases из source и packaging. Частный результат исходного V143: Удалить заменённые TS daemon/job API/_async/aliases из source и package entrypoints. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V143A.
      Приёмка: Получен проверяемый результат: Удалить старый daemon, jobs и aliases из source и packaging. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `legacy-removal:runtime paths resolved in reviewed diff`
  - V143 · ⏸ Отложено владельцем · (Проверить отсутствие старых вызовов с сохранением frontend и истории) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V143B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить отсутствие старых вызовов с сохранением frontend и истории. Частный результат исходного V143: Удалить заменённые TS daemon/job API/_async/aliases из source и package entrypoints. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V143B.
      Приёмка: Старые имена не вызываются напрямую; frontend TS сохранён как frontend; native histories не удалены. Это точка объединения всей цепочки V143A, V143B, V143.
      Затрагиваемые файлы: `legacy-removal:runtime paths resolved in reviewed diff`
  - V144A · ⏸ Отложено владельцем · (Заменить старые launcher и hook ссылки подтверждённых consumers) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V143 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Заменить старые launcher и hook ссылки подтверждённых consumers. Частный результат исходного V144: Пакеты/hooks/docs consumers используют новый API; прежние fallback writers disabled. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V143.
      Приёмка: Получен проверяемый результат: Заменить старые launcher и hook ссылки подтверждённых consumers. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `legacy-removal:active client paths from consumer targets`
  - V144B · ⏸ Отложено владельцем · (Удалить активные fallback writers и устаревшие инструкции) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V144A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Удалить активные fallback writers и устаревшие инструкции. Частный результат исходного V144: Пакеты/hooks/docs consumers используют новый API; прежние fallback writers disabled. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V144A.
      Приёмка: Получен проверяемый результат: Удалить активные fallback writers и устаревшие инструкции. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `legacy-removal:active client paths from consumer targets`
  - V144 · ⏸ Отложено владельцем · (Подтвердить новый runtime graph без старого daemon) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V144B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить новый runtime graph без старого daemon. Частный результат исходного V144: Пакеты/hooks/docs consumers используют новый API; прежние fallback writers disabled. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V144B.
      Приёмка: Legacy references только в историческом archive; runtime graph не запускает старый daemon. Это точка объединения всей цепочки V144A, V144B, V144.
      Затрагиваемые файлы: `legacy-removal:active client paths from consumer targets`
  - V145A · ⏸ Отложено владельцем · (Закрепить reviewed source и состав platform artifacts) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V144 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Закрепить reviewed source и состав platform artifacts. Частный результат исходного V145: Build exact reviewed source после удаления legacy, manifests всех платформ. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V144.
      Приёмка: Получен проверяемый результат: Закрепить reviewed source и состав platform artifacts. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/candidate.json`
  - V145B · ⏸ Отложено владельцем · (Собрать manifests с digest единого кандидата) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V145A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Собрать manifests с digest единого кандидата. Частный результат исходного V145: Build exact reviewed source после удаления legacy, manifests всех платформ. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V145A.
      Приёмка: Получен проверяемый результат: Собрать manifests с digest единого кандидата. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/candidate.json`
  - V145 · ⏸ Отложено владельцем · (Проверить отсутствие чужого WIP в release candidate) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V145B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить отсутствие чужого WIP в release candidate. Частный результат исходного V145: Build exact reviewed source после удаления legacy, manifests всех платформ. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V145B.
      Приёмка: Каждая тестовая lane указывает один source revision/artifact family; чужой WIP не включён. Это точка объединения всей цепочки V145A, V145B, V145.
      Затрагиваемые файлы: `release/candidate.json`
  - V146A · ⏸ Отложено владельцем · (Codex: запустить готовый native сценарий на финальном RC) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V145, V060 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: запустить готовый native сценарий на финальном RC. Частный результат исходного V146: Один обязательный adapter lane повторён на финальном artifact без иных изменений. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V145, V060.
      Приёмка: Получен проверяемый результат: Codex: запустить готовый native сценарий на финальном RC. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/candidate/codex/`
  - V147A · ⏸ Отложено владельцем · (OpenCode: запустить готовый native сценарий на финальном RC) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V145, V069 · стоимость — вне сметы · отложено владельцем
      Описание задачи: OpenCode: запустить готовый native сценарий на финальном RC. Частный результат исходного V147: Один обязательный adapter lane повторён на финальном artifact без иных изменений. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V145, V069.
      Приёмка: Получен проверяемый результат: OpenCode: запустить готовый native сценарий на финальном RC. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/candidate/opencode/`
  - V148A · ⏸ Отложено владельцем · (ZCode: запустить готовый native сценарий на финальном RC) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V145, V078 · стоимость — вне сметы · отложено владельцем
      Описание задачи: ZCode: запустить готовый native сценарий на финальном RC. Частный результат исходного V148: Один обязательный adapter lane повторён на финальном artifact без иных изменений. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V145, V078.
      Приёмка: Получен проверяемый результат: ZCode: запустить готовый native сценарий на финальном RC. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/candidate/zcode/`
  - V149A · ⏸ Отложено владельцем · (ChatGPT: запустить готовый native сценарий на финальном RC) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V145, V087 · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: запустить готовый native сценарий на финальном RC. Частный результат исходного V149: Один обязательный adapter lane повторён на финальном artifact без иных изменений. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V145, V087.
      Приёмка: Получен проверяемый результат: ChatGPT: запустить готовый native сценарий на финальном RC. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/candidate/chatgpt/`
  - V150A · ⏸ Отложено владельцем · (Z.ai: запустить готовый native сценарий на финальном RC) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V145, V096 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Z.ai: запустить готовый native сценарий на финальном RC. Частный результат исходного V150: Один обязательный adapter lane повторён на финальном artifact без иных изменений. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V145, V096.
      Приёмка: Получен проверяемый результат: Z.ai: запустить готовый native сценарий на финальном RC. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/candidate/z-ai/`
  - V151A · ⏸ Отложено владельцем · (Сопоставить consumer receipts с API и schema digest кандидата) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V145, V109, V112, V115, V118, V121, V124 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сопоставить consumer receipts с API и schema digest кандидата. Частный результат исходного V151: Сверить ранее полученные consumer proofs с API/schema digest RC; повторить затронутый основной путь. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V145, V109, V112, V115, V118, V121, V124.
      Приёмка: Получен проверяемый результат: Сопоставить consumer receipts с API и schema digest кандидата. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/candidate/consumers/`
  - V146 · ⏸ Отложено владельцем · (Codex: сверить native refs и digest именно финального RC) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V146A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Codex: сверить native refs и digest именно финального RC. Частный результат исходного V146: Один обязательный adapter lane повторён на финальном artifact без иных изменений. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V146A.
      Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS. Это точка объединения всей цепочки V146A, V146.
      Затрагиваемые файлы: `acceptance/candidate/codex/`
  - V147 · ⏸ Отложено владельцем · (OpenCode: сверить native refs и digest именно финального RC) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V147A · стоимость — вне сметы · отложено владельцем
      Описание задачи: OpenCode: сверить native refs и digest именно финального RC. Частный результат исходного V147: Один обязательный adapter lane повторён на финальном artifact без иных изменений. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V147A.
      Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS. Это точка объединения всей цепочки V147A, V147.
      Затрагиваемые файлы: `acceptance/candidate/opencode/`
  - V148 · ⏸ Отложено владельцем · (ZCode: сверить native refs и digest именно финального RC) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V148A · стоимость — вне сметы · отложено владельцем
      Описание задачи: ZCode: сверить native refs и digest именно финального RC. Частный результат исходного V148: Один обязательный adapter lane повторён на финальном artifact без иных изменений. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V148A.
      Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS. Это точка объединения всей цепочки V148A, V148.
      Затрагиваемые файлы: `acceptance/candidate/zcode/`
  - V149 · ⏸ Отложено владельцем · (ChatGPT: сверить native refs и digest именно финального RC) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V149A · стоимость — вне сметы · отложено владельцем
      Описание задачи: ChatGPT: сверить native refs и digest именно финального RC. Частный результат исходного V149: Один обязательный adapter lane повторён на финальном artifact без иных изменений. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V149A.
      Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS. Это точка объединения всей цепочки V149A, V149.
      Затрагиваемые файлы: `acceptance/candidate/chatgpt/`
  - V150 · ⏸ Отложено владельцем · (Z.ai: сверить native refs и digest именно финального RC) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V150A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Z.ai: сверить native refs и digest именно финального RC. Частный результат исходного V150: Один обязательный adapter lane повторён на финальном artifact без иных изменений. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V150A.
      Приёмка: Точные native refs и digest; missing lane остаётся blocked, не fixture PASS. Это точка объединения всей цепочки V150A, V150.
      Затрагиваемые файлы: `acceptance/candidate/z-ai/`
  - V151B · ⏸ Отложено владельцем · (Отобрать только затронутые основные consumer сценарии) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V151A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Отобрать только затронутые основные consumer сценарии. Частный результат исходного V151: Сверить ранее полученные consumer proofs с API/schema digest RC; повторить затронутый основной путь. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V151A.
      Приёмка: Получен проверяемый результат: Отобрать только затронутые основные consumer сценарии. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/candidate/consumers/`
  - V151 · ⏸ Отложено владельцем · (Сверить адресные readback с тем же RC без устаревших доказательств) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V151B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сверить адресные readback с тем же RC без устаревших доказательств. Частный результат исходного V151: Сверить ранее полученные consumer proofs с API/schema digest RC; повторить затронутый основной путь. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V151B.
      Приёмка: Несовпадение digest требует отдельной адресной проверки; нельзя принять устаревший receipt. Это точка объединения всей цепочки V151A, V151B, V151.
      Затрагиваемые файлы: `acceptance/candidate/consumers/`
  - V152A · ⏸ Отложено владельцем · (Проверить конкретный target, конфигурацию и полномочия cutover) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V140, V135, V146, V147, V148, V149, V150, V151, E009, T015 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Проверить конкретный target, конфигурацию и полномочия cutover. Частный результат исходного V152: Проверить точные target/config/version/права, snapshot и maintenance window выбранного выпуска. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V140, V135, V146, V147, V148, V149, V150, V151.
      Приёмка: Получен проверяемый результат: Проверить конкретный target, конфигурацию и полномочия cutover. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/cutover/preflight.json`
  - V152B · ⏸ Отложено владельцем · (Создать и прочитать резервную копию сохраняемых данных) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V152A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Создать и прочитать резервную копию сохраняемых данных. Частный результат исходного V152: Проверить точные target/config/version/права, snapshot и maintenance window выбранного выпуска. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V152A.
      Приёмка: Получен проверяемый результат: Создать и прочитать резервную копию сохраняемых данных. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/cutover/preflight.json`
  - V152 · ⏸ Отложено владельцем · (Подтвердить отсутствие неизвестного writer или незавершённого эффекта) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V152B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить отсутствие неизвестного writer или незавершённого эффекта. Частный результат исходного V152: Проверить точные target/config/version/права, snapshot и maintenance window выбранного выпуска. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V152B.
      Приёмка: Нет неизвестных active writers/release effects; backup восстановим; fail-fast до остановки. Это точка объединения всей цепочки V152A, V152B, V152.
      Затрагиваемые файлы: `release/cutover/preflight.json`
  - V153A · ⏸ Отложено владельцем · (Включить maintenance и остановить прежних writers) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V152 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Включить maintenance и остановить прежних writers. Частный результат исходного V153: Остановить старый entrypoint, выполнить проверенный импорт и установить Linux target candidate. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V152.
      Приёмка: Получен проверяемый результат: Включить maintenance и остановить прежних writers. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/cutover/linux/`
  - V153B · ⏸ Отложено владельцем · (Импортировать state и запустить единственного нового writer) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V153A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Импортировать state и запустить единственного нового writer. Частный результат исходного V153: Остановить старый entrypoint, выполнить проверенный импорт и установить Linux target candidate. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V153A.
      Приёмка: Получен проверяемый результат: Импортировать state и запустить единственного нового writer. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/cutover/linux/`
  - V153 · ⏸ Отложено владельцем · (Подтвердить новый runtime и сохранение holds и receipts) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V153B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить новый runtime и сохранение holds и receipts. Частный результат исходного V153: Остановить старый entrypoint, выполнить проверенный импорт и установить Linux target candidate. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V153B.
      Приёмка: Новый runtime SHA/digest/schema; один owner writer; не возобновлены UNKNOWN или HumanStop. Это точка объединения всей цепочки V153A, V153B, V153.
      Затрагиваемые файлы: `release/cutover/linux/`
  - V154A · ⏸ Отложено владельцем · (Подключить обычного Linux клиента к установленному артефакту) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V153 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подключить обычного Linux клиента к установленному артефакту. Частный результат исходного V154: Primary MCP consumer create/deliver/recent/export/context на тестовых сессиях, reload. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V153.
      Приёмка: Получен проверяемый результат: Подключить обычного Linux клиента к установленному артефакту. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/installed/linux/`
  - V155A · ⏸ Отложено владельцем · (Выбрать точный macOS артефакт и root установки) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V153, V140, V138, V139 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Выбрать точный macOS артефакт и root установки. Частный результат исходного V155: Target preflight, config/manifest, штатный launcher; без чужих profiles. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V153, V140, V138, V139.
      Приёмка: Получен проверяемый результат: Выбрать точный macOS артефакт и root установки. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/cutover/macos/`
  - V154B · ⏸ Отложено владельцем · (Пройти сообщение и чтение результата через native adapter) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V154A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Пройти сообщение и чтение результата через native adapter. Частный результат исходного V154: Primary MCP consumer create/deliver/recent/export/context на тестовых сессиях, reload. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V154A.
      Приёмка: Получен проверяемый результат: Пройти сообщение и чтение результата через native adapter. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/installed/linux/`
  - V155B · ⏸ Отложено владельцем · (Установить manifest и launcher с сохранением данных) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V155A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Установить manifest и launcher с сохранением данных. Частный результат исходного V155: Target preflight, config/manifest, штатный launcher; без чужих profiles. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V155A.
      Приёмка: Получен проверяемый результат: Установить manifest и launcher с сохранением данных. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/cutover/macos/`
  - V154 · ⏸ Отложено владельцем · (Подтвердить digest, версию и отсутствие старого runtime) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V154B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить digest, версию и отсутствие старого runtime. Частный результат исходного V154: Primary MCP consumer create/deliver/recent/export/context на тестовых сессиях, reload. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V154B.
      Приёмка: Runtime→receipt→native readback доказаны; приложение работает после штатного restart. Это точка объединения всей цепочки V154A, V154B, V154.
      Затрагиваемые файлы: `acceptance/installed/linux/`
  - V155 · ⏸ Отложено владельцем · (Подтвердить фактически работающий новый процесс) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V155B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить фактически работающий новый процесс. Частный результат исходного V155: Target preflight, config/manifest, штатный launcher; без чужих profiles. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V155B.
      Приёмка: Artifact digest и version совпали, offline path установлен; rollback доступен. Это точка объединения всей цепочки V155A, V155B, V155.
      Затрагиваемые файлы: `release/cutover/macos/`
  - V156A · ⏸ Отложено владельцем · (Подключить обычного macOS клиента к установленному серверу) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V155 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подключить обычного macOS клиента к установленному серверу. Частный результат исходного V156: Create/read/deliver/stop и restart конкретного native instance. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V155.
      Приёмка: Получен проверяемый результат: Подключить обычного macOS клиента к установленному серверу. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/installed/macos/`
  - V156B · ⏸ Отложено владельцем · (Пройти сообщение и чтение результата через native adapter) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V156A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Пройти сообщение и чтение результата через native adapter. Частный результат исходного V156: Create/read/deliver/stop и restart конкретного native instance. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V156A.
      Приёмка: Получен проверяемый результат: Пройти сообщение и чтение результата через native adapter. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/installed/macos/`
  - V156 · ⏸ Отложено владельцем · (Подтвердить сохранение результата после перезапуска клиента) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V156B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Подтвердить сохранение результата после перезапуска клиента. Частный результат исходного V156: Create/read/deliver/stop и restart конкретного native instance. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V156B.
      Приёмка: Installed consumer readback, permissions и native filesystem semantics доказаны. Это точка объединения всей цепочки V156A, V156B, V156.
      Затрагиваемые файлы: `acceptance/installed/macos/`
  - V157A · ⏸ Отложено владельцем · (Дать независимому агенту сценарий общения двух harness) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V154, V156, V102 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Дать независимому агенту сценарий общения двух harness. Частный результат исходного V157: Свежий tester без кода/авторского отчёта: discover→create→deliver→read→stop и compaction reply. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V154, V156, V102.
      Приёмка: Получен проверяемый результат: Дать независимому агенту сценарий общения двух harness. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/independent/communication/`
  - V158A · ⏸ Отложено владельцем · (Дать независимому агенту offline инструкцию без исходников) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V154, V156, V128 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Дать независимому агенту offline инструкцию без исходников. Частный результат исходного V158: Свежий tester по локальному Skill при выключенном test MCP; checkout conflict и release receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V154, V156, V128.
      Приёмка: Получен проверяемый результат: Дать независимому агенту offline инструкцию без исходников. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/independent/recovery/`
  - V157B · ⏸ Отложено владельцем · (Восстановить creator и sender после очистки context) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V157A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Восстановить creator и sender после очистки context. Частный результат исходного V157: Свежий tester без кода/авторского отчёта: discover→create→deliver→read→stop и compaction reply. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V157A.
      Приёмка: Получен проверяемый результат: Восстановить creator и sender после очистки context. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/independent/communication/`
  - V158B · ⏸ Отложено владельцем · (Занять свободный ресурс при выключенном тестовом MCP) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V158A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Занять свободный ресурс при выключенном тестовом MCP. Частный результат исходного V158: Свежий tester по локальному Skill при выключенном test MCP; checkout conflict и release receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V158A.
      Приёмка: Получен проверяемый результат: Занять свободный ресурс при выключенном тестовом MCP. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `acceptance/independent/recovery/`
  - V157 · ⏸ Отложено владельцем · (Принять один адресованный ответ по native доказательству) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V157B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Принять один адресованный ответ по native доказательству. Частный результат исходного V157: Свежий tester без кода/авторского отчёта: discover→create→deliver→read→stop и compaction reply. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V157B.
      Приёмка: Правильный sender/creator и отсутствие duplicate; тестовый circuit, никаких звонков людям. Это точка объединения всей цепочки V157A, V157B, V157.
      Затрагиваемые файлы: `acceptance/independent/communication/`
  - V158 · ⏸ Отложено владельцем · (Принять восстановление owner после возврата MCP без вопроса человеку) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V158B · стоимость — вне сметы · отложено владельцем
      Описание задачи: Принять восстановление owner после возврата MCP без вопроса человеку. Частный результат исходного V158: Свежий tester по локальному Skill при выключенном test MCP; checkout conflict и release receipt. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V158B.
      Приёмка: Успешный claim без назначения человеком; UNKNOWN не повторён; wrong root не свободен. Это точка объединения всей цепочки V158A, V158B, V158.
      Затрагиваемые файлы: `acceptance/independent/recovery/`
  - V159A · ⏸ Отложено владельцем · (Сверить включение своих изменений в опубликованный main) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V157, V158, R005, R006 · стоимость — вне сметы · отложено владельцем
      Описание задачи: Сверить включение своих изменений в опубликованный main. Частный результат исходного V159: Только owned commits; опубликованный main, artifacts и acceptance manifest; чистка только своих принятых временных сред. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V157, V158, R005, R006.
      Приёмка: Получен проверяемый результат: Сверить включение своих изменений в опубликованный main. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/handoff/`
  - V159B · ⏸ Отложено владельцем · (Передать runbook с версиями и точными установленными результатами) · оценка 10 мин–15 мин · усилие не измерено · вне остатка · зависит: V159A · стоимость — вне сметы · отложено владельцем
      Описание задачи: Передать runbook с версиями и точными установленными результатами. Частный результат исходного V159: Только owned commits; опубликованный main, artifacts и acceptance manifest; чистка только своих принятых временных сред. Выполнить только названную часть; следующая часть получает её код/данные. Входы: V159A.
      Приёмка: Получен проверяемый результат: Передать runbook с версиями и точными установленными результатами. Указать изменённый символ/данные и наблюдаемый вывод; будущие шаги не считать выполненными.
      Затрагиваемые файлы: `release/handoff/`