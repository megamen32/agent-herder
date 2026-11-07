# План исполнения: переиспользование, короткий путь, один владелец результата

Ревизия по прямому поручению владельца 07.11.2026. Этот документ заменяет порядок исполнения из старых WORKPLAN/WAVES/HANDOFF; продуктовые обязательства ACCEPTANCE.md сохраняются целиком. Фактические статусы — в канонических leaves/, не в копиях worktree.

## Что уже есть — не писать повторно

| Готовый вход | Что использовать | Чего он пока не доказывает |
|---|---|---|
| main 94e7d98c, artifact /home/roomhacker/herder-artifacts/ahap-94e7d98c | Rust core, durable intents/Tasks, trusted owner composition, AHAP transport, OpenCode TS runner | Реальная API family ещё сверяется: preflight v9 увидел api-session, core отверг protected profile до mutation. FASTINIT исправляет точный отказ; version-only предположение не выбирает новый adapter |
| Старые src/adapters и AHAP v0.1 | Реализации harness, site scripts, native readers; языконезависимый процессный интерфейс | Нельзя переносить скрытый retry, второй ledger или ложный notSubmitted |
| tests/native/launch.py, test-model-server.py, opencode_receipt.py | Готовая изоляция, лжемодель, native readback и счётчик запросов | Новую модель/стенд не создавать; новый business driver — Luna |
| V027A/B, V028/V029, V031A/B, V017B | Durable sender/reply, recent/transcript projections, inventory и resource ACL | Большая часть source-only: осталось подключение к application, а не переписывание функций |
| R001/R002, V036–V043 | Registry ресурсов, atomic claim/release, offline authority, guard/receipts | Подключение MCP и конкретных consumers, свежая независимая проверка |
| T001/T002, crates/herder-compat | Отдельный translator на SDK и upstream discovery | Caller identity, tool/Task forwarding и реальный старый клиент ещё не приняты |
| ed1acd950cbd018d478238da3a237c0dc684bcfc и текущий browser WIP | ChatGPT AHAP wrapper, готовые site drivers | Последующая delta76bd8325 исправляет scope/failure и добавляет direct CDP; tsc+42fakePASS, независимый delta-review/live ещё не выполнены |
| Старый Codex consumer receipt 9dfe147d | Уже доказанный SDK + Codex + лжемодель путь, один запрос модели | Не повторять принятый запрос; Codex доводится последним |

## Очередь и реальные зависимости

1. OpenCode первым. Luna заканчивает уже начатый driver и один новый изолированный create→deliver→read/reopen. Тера устраняет только воспроизведённые несовпадения core/старого adapter. Для ещё не проверенной комбинации artifact+adapter+native version до mutation нужна read-only проверка API; подходящее существующее evidence заменяет повторную проверку. Не ждать translator, Codex, UI, поиск или все платформы.
2. Параллельно: browser worker заканчивает direct-CDP transport и исправляет два замечания wrapper; resources worker подключает готовые resource/context функции. Это разные файлы и не зависит от OpenCode canary.
3. Параллельно можно довести минимальный translator: identity → обычные tools → Task get → restart proof. Старый клиент нужен для отдельного результата совместимости, а не как блокер прямого native OpenCode.
4. После OpenCode — ChatGPT, затем Z.ai: тот же AHAP/core и существующие site drivers. Общий direct-CDP transport пишется один раз. Local draft честно отличается от native conversation; queued delivery объявляется только при подтверждённой native поддержке.
5. Затем ZCode и последним Codex. Переиспользовать старые adapters и уже написанные Rust projections. Native реализацию заново не писать. UNKNOWN V072D/E остаётся сохранённым запретом повтора исходной попытки.
6. Оставшиеся общие capabilities и подготовка installed delivery выполняются по готовности своих входов, параллельно первому вертикальному пути. Новые задачи появляются только для проверенного остатка, до 15 минут каждая.

## Какой результат обязан дать каждый этап

| Этап | Обязательство, которое не снято | Минимальный выход |
|---|---|---|
| S04 OpenCode | Общие create/deliver/read, exact receipt, no replay, HumanStop | Один native consumer с лжемоделью; воспроизводимый локальный запуск опубликованной сборки |
| S02 Координация и ресурсы | Creator/sender после compaction, peers/worktrees/freshness; global/project/node ресурс и atomic offline claim | A создал B, C написал B, после очистки B отвечает C; model-visible injection отдельно; claim race и release guard проверены |
| S06/S07 ChatGPT/Z.ai | Existing site logic через прямой CDP, account/context/target isolation; honest capabilities | Свой тестовый чат/сообщение/ответ через общий core, без MCP browser gateway/Vibe |
| S05/S01 ZCode/Codex и совместимость | Единый API, native receipts; отдельный удаляемый translator, Tasks input/cancel, Skills и subscriptions | Неизменённый клиент работает; удаление translator не ломает native core |
| S03 Автоматизация | Schedule/autopilot используют общий intent, persistent stop, timezone/DST и no replay | Один триггер, один эффект; restart/stop не запускают повтор |
| S08 Общий контракт и consumers UI/CLI | Export/search/settings/permissions, inventory, два Codex, два OpenCode, два browser profiles, одинаковые native IDs в fixture, две ноды, HTTP/stdio, ACL | Готовые функции подключены; исправимые ошибки сообщают field/expected/correction; partial не выдаётся за полное чтение |
| S09 Внешние consumers | Hub, LHC, Notice Place, UserIO, Board, секретарь; локальные Skills/runbook | По одному адресному договору и реальному сценарию на consumer; изменения только необходимых вызовов |
| S10 Сохранение данных | Holds, UNKNOWN, intents, lineage/settings/resources, backup и совместимый rollback | No-send импорт дважды; rollback после новых записей сохраняет актуальный ledger; holds/UNKNOWN не теряются; старый writer не пишет параллельно |
| S11 Артефакты | Linux amd64/arm64, macOS amd64/arm64; параметризованный root | Один build/install pipeline и отдельный native smoke платформы; cross-compile не называется native proof |
| S12/S13 Cutover и приёмка | Удаление старого daemon/jobs/aliases/fallback writers; consumer migration, installed restart, независимая проверка | Новый runtime реально установлен, история сохранена, обычные клиенты работают; все ACCEPTANCE.md строки доказаны |

Это обязательные этапы, а не выполненные задачи. Минимальный выход — промежуточная польза, не закрытие этапа: закрытие требует всех строк ACCEPTANCE-COVERAGE.json. В реестре сохранён точный исходный критерий каждого обязательства, evidence и остаток; source-only не удовлетворяет runtime критерию. Их старые микрозадания помечаются deferred только как заменённый способ исполнения; функциональность не вычёркивается. Снимок всех исходных записей и соответствие этапам — history/reuse-fast-20261107/. Незакрытые bugs и HumanStop/approval refusals остаются самостоятельными ограничениями.

## Карточка для исполнителя

Каждый активный лист содержит: (1) конкретный вход/commit и существующий код; (2) один результат за 5–15 минут; (3) только owned paths; (4) точную проверку и ожидаемый результат; (5) следующий получатель. Если вход уже есть, не начинать новый обзор архитектуры, выбор SDK, стенда или инфраструктуры.

Не разбивать отдельно «написать код», «записать SHA», «сделать отчёт» и «проверить уже проверенное»: один лист заканчивается кодом, нужной проверкой и квитанцией. Не делать повторный полный review после неизменённого source. Review блока — один; после REVISE проверяется только исправленная дельта. Native proof остаётся отдельным от unit.

Если лист не помещается в 15 минут: сохранить WIP, указать конкретный непроверенный остаток и выделить следующую ограниченную операцию. Не называть незавершённое done и не начинать новую реализацию того же adapter.

## Ответственность и волны

- Astra: порядок, устранение межкомандных зависимостей, приёмка. Одна каноническая очередь; не рассылать одинаковые статусы.
- Terra: core, shared Cargo/lib/schema, сборка/интеграция. Максимум четыре прямых исполнителя. В её следующем шаге всегда конкретный файл/нестыковка, а не «довести архитектуру».
- Luna: один OpenCode consumer; её stand/driver не пишет второй исполнитель.
- Browser worker: src/ahap-browser-runner.ts, src/adapters/direct-cdp-page-tools.ts и их tests; точечный expected-account seam в chatgpt-mac-cdp-driver.ts предварительно согласуется с владельцем старого CI. Старый CI владеет tests/native/launch.py, test-model-server.py, исходным runtime release и своими текущими driver fixes; старый CI+ChatGPT worker продолжает собственное поручение и не переназначается.
- Resources worker: resource/context integration; OpenCode runner worker может взять готовый независимый adapter/client кусок после явного назначения. Остановленных/отказавших не будить; UNKNOWN не повторять.

Ближайшая волна — 3–4 независимых результата. Следующая волна начинается по готовности своих входов, а не после завершения всех предыдущих исполнителей. Число работников определяется независимыми файлами, не количеством строк плана.

## Оценка без выдуманного срока

Первый контроль — через 15 минут: готовый consumer driver, конкретный native результат либо точное несовпадение протокола; browser source delta; один подключённый общий handler. Следующий — через 30–45 минут после доступности входов. Это контрольные интервалы, не обещание завершения всего проекта.

Полный срок пока неизвестен: live ChatGPT test profile имеет ограничение доступа, translator имеет непроверенный client path, финальный cutover затрагивает несколько consumers. Убирать их из оценки нельзя. Срок уточняется по фактическим интеграционным результатам; 15-минутные листья — ограничения на объём шага, не доказательство общей длительности.

Полный Done: выполнен ACCEPTANCE.md, опубликован owned source, проверены установленный runtime и реальные consumers, сохранены необходимые данные, legacy execution удалён. Сохранённый adapter-код под новым AHAP boundary не считается старым daemon: удаляется дублирующая инфраструктура, а не работающая логика harness.

## Что открывать Тере сейчас

1. FASTINIT: Luna исправляет конкретный protected-profile отказ и сохраняет read-only API доказательство. FASTOC22 source-порт сохраняется, но если готовая v2 ветка подтверждается тем же binary, этот порт не блокирует первый canary.
2. FASTCORE22: Terra собирает core с подтверждённой FASTINIT веткой; для v22 соединяет typed fresh Start, для подходящей готовой v2 не создаёт лишнюю зависимость. Изолированный proof не означает поддержку общего direct Start.
3. V065AHAPCIDRIVER → V065AHAPCIRUN: Luna заканчивает stand и выполняет единственный case; E002 принимает его receipt без повторной отправки.
4. Независимо готовы V017, V040B, V044A (resources/context), V031C (inventory) и T003 (translator identity). На одного исполнителя один активный owned объект; не брать одновременно все эти карточки.
5. V060/E003/E004/V069/V078/V087/V096/E005/E006/E007/E008/E009/V159 — незакрытые gates обязательных этапов, не задания на новую архитектуру. Их waiting означает отсутствие полного acceptance пакета; эта очередь не превращается в фиктивный Done после ближайшего canary.
