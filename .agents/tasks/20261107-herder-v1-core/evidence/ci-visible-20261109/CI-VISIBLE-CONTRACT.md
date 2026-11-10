# CIVISIBLE: контракт доказательства браузерной видимости

Статус на 2026-11-08 UTC: validator и unit tests готовы. Реальный Vibe caller, required CI invocation и production smoke ещё не подтверждены. Этот файл описывает контракт; пример не является live receipt.

## Область проверки

Матрица обязательна: chatgpt, zai, opencode, codex, zcode. Отчёт привязан к run_id, source_sha, artifact_sha256 и stage candidate либо installed. Все существующие V1 checks и negative checks остаются обязательными. Добавленный check: vibe_session_visibility=PASS.

Для каждой lane нужен browser_evidence. control_scope=authorized_registered_sessions ограничивает управление. native_catalog_scope=authorized_owner_active_sessions задаёт независимый read-only oracle видимости: подтверждённые текущие active native сессии доступного owner, включая отсутствующие в control registry. Их не нужно массово регистрировать или импортировать.

Нельзя считать все неархивные строки глобальной native DB активными. Нельзя объявлять live failure только из-за native_coverage_complete=false у исторических архивных registry rows. Exact canary readback и полный свежий active catalog собираются до cleanup, отдельно от исторического агрегата.

## browser_evidence

| Поле | Требование |
| --- | --- |
| transport | Ровно vibe-mcp. UI доказательство приходит из настоящего Vibe browser surface. |
| run_id, harness | Совпадают с текущим отчётом и lane. |
| instance_ref | Проверенный control instance из fixture/discovery. |
| core_session_ref | Стабильный session: reference тестового canary. |
| native_session_id | Native ID, полученный обычным create/readback, без ручной замены. |
| ui_native_session_id | Тот же native ID, прочитанный из rendered UI либо exact detail view. |
| observation_phase | Ровно before_cleanup. |
| control_scope | Ровно authorized_registered_sessions. |
| native_catalog_scope | Ровно authorized_owner_active_sessions. |
| native_state_contract | Ровно AgentSession.status. Caller использует уже нормализованный existing adapter ответ. |
| native_state, ui_state | Одинаковый известный canonical статус canary: running, idle либо stopped. Error/archived/UNKNOWN и сырые provider labels не дают успешный canary. |
| native_raw_state_ref | Ссылка на сохранённый сырой provider state. Полный record не выводится в общий CI log. |
| native_receipt_ref | Ссылка на exact canary owner receipt с identity/state и фактическим временем наблюдения. |
| native_coverage_complete | Строго boolean true для exact canary readback. Это не агрегат всех historical registry rows. |
| native_catalog_ref | Ссылка на свежий owner active catalog receipt с host/account/harness scope, source, observedAt, expiry, exhaustive/partial evidence и raw rows. |
| native_catalog_complete | Строго boolean true. Caller проверяет доступность источников, exhaustive coverage, freshness и отсутствие partial/unknown. |
| native_active_session_ids | Уникальные native IDs из полного authorized owner active catalog; пустой список допустим только при доказанной полноте. Регистрация не является фильтром. |
| native_active_states | Map exact active IDs к canonical running либо needs_input. Ключи равны native_active_session_ids. |
| ui_visible_session_ids | Уникальные IDs реально отрисованных/проверенных строк UI после сброса скрывающих фильтров. Включает canary и каждый native active ID. |
| ui_session_states | Map каждого требуемого ID к статусу его rendered UI. Все active statuses и canary status совпадают с native oracle. |
| browser_snapshot_ref | Ссылка на Vibe screenshot/DOM/detail receipts с текущим URL, browser/profile, identity и временем. Открытая страница сама по себе не является подтверждением. |

Caller сохраняет raw native state отдельно и не добавляет новые эвристики outcome/time -> status. Contract sources: src/types/common.ts:AgentStatus; src/adapters/browser-chat.ts:toAgentSession; src/adapters/opencode.ts; packages/agent-resume/src/harness/opencode/client.ts:mapStatus. UI mapping: src/web-ui/main.tsx:statusLabel.

Validator проверяет форму и согласованность receipt references, но не открывает внешние receipts. Поэтому trusted collector обязан записывать их после фактического вызова. Заполнение PASS или ссылок без выполнения проверки недопустимо.

## Existing read-only путь

- src/mcp/active-session-tools.ts:listActiveSessions и list_active_sessions_local читают owner/fleet inventory.
- src/active-session-inventory.ts:readActiveInventory не продлевает TTL. Истёкшее либо недоступное наблюдение становится partial/unknown.
- src/web/server.ts: GET /api/sessions/active.
- src/web-ui/use-active-activity.ts читает этот endpoint.
- src/web-ui/active-activity.ts:mergeActiveActivity добавляет confirmed active строки, которых ещё нет в обычном каталоге UI. Это read-only объединение, без registry import.

Фактический runtime route и backing service требуется проверять по deployed identity. README с default port 18787 не доказывает, что этот порт сейчас обслуживает public Herder UI.

## Минимальный caller и CI wiring

1. Расширить существующий native candidate runner/gate, без второго test framework. Существующий tests/native/v1_multi_browser_stand.py уже сохраняет request keys, native identity и cleanup receipts для настоящих ChatGPT instances в candidate/installed stage; остальные native stands остаются источниками соответствующих lane checks. Полного all-lane Vibe report builder пока нет.
2. Перед запуском зафиксировать expected.json из проверенного build manifest, новый уникальный run_id, stage и exact installed artifact digest. Runtime fixture хранит только ссылки на approved instance/account/profile, Vibe target/browser и UI URL. Секреты подаёт существующее защищённое окружение, не Git, argv или stdout. Отсутствующий fixture/credential/transport означает BLOCKED/UNKNOWN и ненулевой итог, без skip-green.
3. Через существующий public runtime create/deliver/read выполнить canary; request keys сохранять до действия. UNKNOWN после принятого send не повторять. Взять свежий read-only native active catalog, проверить coverage. Через Vibe открыть существующий authorized browser/profile, сбросить filters, прочитать rendered exact IDs/states, при необходимости пройти пагинацию/виртуализацию и exact detail. Записать raw receipts, затем сформировать report.json.
4. Обязательный final command: python3 tests/native/candidate_release_gate.py --validate-v1 report.json expected.json. Его ненулевой exit блокирует release. Missing lane/check/evidence, false coverage, UNKNOWN, другое source/artifact/stage, невидимая либо неверно показанная active native session не допускаются. Очистка выполняется после before_cleanup evidence, только для owned canaries; cleanup receipts сохраняются даже при failure.
5. В .github/workflows/fleet-session.yml сохранить hosted unit contract tests, добавить обязательный installed runtime/browser job в защищённом разрешённом окружении с реальным Vibe транспортом. Не выдавать hosted unit result за live PASS. CI job сохраняет bounded sanitized summary и защищённые evidence artifacts, не prompts/cookies/tokens.
6. Deploy caller запускает тот же collector и тот же validator после readback установленного build, с stage=installed и отдельным run_id. Это production browser smoke, не дополнительный framework. Проверенный canary и существующие authorized active сессии должны быть видны на фактическом public UI. Разные candidate/installed результаты не взаимозаменяемы.

Какие конкретно Vibe target/profile и fixture secret refs допускает production CI, решает существующий TEST_ACCESS/deployment binding. В этой правке они не выдуманы и не созданы. Требуемый статус CI ещё необходимо привязать к release/branch policy; наличие YAML само по себе не доказывает, что gate обязателен.

## Проверка validator

Первый RED: 9 tests, 31 failing subcases на старом validator.
Первый GREEN: 21 tests.
Уточнение scope RED: 15 tests, 24 failures и 1 error на предыдущем helper.
Уточнение scope GREEN: 27 tests, exit 0; git diff --check, exit 0.

Regression включает authorized unregistered active native session, отсутствующую в UI; exact canary ID не виден при наличии screenshot; native/UI state расходятся; scope/phase отсутствуют; active catalog partial/unknown; native raw state/source отсутствует; архивная history coverage не подменяет pre-cleanup oracle.

## Подтверждённые bindings и DOM regression

Root подтвердил рабочий public UI через Vibe MCP Mac M1, canonical target mcp:shell:MacBook-Pro-User.local:Browser, target id cd95ca5a2a40e, URL https://agent.bezrabotnyi.com/. Audit tab 1317325642 принадлежит root и не является постоянным CI fixture. Collector создаёт и закрывает только собственную UI вкладку либо явно переданную QA вкладку.

Installed public runtime transport подтверждён отдельно: https://mcp.bezrabotnyi.com/server/shell-roomhacker-server-100-agentherder/mcp. Existing transport reference: tests/v1-restored-workflows/noticeplace-native-canary.py:PublicRust. Он использует protected ~/.codex/config.toml без вывода credential. Этот endpoint не подтверждает identity Node UI build.

DOM hook на rendered session row содержит data-native-session-id, data-harness, data-status, data-host-id. Local meta.nativeSessionId имеет приоритет согласно existing pin identity; core session: references не получают native hook; remote row сохраняет native ID своего address. Отсутствующий host не выдумывается. Hooks не добавляют технический текст в UI.

tests/session-sidebar.test.tsx раньше не запускался: vitest include допускал только .test.ts. В config добавлен .test.tsx. Два новых regression теста сначала упали; найденный старый expectation Codex · 100 обновлён до текущего human-readable Codex · Сервер 100. GREEN: 4 tests, exit 0.

Read-only GitHub API inventory: runners=0; repository Actions secrets=0; variables=0; environments=0. Active workflow один, Fleet session routing. Поэтому действующий live CI transport пока отсутствует. Ни self-hosted label, ни доступ к protected fixture не объявляются существующими без provisioning. Evidence: github-*-inventory.json и github-actions-fixture-refs.json/github-environments.json.
