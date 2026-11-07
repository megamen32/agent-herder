# Общая очередь Herder и CI: пять адаптеров

Прямое поручение владельца 07.11.2026. Этот порядок уточняет FAST-PATH.md. Полные 18 критериев ACCEPTANCE-COVERAGE.json сохраняются; ближайший выпуск пяти адаптеров не закрывает миграцию, ресурсы, automation и cutover. Один продуктовый план и один план проверок, без третьего плана или нового сервиса.

Канонические источники для всех checkout:
- Herder: /home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-herder-native-mcp-breaking
- CI: /home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261105-deterministic-harness-ci

В каждом общем шаге один DRI: QOCJOIN/QBROWSERJOIN/QCODEXJOIN — Terra; V065AHAPCIRUN — Luna; E002 — Astra; QCHATCASE/QZAICASE — browser worker; QZCODEJOIN — ZCode worker; все CI C* и L101 — CI lead. Второе имя в таблице означает поставщика входа или ревьюера, не второго writer/оператора. Реальные session IDs записаны в canonical leaves. Относительные пути в worktree — только source-копия документов, не источник runtime статуса.

## Результат ближайшего выпуска

Через общий интерфейс Herder пользователь создаёт сессию выбранного instance, отправляет одно сообщение, читает ответ и полный транскрипт. Видны native identity и степень полноты. Проверены другой instance/account, restart и отсутствие повторной отправки UNKNOWN. Затем тот же сценарий доступен через установленную версию и обычный клиент. Для CLI лжемодель заменяет только backend модели; harness, adapter и core настоящие. Browser fake/CDP contract не доказывает работу ChatGPT/Z.ai: нужны отдельные разрешённые native canary.

Приёмка: OpenCode → ChatGPT → Z.ai → ZCode → Codex. Подготовка независимых файлов идёт параллельно; приоритет не создаёт искусственные depends_on. Общий CI умеет параметры candidate/installed и harness; новый стенд на каждый адаптер не создаётся.

## Кто владеет результатом

- Astra: очередь и межплановые решения; читает изменения карточек, не собирает ACK.
- Terra: Rust core, Cargo/lib/schema, сборка и интеграция; не более четырёх прямых workers.
- Luna: tests/native/ahap_opencode_stand.py и test_ahap_opencode_stand.py, первый consumer нового core.
- OpenCode worker: готовый TS client/runner 8e051d01; повторно не реализует протокол.
- Browser worker: AHAP/direct-CDP seam и его contract tests. Старый CI владеет своей текущей ChatGPT/site-driver работой; пересечение файлов сначала разрешается адресно.
- CI lead 01a1ac52-d25c-7050-a65d-3fca32642c26: tests/native/launch.py, test-model-server.py, общий runner и приёмка установленного старого Herder; передаёт готовые drivers/receipts новому core. Сохраняет собственный CI+ChatGPT/Z.ai scope.

## Уже готово: забрать, не исследовать заново

| Вход | Проверенный предел | Действие |
|---|---|---|
| Luna main70fba336+ca4c3907 | Stand, 14 offline tests, tools/list; evidence /home/roomhacker/herder-artifacts/evidence/ahap-stand-20261107/preflight-receipt-final.log; model requests=0, native mutations=0 | FASTINIT закрывается как preflight, business case остаётся отдельным |
| OpenCode 8e051d01 | 7 source files, авторские 39 tests/typecheck; unpublished | Terra принимает точную дельту совместно с core eeba0f8b; native доказательства пока нет |
| core eeba0f8b | Fresh create initial Start, source-review; не общий Start существующей сессии | Один согласованный core+runner artifact; не fixture-only fork |
| Browser ed1acd95,429d39b0,385efc83,d0a71185,76bd8325 | Авторские 42 fake tests; runtime не принят | Одна delta-review, интеграция; готовые site drivers и CI ChatGPT fixes сохранить |
| CI L100/c32f6083 | Codex/OpenCode 2 sessions, search/transcript на bundle1f1cfcd8 за7.252s | Reuse launcher/model/receipt; это не установленный PID |
| CI L45/dcb01f5e | ZCode3.17.2, 2 sessions, transcript,5 model requests,26.6s | Забрать рабочий driver; старую UNKNOWN попытку V072D не повторять |
| CI L92,L98 | ChatGPT установленный transcript12events; Z.ai30events/3pages | Reuse разрешённые session refs/site logic; exact account/browser scope заново не угадывать |
| V044A5a8bcd65 + correspondence5034cf7b | Контекст source3PASS в кандидате56d9603c, integration pending | Отдельная очередь интеграции, не блокер пяти adapter canary |

## Ближайшие ограниченные действия

| Карточка | Владелец | Вход → выход | Время |
|---|---|---|---|
| QOCJOIN | Terra | 8e051d01+eeba0f8b+ca4c3907 → опубликованный согласованный artifact, проверенный actual TS payload | 10–15мин |
| V065AHAPCIRUN | Luna | QOCJOIN artifact + готовый stand → один свежий isolated case create/deliver/read/reopen, exact IDs/count/receipt | 10–15мин |
| E002 | Astra | Полученный receipt → принять доказанный объём, без повторного send | 5мин |
| QBROWSERJOIN | Terra + reviewer | Готовая browser delta → принятие или один воспроизводимый defect, без нового transport | 10–15мин |
| QCHATCASE | Browser worker (CI даёт scope) | Принятый direct-CDP artifact и разрешённый CI test scope → один ChatGPT case с core | 10–15мин после входов |
| QZAICASE | Browser worker | Тот же transport и существующий Z.ai driver → один Z.ai case | 10–15мин после входов |
| QZCODEJOIN | ZCode worker | Рабочий CI L45 driver/adapter → AHAP composition и isolated case на новом core | Первая задача10–15мин: только composition; case отдельный V078 |
| QCODEXJOIN | Terra/свободный worker | Рабочий CI Codex adapter/receipt → AHAP composition, без fork клиента | Первая задача10–15мин: только composition; case отдельный V060 |

API family не выбирать по номеру версии или одному HTTP200: /api/config возвращает массив path/type, это само по себе не доказывает нужный session/message API. Использовать реально работающий native путь из tests/native/opencode_receipt.py и явный protocol в runner. Не повторять полное исследование: при несовпадении сохранить exact request/response без секретов и исправить один boundary.

CI отдельно закрывает установленный consumer и release gate по своей JOINT-EXECUTION.md. Общий core artifact передаётся один раз; CI не переписывает адаптеры, adapter worker не строит новую лжемодель. Обновление библиотеки не требует повторной раскатки всего флота на каждом коммите.

## Когда шаг не выполнен

15 минут — размер известного действия, не обещание пройти неизвестную интеграцию. Если возник новый разрыв, сохранить доказанный результат и scoped WIP, записать конкретный остаток; не оставлять running на часы и не ставить done всему пути. Существующие approvals/HumanStop/UNKNOWN не отменяются новым планом. Отсутствие делегированного browser scope блокирует только browser live case, а не source integration и CLI. До запуска использовать уже проверенные CI права и refs, не расширять доступ по старой заметке.

## Тихая координация

Применяется QUIET-COORDINATION.md: worker пишет результат в canonical leaf; Astra читает bounded изменения. Обычные сообщения и ежечасный совет заменяются обновлением плана. Срочные решения/конфликты остаются адресными. Пока проектная настройка не поддержана runtime, это явный handoff, а не заявление о доставленном hook.

## Ресурс browser и общая приёмка

QCHATCASE выполняет только browser worker. CI lead выполняет L101. До живого теста CI lead записывает в CISHARE exact delegated account/context/target/session refs без access URL/секретов. Если нужен один и тот же target, сначала CI L101 завершает свою операцию и освобождает существующий resource lease, затем QCHATCASE; иначе каждый claim свой отдельный target. Без точной передачи scope/lease QCHATCASE waiting, но QZAICASE и CLI не ждут этого ресурса. UNKNOWN удерживает только затронутую операцию и запрещает её повтор.

FIVE-ADAPTER-ACCEPTANCE.json — незаполненная проверяемая матрица ближайшего выпуска. Пять lanes обязательны; для каждого требуются candidate и installed cases с exact runtime identity, create/deliver/read/transcript, other-instance/account, restart, no-replay и HumanStop. Допускаются ссылки на существующие доказательства при явно проверенной применимости к той же версии/маршруту. Старая версия доказывает reusable input, не готовность нового core. Отсутствующий browser receipt → весь выпуск пяти INCOMPLETE, но отдельный доказанный CLI этап можно выпустить с честным scope. AC01–AC18 остаются отдельным полным Done.
