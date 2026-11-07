Граф задач: Переносимый CI реальных приложений
Ревизия плана: cf9943104bad
Это снимок плана, а не панель управления: фактическое состояние работы приходит из API владельцев, а не из пересказа агента в графе.
Цель: После обновления Herder/внешнего harness проверять send, read, full transcript, search, projects через штатный consumer. Замена runner не требует изменения сценариев.
Бизнес-результат: Одна команда CI, конфигурация вместо привязки к машине, реальные CLI с лжемоделью и browser lanes; неполное обновление не принимается.
Как проверим: Одна команда на двух настроенных runners без правок scenario source. Реальные приложения и обычный MCP consumer. Положительный путь и внесённый сбой проверяют CI; обязательный missing/unsupported/UNKNOWN не даёт release PASS. Installed использует тот же consumer с точной runtime identity.
Декомпозиция: 11 листьев · 1 параллельно · 5 волн · слотов: 1
Прогресс (по листьям графа): 1/11 готово (9.1%) · в работе 0 · заблокировано 0 · ждёт листа 9 · ждёт исполнителя 0 · осталось 10
Кандидаты по зависимостям и вместимости: CONFIG
Подтверждённый допуск к запуску: нет
Смета плана: $3.52 (provisional) за 11 из 11 листьев
frontier $3.52 (provisional) — 100.0% всех долларов плана
остатку к запуску $3.20 (provisional)
бюджет не задан
снимок b3044531c367 от 2026-11-07T18:27:29Z · возраст 5 мин · скорость токенов: frontier provisional
Листьев в графе: 11 · слотов: 1 · волн: 5
Параллельность: сейчас 0 из 1 слотов, пик по плану 1
Исполнители: занято 0 из 1 слотов · ждёт листа: 9 (REPORT, CHATGPT, CODEX, OPENCODE, …) · ждёт исполнителя: 0 · готово к запуску: 1 (CONFIG)
Прогноз: осталось 2 ч 30 мин (от 2 ч 30 мин), финиш 2026-11-08T00:03:18+03:00. отсчёт от последнего события 2026-11-07T21:33+03:00 · простой 0 мин · неточно: срок внешнего ожидания не подтверждён
Критический путь: Задать runner через config/manifest, проверить capabilities → Выпустить единый отчёт и отказ неполного gate → Подключить опубликованный OpenCode AHAP consumer → Доказать перенос на второй runner конфигурацией → Выпустить post-install gate через тот же consumer
Листья плана (11):
  - BUILD · ✅ Готово · (Исправить B83: сборка сохраняет current и активный релиз) · оценка 15 мин · усилие 2 мин по часам · по часам 2 мин · волна 1 · зависит: — · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: RED→GREEN для нового SHA, отсутствующего current и rebuild активного SHA; scoped main publication. Только builder и его regression.
      Приёмка: RED→GREEN для нового SHA, отсутствующего current и rebuild активного SHA; scoped main publication. Только builder и его regression.
      Результат: 23df966f887159327619d224f87d2ffb6b3f4c5a опубликован в main, exact2files. RED: 3 новых regression failures (current switched, empty catalog auto-installed, active SHA moved). GREEN: все5 tests за0.009s; py_compile и diff-check. assemble теперь не меняет current; rebuild активного release отвергается до перемещения; main проверяет snapshot. Проверка реального assemble во временном каталоге, без live mutation. Runtime не перезапускался: это release tooling, не installed/five-adapter PASS.
  - CONFIG · ⋯ В очереди · (Задать runner через config/manifest, проверить capabilities) · оценка 15 мин · усилие не измерено · ждёт: причина не названа · волна 1 · зависит: — · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Пути CLI/Node/bootstrap, transport, OS/arch — входы; missing capability до mutation; никаких machine constants в сценарии.
      Приёмка: Пути CLI/Node/bootstrap, transport, OS/arch — входы; missing capability до mutation; никаких machine constants в сценарии.
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26; source=mcp_metadata; at=2026-11-07T21:29:27+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26
      Плановая модель: gpt-6-astra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: неизвестно; назначение не подтверждено (assignment_unknown)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: не записана
  - REPORT · ⋯ В очереди · (Выпустить единый отчёт и отказ неполного gate) · оценка 15 мин · усилие не измерено · ждёт: причина не названа · волна 2 · зависит: CONFIG · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: PASS/FAIL/BLOCKED/UNSUPPORTED/UNKNOWN по каждой обязательной функции, source/runtime identity; stale receipt и candidate-as-installed отвергаются. Публикация S1.
      Приёмка: PASS/FAIL/BLOCKED/UNSUPPORTED/UNKNOWN по каждой обязательной функции, source/runtime identity; stale receipt и candidate-as-installed отвергаются. Публикация S1.
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26; source=mcp_metadata; at=2026-11-07T21:29:28+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26
      Плановая модель: gpt-6-astra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; ждёт зависимостей (dependencies_unmet)
      Незавершённые зависимости: CONFIG
      Причина ожидания / доставки: не записана
  - CHATGPT · ⋯ В очереди · (Подключить ChatGPT на разрешённом browser runner) · оценка 15 мин · усилие не измерено · ждёт: причина не названа · волна 3 · зависит: CONFIG, REPORT · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Exact page/account/claim через MacMini transport; только собственные тесты, original receipts; без background fetch, UI/hooks и backoff.
      Приёмка: Exact page/account/claim через MacMini transport; только собственные тесты, original receipts; без background fetch, UI/hooks и backoff.
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26; source=native_environment; at=2026-11-07T21:30:07+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26
      Плановая модель: gpt-6-astra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; ждёт зависимостей (dependencies_unmet)
      Незавершённые зависимости: CONFIG, REPORT
      Причина ожидания / доставки: не записана
  - CODEX · ⋯ В очереди · (Подключить реальный Codex и локальный model fixture) · оценка 15 мин · усилие не измерено · ждёт: причина не названа · волна 3 · зависит: CONFIG, REPORT · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Реальный app-server через обычный core consumer; точный native instance/provider. Нет supported launch — отдельный product blocker без повторного create/UNKNOWN.
      Приёмка: Реальный app-server через обычный core consumer; точный native instance/provider. Нет supported launch — отдельный product blocker без повторного create/UNKNOWN.
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26; source=native_environment; at=2026-11-07T21:30:07+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26
      Плановая модель: gpt-6-astra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; ждёт зависимостей (dependencies_unmet)
      Незавершённые зависимости: CONFIG, REPORT
      Причина ожидания / доставки: не записана
  - OPENCODE · ⋯ В очереди · (Подключить опубликованный OpenCode AHAP consumer) · оценка 15 мин · усилие не измерено · ждёт: причина не названа · волна 3 · зависит: CONFIG, REPORT · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Reuse Luna stand без конкурирующей правки. Initial send/read/reopen и отдельный deliver различаются; export/search/projects через public MCP либо явный неподдержанный результат.
      Приёмка: Reuse Luna stand без конкурирующей правки. Initial send/read/reopen и отдельный deliver различаются; export/search/projects через public MCP либо явный неподдержанный результат.
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26; source=mcp_metadata; at=2026-11-07T21:29:29+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26
      Плановая модель: gpt-6-astra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; ждёт зависимостей (dependencies_unmet)
      Незавершённые зависимости: CONFIG, REPORT
      Причина ожидания / доставки: не записана
  - TRIGGER · ⋯ В очереди · (Подключить existing CI и update/release triggers) · оценка 15 мин · усилие не измерено · ждёт: причина не названа · волна 3 · зависит: REPORT · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: PR fast tests; native compatibility на candidate и изменении native versions; required unavailable не даёт принять update. Никакого нового scheduler.
      Приёмка: PR fast tests; native compatibility на candidate и изменении native versions; required unavailable не даёт принять update. Никакого нового scheduler.
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26; source=mcp_metadata; at=2026-11-07T21:29:32+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26
      Плановая модель: gpt-6-astra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; ждёт зависимостей (dependencies_unmet)
      Незавершённые зависимости: REPORT
      Причина ожидания / доставки: не записана
  - ZAI · ⋯ В очереди · (Выпустить Z.ai browser lane) · оценка 15 мин · усилие не измерено · ждёт: причина не названа · волна 3 · зависит: CONFIG, REPORT · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Выделенный scope, обычный Herder consumer; challenge/cooldown — точная причина; без повторов UNKNOWN. Публикация browser этапа.
      Приёмка: Выделенный scope, обычный Herder consumer; challenge/cooldown — точная причина; без повторов UNKNOWN. Публикация browser этапа.
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26; source=native_environment; at=2026-11-07T21:30:07+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26
      Плановая модель: gpt-6-astra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; ждёт зависимостей (dependencies_unmet)
      Незавершённые зависимости: CONFIG, REPORT
      Причина ожидания / доставки: не записана
  - ZCODE · ⋯ В очереди · (Выпустить ZCode lane без зависимости от server44) · оценка 15 мин · усилие не измерено · ждёт: причина не названа · волна 3 · зависит: CONFIG, REPORT · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Точный реальный server package/runner берётся из manifest; нет hardcoded SSH/IP/live dependency store. Публикация CLI этапа, limits явны.
      Приёмка: Точный реальный server package/runner берётся из manifest; нет hardcoded SSH/IP/live dependency store. Публикация CLI этапа, limits явны.
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26; source=native_environment; at=2026-11-07T21:30:07+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26
      Плановая модель: gpt-6-astra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; ждёт зависимостей (dependencies_unmet)
      Незавершённые зависимости: CONFIG, REPORT
      Причина ожидания / доставки: не записана
  - MOVE · ⋯ В очереди · (Доказать перенос на второй runner конфигурацией) · оценка 15 мин · усилие не измерено · ждёт: причина не названа · волна 4 · зависит: OPENCODE, CONFIG · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Тот же опубликованный scenario SHA на двух runners; отличаются только manifest/config. Обе runtime версии и OS/arch записаны; неподдержанная ОС не объявлена проверенной.
      Приёмка: Тот же опубликованный scenario SHA на двух runners; отличаются только manifest/config. Обе runtime версии и OS/arch записаны; неподдержанная ОС не объявлена проверенной.
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26; source=mcp_metadata; at=2026-11-07T21:29:33+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26
      Плановая модель: gpt-6-astra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; ждёт зависимостей (dependencies_unmet)
      Незавершённые зависимости: OPENCODE, CONFIG
      Причина ожидания / доставки: не записана
  - INSTALLED · ⋯ В очереди · (Выпустить post-install gate через тот же consumer) · оценка 15 мин · усилие не измерено · ждёт: причина не названа · волна 5 · зависит: TRIGGER, MOVE, OPENCODE, CODEX, ZCODE, CHATGPT, ZAI, BUILD · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Точный установленный artifact+consumer, позитивный CI и failure injection; full product PASS только все обязательные функции. Публикация отчёта, cleanup своих ресурсов, external gaps сохранены.
      Приёмка: Точный установленный artifact+consumer, позитивный CI и failure injection; full product PASS только все обязательные функции. Публикация отчёта, cleanup своих ресурсов, external gaps сохранены.
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26; source=native_environment; at=2026-11-07T21:30:08+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26
      Плановая модель: gpt-6-astra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; ждёт зависимостей (dependencies_unmet)
      Незавершённые зависимости: TRIGGER, MOVE, OPENCODE, CODEX, ZCODE, CHATGPT, ZAI
      Причина ожидания / доставки: не записана