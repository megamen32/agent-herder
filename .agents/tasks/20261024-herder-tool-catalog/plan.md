Граф задач: Сокращение каталога MCP Agent Herder
Ревизия плана: 00e0a8e7cf57
Это снимок плана, а не панель управления: фактическое состояние работы приходит из API владельцев, а не из пересказа агента в графе.
Цель: Уменьшить advertisement 87→85→79→76, сохранив exact endpoints, авторизацию и lifecycle; optional агентский профиль 42.
Бизнес-результат: Подключённый агент получает меньший доказуемо работающий каталог без потери правовых границ, очередей и совместимости.
Прогресс (по листьям графа): 1/7 готово (14.3%) · в работе 1 · заблокировано 0 · осталось 6
Листьев в графе: 7 · слотов: 1 · волн: 7
Параллельность: сейчас 1 из 1 слотов, пик по плану неизвестен
Прогноз: известная активная часть 0 мин (от 0 мин), финиш неизвестен: 6 листьев без оценки. остаток стартует сейчас · неточно: Листьев без оценки — 6
Критический путь: неизвестен — оценки длительности не заданы
Листья плана (7):
  - L01 · ✅ Готово · (Зафиксировать live baseline и матрицу контрактов) · оценка Срок неизвестен · усилие не измерено · волна 1 · зависит: —
      Описание задачи: Зафиксировать исходный live каталог 87 tools и отделить advertisement, callability и authorization.
      Приёмка: Текущий readback подтверждает 87 tools; исходные имена сохранены в task.md. Полный снимок схем, размер в байтах, версия runtime и матрица прав остаются обязательными входами перед реализацией.
      Затрагиваемые файлы: `.agents/tasks/20261024-herder-tool-catalog/task.md`
  - L02 · 🔄 В работе · (Доставить первый scoped slice 87 → 85) · оценка Срок неизвестен · усилие не измерено · волна 2 · зависит: L01
      Описание задачи: Скрыть session_search_local и list_active_sessions_local только из агентского tools/list; сохранить exact endpoints, dispatch и существующую авторизацию.
      Приёмка: Реальный подключённый агентский MCP показывает ровно 85 tools; разрешённый legacy/peer вызов работает, запрещённый прямой вызов отклоняется; source tests, установленная ревизия и consumer readback представлены отдельно.
      Затрагиваемые файлы: `src/mcp/catalog-policy.ts`, `src/index.ts`, `tests/mcp-catalog-policy.test.ts`, `tests/mcp-catalog-contract.test.ts`, `docs/mcp-catalog-migration.md`, `src/mcp/catalog-projection.ts`
  - L03 · ⋯ В очереди · (Сократить advertisement 85 → 79 через sync aliases) · оценка Срок неизвестен · усилие не измерено · волна 3 · зависит: L02
      Описание задачи: Скрыть шесть sync aliases: browser_wake, export_transcript, cdp_export_chat, cdp_export_visible_chats, cdp_reconcile_known_routes, cdp_reconcile_visible_chats. Показывать их async пары без изменения sync/async семантики.
      Приёмка: Подключённый MCP показывает 79 tools; sync endpoints сохраняют прежний результат и права, async возвращает job receipt, reconnect/readback не повторяет принятую операцию.
      Затрагиваемые файлы: `src/mcp/catalog-policy.ts`, `tests/mcp-catalog-policy.test.ts`, `tests/mcp-catalog-contract.test.ts`, `docs/mcp-catalog-migration.md`
  - L04 · ⋯ В очереди · (Объединить однородные чтения 79 → 76) · оценка Срок неизвестен · усилие не измерено · волна 4 · зависит: L03
      Описание задачи: Ввести job_read и coordination_note_read с view one/list; common_settings_read получает view settings/status с прежним поведением для {}. Старые endpoints сохраняются aliases.
      Приёмка: Каталог содержит 76 tools при доказанной эквивалентности прав всех трёх объединений; get-only субъект не получает list-доступ, неверные ветви отклоняются до handler. Если эквивалентность не доказана, merge исключается и итог увеличивается на один.
      Затрагиваемые файлы: `src/mcp/control-plane-tools.ts`, `src/common-settings/tools.ts`, `tests/mcp-read-tools.test.ts`, `src/mcp/catalog-policy.ts`, `tests/mcp-catalog-policy.test.ts`, `tests/mcp-catalog-contract.test.ts`, `docs/mcp-catalog-migration.md`
  - L05 · ⋯ В очереди · (Проверить профили 76 и optional 42-agent-profile) · оценка Срок неизвестен · усилие не измерено · волна 5 · зависит: L04
      Описание задачи: Реализовать полный профиль 76, legacy и peer; optional обычный профиль 42 с 34 дополнительными инструментами в явных тематических наборах через конфигурацию подключения.
      Приёмка: Полный профиль показывает 76, legacy сохраняет исходные 87 имён, peer сохраняет внутренние exact endpoints. При включении optional профиля он показывает ровно 42; reconnect/обновление каталога подтверждены клиентом, скрытие не меняет authorization.
      Затрагиваемые файлы: `src/mcp/catalog-policy.ts`, `src/mcp/catalog-projection.ts`, `tests/mcp-catalog-policy.test.ts`, `tests/mcp-catalog-contract.test.ts`, `docs/mcp-catalog-migration.md`
  - L06 · ⋯ В очереди · (Уточнить descriptions и мигрировать потребителей) · оценка Срок неизвестен · усилие не измерено · волна 6 · зависит: L05
      Описание задачи: Уточнить active inventory versus history search, steer versus queue, create/resume guards, sync result versus async receipt, workspace и human resolve. Exact endpoint names сохраняются, кроме двух новых read names.
      Приёмка: Descriptions и migration guide отражают реальные контракты; существующие callers проверены, aliases сохраняются до инвентаризации и согласованного периода без legacy вызовов. HumanStop, queued delivery и active-session lifecycle проходят регрессионную проверку.
      Затрагиваемые файлы: `src/mcp/control-plane-tools.ts`, `src/common-settings/tools.ts`, `docs/mcp-catalog-migration.md`, `src/mcp/session-tools.ts`
  - L07 · ⋯ В очереди · (Выполнить контролируемый релиз и consumer acceptance) · оценка Срок неизвестен · усилие не измерено · волна 7 · зависит: L06
      Описание задачи: Один назначенный release executor устанавливает проверенную ревизию; новый каталог проверяется на реальном подключённом MCP с отдельными метриками и обратимым выбором legacy профиля.
      Приёмка: Есть runtime revision и полный tools/list с пагинацией; доказаны 87→85→79→76, optional 42, размеры схем и отдельный callable count; тестовая сессия подтверждает steer/queue, async reconnect, legacy sync и отрицательную авторизацию без повторов UNKNOWN/accepted.