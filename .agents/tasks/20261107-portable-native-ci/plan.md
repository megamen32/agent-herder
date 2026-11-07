Граф задач: Переносимый CI реальных приложений
Ревизия плана: 170b06fd4bb4
Это снимок плана, а не панель управления: фактическое состояние работы приходит из API владельцев, а не из пересказа агента в графе.
Цель: До 08.11.2026 00:38 МСК довести CI и прежние адаптеры Herder V1: ChatGPT/Z.ai первыми, затем OpenCode, Codex, ZCode. Ядро и тонкое подключение у продуктовой стороны; без новых адаптеров/test-only API.
Бизнес-результат: Одна команда CI, конфигурация вместо привязки к машине, реальные CLI с лжемоделью и browser lanes; неполное обновление не принимается.
Как проверим: Одна команда на двух настроенных runners без правок scenario source. Реальные приложения и обычный MCP consumer. Положительный путь и внесённый сбой проверяют CI; обязательный missing/unsupported/UNKNOWN не даёт release PASS. Installed использует тот же consumer с точной runtime identity.
Декомпозиция: 12 листьев · 3 параллельно · 5 волн · слотов: 3
Прогресс (по листьям графа): 4/12 готово (33.3%) · в работе 0 · заблокировано 7 · ждёт листа 1 · ждёт исполнителя 0 · осталось 8
Кандидаты по зависимостям и вместимости: нет
Подтверждённый допуск к запуску: нет
Смета плана: $1.45 (provisional) за 12 из 12 листьев
frontier $1.45 (provisional) — 100.0% всех долларов плана
остатку к запуску $1.06 (provisional)
бюджет не задан
снимок b3044531c367 от 2026-11-07T18:27:29Z · возраст 3 ч 15 мин · скорость токенов: frontier provisional
Листьев в графе: 12 · слотов: 3 · волн: 5
Параллельность: сейчас 0 из 3 слотов, пик по плану 3
Исполнители: занято 0 из 3 слотов · ждёт листа: 1 (MOVE) · ждёт исполнителя: 0 · готово к запуску: 0
Прогноз: известная активная часть 1 ч (от 1 ч), финиш неизвестен из-за внешнего ожидания. отсчёт от последнего события 2026-11-08T00:42+03:00 · простой 0 мин · неточно: срок внешнего ожидания не подтверждён
Критический путь: Задать runner через config/manifest, проверить capabilities → Выпустить единый отчёт и отказ неполного gate → Подключить опубликованный OpenCode AHAP consumer → Доказать перенос на второй runner конфигурацией → Выпустить post-install gate через тот же consumer
Блокеры:
  - Почему ждём: Page8 bootstrap:22 CDN script requests ERR_HTTP2_PING_FAILED including manifest; auth_timeout, no verified blankscope
    Кто делает: Astra
    Следующий шаг: No fake running while candidate is built. Resume on candidate receipt; install updated hook through normal browser lifecycle; do not clear backoff or replay accepted sends.
    Нужен ли человек: Пока неизвестно. Действие человека не уточнено.
  - Почему ждём: Z.ai GLM-5.3 at capacity after native click; prompt UNKNOWN, no retry
    Кто делает: Astra
    Следующий шаг: Exact resource collision sent once to productowner inputci-browser-target-disappeared-2307; don't create new tabs until resolved. ChatGPTpage10 also disappeared.
    Нужен ли человек: Пока неизвестно. Действие человека не уточнено.
  - Почему ждём: Original create UNKNOWN; missing historical error stage, retry forbidden
    Кто делает: Terra
    Следующий шаг: Native exactcandidate d66c9c0729fe / manifest2db3cc41; explicit solelaneoperator, deterministic model isolated, publicMCP; nolegacycurrent/install, UNKNOWNnoreplay.
    Нужен ли человек: Пока неизвестно. Действие человека не уточнено.
  - Почему ждём: Original native effect confirmed, retained authority unavailable; no replay
    Кто делает: roomhacker
    Следующий шаг: Completion-reader TDD исправлен: завершённый assistant после exact marker user, exact Task receipt ID; trailing idle игнорируется. 26 offline tests PASS. Native attempt2 — UNKNOWN_POST_EFFECT: лог подтверждает user msg_1b7c25a85001XUIBWu63iP3rG8 и completed assistant msg_1b7c25abb001b7qtOtsBN6TFDD (finish=stop), затем idle. Read-only reconciliation не нашёл исходный Task/request/input marker или disposable DB/profile: launcher удалил scratch без --retain-on-failure. Initial send не повторять; second send не разрешён без recovered first receipt. Дальнейшая native приёмка заблокирована удалённым scratch и запретом owner на fresh mutation. Scoped publish завершён в origin/main: commit 7cc88e486ce4689117306a50293af7e2ebb5e341, ровно tests/native/ahap_opencode_stand.py SHA256 ac2b4906d9c0fbaeb540484619555562ce0704c7771dc5e7fdc3a9b77fa705a4 и tests/native/test_ahap_opencode_stand.py SHA256 f2362a9b4a5bc5fb519f1c8ef8722af834755fc7177aa138750039f547957328. Receipt .agents/tasks/20261107-portable-native-ci/evidence/opencode-v1-d66c9c0729fe.json SHA256 44405ca4487bb0a85206ec2a634b683c89bf7998ba46027ae97a783595ec52bc; top-level phase=post_effect,status=UNKNOWN_POST_EFFECT, attempt1 сохранён. Offline proof: evidence/opencode-v1-d66c9c0729fe-offline-90d9b886.json SHA256 02f6e238a1b66c9a97ae79ddbb597f7f8345338c8cdfa368c72f1036507d0e3f (26 tests PASS); raw output evidence/opencode-v1-d66c9c0729fe-offline-90d9b886.txt SHA256 9dc1a44d847b8a1a1aeda8ef009a509a72c7086471b5e612c8b7507e217e4ac7. Native launch/send/replay не выполнялись; native acceptance остаётся заблокирована удалённым scratch. Remote checkpoint: origin/main=5ea28f51838fcfc3230006a8709090f08009a47f; опубликованный OpenCode commit 7cc88e486ce4689117306a50293af7e2ebb5e341 — его ancestor, оба owned fixture-файла побайтно совпадают с origin/main.
    Нужен ли человек: Пока неизвестно. Действие человека не уточнено.
  - Почему ждём: Autonomous native producer requires complete authorized lanes; existing fast checks published, runtime gate not wired
    Кто делает: Terra research + Astra integration
    Следующий шаг: Native candidate became ready; Terra reassigned to CODEX by owner priority. Preserve TRIGGER.md result if ready; Astra integrates after live lanes. REPORT76ec55f3 published.
    Нужен ли человек: Пока неизвестно. Действие человека не уточнено.
  - Почему ждём: Original a836 createUNKNOWN no replay; source setup now fixed, native fullcase remains unproven
    Кто делает: Terra
    Следующий шаг: Native exactcandidate d66c9c0729fe / manifest2db3cc41; explicit solelaneoperator, deterministic model isolated, publicMCP; nolegacycurrent/install, UNKNOWNnoreplay.
    Нужен ли человек: Пока неизвестно. Действие человека не уточнено.
  - Почему ждём: Exact5ea full candidate gate exit2: dedicated ChatGPT blankscope unavailable; native lanes incomplete
    Кто делает: Astra
    Следующий шаг: Финальная сложная интеграция и release acceptance лично Lead. Worker результаты принимаются по реальному consumer; новые UNKNOWN sends не повторять.
    Нужен ли человек: Пока неизвестно. Действие человека не уточнено.
Листья плана (12):
  - BUILD · ✅ Готово · (Исправить B83: сборка сохраняет current и активный релиз) · оценка 15 мин · усилие 2 мин по часам · по часам 2 мин · волна 1 · зависит: — · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: RED→GREEN для нового SHA, отсутствующего current и rebuild активного SHA; scoped main publication. Только builder и его regression.
      Приёмка: RED→GREEN для нового SHA, отсутствующего current и rebuild активного SHA; scoped main publication. Только builder и его regression.
      Результат: 23df966f887159327619d224f87d2ffb6b3f4c5a опубликован в main, exact2files. RED: 3 новых regression failures (current switched, empty catalog auto-installed, active SHA moved). GREEN: все5 tests за0.009s; py_compile и diff-check. assemble теперь не меняет current; rebuild активного release отвергается до перемещения; main проверяет snapshot. Проверка реального assemble во временном каталоге, без live mutation. Runtime не перезапускался: это release tooling, не installed/five-adapter PASS.
  - CHATGPT · ⛔ Заблокировано · (Подключить ChatGPT на разрешённом browser runner) · оценка 15 мин · усилие не измерено · волна 1 · зависит: — · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional · блокер: Page8 bootstrap:22 CDN script requests ERR_HTTP2_PING_FAILED including manifest; auth_timeout, no verified blankscope
      Описание задачи: Exact page/account/claim через MacMini transport; только собственные тесты, original receipts; без background fetch, UI/hooks и backoff.
      Приёмка: Exact page/account/claim через MacMini transport; только собственные тесты, original receipts; без background fetch, UI/hooks и backoff.
      Затрагиваемые файлы: `src/adapters/chatgpt-passive-history.ts`, `src/adapters/chatgpt-background-budget.ts`, `tests/chatgpt-passive-backoff-burst.test.ts`, `tests/chatgpt-background-budget.test.ts`
      Результат: Fresh readonly samepage8 2026-11-07T21:40:09Z, listidentity unchanged; DOMcomplete but profileloading/pending-home-input. One explicitauth check timedout10s. Existingnetwork44rows: document200,22 scripts HTTP2_PING_FAILED inclmanifest; auth2ERR_ABORTED records. Console sameerror26times. Underlyingnetworkcause not established; no reproducible Herder sourcebug, no sourcefix/login/profile/infra changes. Nativecreate/send0,newpage0,UNKNOWN untouched. evidence/chatgpt-page8-bootstrap-network-20261108.json. Next networkowner diagnostics then exactpage/account/claim revalidation; gate unchanged.
      Сохранённый статус: blocked
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26; source=mcp_metadata; at=2026-11-08T00:42:05+03:00
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
      Допуск к запуску: нет; записан блокер (external_blocked)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: leaf: Page8 bootstrap:22 CDN script requests ERR_HTTP2_PING_FAILED including manifest; auth_timeout, no verified blankscope
  - CONFIG · ✅ Готово · (Задать runner через config/manifest, проверить capabilities) · оценка 15 мин · усилие 17 мин по часам · по часам 17 мин · волна 1 · зависит: — · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Пути CLI/Node/bootstrap, transport, OS/arch — входы; missing capability до mutation; никаких machine constants в сценарии.
      Приёмка: Пути CLI/Node/bootstrap, transport, OS/arch — входы; missing capability до mutation; никаких machine constants в сценарии.
      Затрагиваемые файлы: `tests/native/runner_config.py`, `tests/native/test_runner_config.py`, `tests/native/runner-config.example.json`
      Результат: Published313d8c64 + V1 compatibility8708597c74deb1778e0d4d61908d249a7905a9e0. 8 focused tests GREEN: explicit hashed native OpenCode outside candidate; node/bootstrap hashes; exact manifest readonly mount. Evidence config-v1-red.txt/config-manifest-red.txt/config-v1-green.txt. Native acceptance separate.
  - INPUTS · ✅ Готово · (Собрать точные опубликованные argv/manifest inputs без native sends) · оценка 10 мин · усилие 8 мин по часам · по часам 8 мин · волна 1 · зависит: — · стоимость $0.0022 · модель 302ai/gpt-6-luna · класс frontier · токенов 12 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Рутинный read-only сбор существующих binary/stand/bootstrap paths и hashes; отдаёт config inputs Terra/Lead. Никаких probes с model calls, адаптерных правок или browser операций.
      Приёмка: Файл evidence/runner-inputs.json с verified paths/hash/runtimeversion provenance; unknown отдельно, source/config без secrets.
      Результат: runner-inputs.json SHA256 76e1f34d63b129f60fca094fdf7e0ed7b84ec4e6b0b24b4c745da1cb6f3d4d92: 3 artifact hashes match; Python3.10.12 Node22.22.2; no native send. ZCode remote references historical.
  - ZAI · ⛔ Заблокировано · (Выпустить Z.ai browser lane) · оценка 15 мин · усилие не измерено · волна 1 · зависит: — · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional · блокер: Z.ai GLM-5.3 at capacity after native click; prompt UNKNOWN, no retry
      Описание задачи: Выделенный scope, обычный Herder consumer; challenge/cooldown — точная причина; без повторов UNKNOWN. Публикация browser этапа.
      Приёмка: Выделенный scope, обычный Herder consumer; challenge/cooldown — точная причина; без повторов UNKNOWN. Публикация browser этапа.
      Результат: a836 preflight14tools PASS. One create confirms session51ff45f3cbdf769f0a147c520bb5cb5c; prompt UNKNOWN/retry forbidden. UI page7 native /c/c2c581df-d3a7-4a3b-8f57-4b8edff81fd3 shows model capacity and retained exact draft. Full retained root ci-zai-native-a836-0010. Evidence zai-a836-{receipt,reconcile-read,native-blocker}.json. No second send/model switch/replay.
      Сохранённый статус: blocked
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26; source=mcp_metadata; at=2026-11-08T00:12:17+03:00
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
      Допуск к запуску: нет; записан блокер (external_blocked)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: leaf: Z.ai GLM-5.3 at capacity after native click; prompt UNKNOWN, no retry
  - REPORT · ✅ Готово · (Выпустить единый отчёт и отказ неполного gate) · оценка 15 мин · усилие 18 мин по часам · по часам 18 мин · волна 2 · зависит: CONFIG · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: PASS/FAIL/BLOCKED/UNSUPPORTED/UNKNOWN по каждой обязательной функции, source/runtime identity; stale receipt и candidate-as-installed отвергаются. Публикация S1.
      Приёмка: PASS/FAIL/BLOCKED/UNSUPPORTED/UNKNOWN по каждой обязательной функции, source/runtime identity; stale receipt и candidate-as-installed отвергаются. Публикация S1.
      Затрагиваемые файлы: `tests/native/candidate_release_gate.py`, `tests/native/test_candidate_release_gate.py`
      Результат: Published76ec55f305b01309d273cb55d3b234b0714f3694. 12focused tests. Existing candidate_release_gate --validate-v1 report expectedidentity enforces5harnesses×7checks+5negativechecks and exact run/source/artifact/stage. This validates reports, not native evidence by itself.
  - CODEX · ⛔ Заблокировано · (Подключить реальный Codex и локальный model fixture) · оценка 15 мин · усилие не измерено · волна 3 · зависит: CONFIG, REPORT · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional · блокер: Original create UNKNOWN; missing historical error stage, retry forbidden
      Описание задачи: Реальный app-server через обычный core consumer; точный native instance/provider. Нет supported launch — отдельный product blocker без повторного create/UNKNOWN.
      Приёмка: Реальный app-server через обычный core consumer; точный native instance/provider. Нет supported launch — отдельный product blocker без повторного create/UNKNOWN.
      Результат: Terra readonly complete: logs0/threads0/no sessions; stderr discarded. quota guard hypothesis (herder-test not exempt, unknown quota denies) not proven historicalcause. Schema20checks valid from coreowner. Original task68ebef496b1d5ca9265c1a8c605ac631 preserved; no resend. Probe19dcfc9c; evidence codex-v1-result.md.
      Сохранённый статус: blocked
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26; source=mcp_metadata; at=2026-11-08T00:12:53+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b77b-aed7-79c1-956a-5678680c0d56
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; записан блокер (external_blocked)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: leaf: Original create UNKNOWN; missing historical error stage, retry forbidden
  - OPENCODE · ⛔ Заблокировано · (Подключить опубликованный OpenCode AHAP consumer) · оценка 15 мин · усилие не измерено · волна 2 · зависит: CONFIG, REPORT · стоимость $0.0032 · модель 302ai/gpt-6-luna · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional · блокер: Original native effect confirmed, retained authority unavailable; no replay
      Описание задачи: Reuse Luna stand без конкурирующей правки. Initial send/read/reopen и отдельный deliver различаются; export/search/projects через public MCP либо явный неподдержанный результат.
      Приёмка: Reuse Luna stand без конкурирующей правки. Initial send/read/reopen и отдельный deliver различаются; export/search/projects через public MCP либо явный неподдержанный результат.
      Результат: d66 attempt2 UNKNOWN_POST_EFFECT: user msg_1b7c25a85001XUIBWu63iP3rG8 + completed assistant msg_1b7c25abb001b7qtOtsBN6TFDD; trailing idle caused false completion failure. Luna fixes matcher 02ff1510. Original scratch deleted without retain-on-failure; no exact session/requestkey for reconciliation. No new create or second send. Evidence opencode-v1-d66c9c0729fe.json.
      Сохранённый статус: blocked
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1b5e5-b6de-74c3-8276-45803194a16f; source=mcp_metadata; at=2026-11-08T00:23:45+03:00
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
      Причина ожидания / доставки: leaf: Original native effect confirmed, retained authority unavailable; no replay
  - TRIGGER · ⛔ Заблокировано · (Подключить existing CI и update/release triggers) · оценка 15 мин · усилие не измерено · волна 2 · зависит: REPORT · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional · блокер: Autonomous native producer requires complete authorized lanes; existing fast checks published, runtime gate not wired
      Описание задачи: PR fast tests; native compatibility на candidate и изменении native versions; required unavailable не даёт принять update. Никакого нового scheduler.
      Приёмка: PR fast tests; native compatibility на candidate и изменении native versions; required unavailable не даёт принять update. Никакого нового scheduler.
      Результат: 4464390a existing fleet-session.yml Linux/macOS CONFIG/REPORT unit checks published. TRIGGER.md exact existing gate invocation and patchpoints; manual exact candidate aggregate now produced, gate exit2. Full automatic five-native producer/install trigger NOT complete; do not replace legacy gate or claim nightly native PASS.
      Сохранённый статус: blocked
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26; source=mcp_metadata; at=2026-11-08T00:16:08+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b77b-aed7-79c1-956a-5678680c0d56
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; записан блокер (external_blocked)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: leaf: Autonomous native producer requires complete authorized lanes; existing fast checks published, runtime gate not wired
  - ZCODE · ⛔ Заблокировано · (Выпустить ZCode lane без зависимости от server44) · оценка 15 мин · усилие не измерено · волна 3 · зависит: CONFIG, REPORT · стоимость $0.03 · модель aimlapi/openai/gpt-6.1-terra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional · блокер: Original a836 createUNKNOWN no replay; source setup now fixed, native fullcase remains unproven
      Описание задачи: Точный реальный server package/runner берётся из manifest; нет hardcoded SSH/IP/live dependency store. Публикация CLI этапа, limits явны.
      Приёмка: Точный реальный server package/runner берётся из manifest; нет hardcoded SSH/IP/live dependency store. Публикация CLI этапа, limits явны.
      Результат: Published6150354810e80bb35cec4ab40addbb48591088ea, exact2files,7GREEN. OfficialWS14tools and registeredproject exactroot confirmed on isolatedsupervisor,0modelcalls. Original a836 createUNKNOWN taskefccb595dadfbc9e413b39fdb1cb26d7 retained, no replay. Full lane/installed NOTPASS.
      Сохранённый статус: blocked
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26; source=mcp_metadata; at=2026-11-08T00:23:31+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=01a1b7a8-f171-7d73-bb09-ad2081d226a3
      Плановая модель: gpt-6.1-terra
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; записан блокер (external_blocked)
      Незавершённые зависимости: нет
      Причина ожидания / доставки: leaf: Original a836 createUNKNOWN no replay; source setup now fixed, native fullcase remains unproven
  - MOVE · ⋯ В очереди · (Доказать перенос на второй runner конфигурацией) · оценка 15 мин · усилие не измерено · ждёт: причина не названа · волна 4 · зависит: OPENCODE, CONFIG · стоимость $0.0032 · модель 302ai/gpt-6-luna · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional
      Описание задачи: Тот же опубликованный scenario SHA на двух runners; отличаются только manifest/config. Обе runtime версии и OS/arch записаны; неподдержанная ОС не объявлена проверенной.
      Приёмка: Тот же опубликованный scenario SHA на двух runners; отличаются только manifest/config. Обе runtime версии и OS/arch записаны; неподдержанная ОС не объявлена проверенной.
      Сохранённый статус: queued
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26; source=mcp_metadata; at=2026-11-07T21:38:57+03:00
      Lead (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Native parent (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Исполнитель (заявлен): host_id=неизвестно · harness=неизвестно · session_id=неизвестно
      Прежняя привязка leaf.session: host_id=неизвестно · harness=codex · session_id=неизвестно
      Плановая модель: gpt-6-luna
      Наблюдаемая модель: неизвестно
      Наблюдаемый runtime: неизвестно; source=неизвестно; at=неизвестно
      Turn назначения: неизвестно; request=неизвестно; delivery=неизвестно
      Наблюдаемый turn: неизвестно; worktree=неизвестно
      Пробуждение Lead: неизвестно; wait=неизвестно; captured_turn=неизвестно; next=неизвестно
      Допуск к запуску: нет; ждёт зависимостей (dependencies_unmet)
      Незавершённые зависимости: OPENCODE
      Причина ожидания / доставки: не записана
  - INSTALLED · ⛔ Заблокировано · (Выпустить post-install gate через тот же consumer) · оценка 15 мин · усилие не измерено · волна 4 · зависит: TRIGGER, MOVE, OPENCODE, CODEX, ZCODE, CHATGPT, ZAI, BUILD · стоимость $0.32 · модель 302ai/gpt-6-astra · класс frontier · токенов 18 000 · цена provisional · скорость 1 200 ток/мин provisional · блокер: Exact5ea full candidate gate exit2: dedicated ChatGPT blankscope unavailable; native lanes incomplete
      Описание задачи: Точный установленный artifact+consumer, позитивный CI и failure injection; full product PASS только все обязательные функции. Публикация отчёта, cleanup своих ресурсов, external gaps сохранены.
      Приёмка: Точный установленный artifact+consumer, позитивный CI и failure injection; full product PASS только все обязательные функции. Публикация отчёта, cleanup своих ресурсов, external gaps сохранены.
      Результат: Latest evidence/candidate-5ea-{report.json,expected.json,gate.txt}; NEG5PASS exact5ea with independent originalrunid+hashprovenance. ChatGPT startup14tools realPASS separated from fulljourney. No V1 runtimeinstallation, legacycurrent untouched. Sourcefixtures allpublished.
      Сохранённый статус: blocked
      Назначение: неизвестно; тип=неизвестно; attempt=неизвестно
      Автор последнего события: host_id=неизвестно · harness=codex · session_id=01a1ac52-d25c-7050-a65d-3fca32642c26; source=mcp_metadata; at=2026-11-08T00:32:40+03:00
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
      Допуск к запуску: нет; записан блокер (external_blocked)
      Незавершённые зависимости: TRIGGER, MOVE, OPENCODE, CODEX, ZCODE, CHATGPT, ZAI
      Причина ожидания / доставки: leaf: Exact5ea full candidate gate exit2: dedicated ChatGPT blankscope unavailable; native lanes incomplete