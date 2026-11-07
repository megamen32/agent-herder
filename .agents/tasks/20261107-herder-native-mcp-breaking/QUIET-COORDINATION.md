# Тихая координация: проект решения для независимой критики

## Решение

Использовать LHC как единственный источник состояния работы; Herder доставляет задания и редкие вопросы, Context Mode помогает читать evidence по запросу. Не создавать отдельный Agent Forwarder, очередь jobs или вторую базу задач. Уведомление не считается записью результата, отсутствие уведомления не считается простоем.

## Уже доступно

LHC1.16.1 tools/lhc_plan_json.py:update_leaf использует lock, atomic replace, expected_hash и сохраняет progress_events. В текущих leaf есть owner/session/status/result/note/blocker/worker. show_plan читает их без сообщений агентов, но выводит последние12 done в порядке списка и не имеет cursor/delta. Поэтому его полный вывод повторяется и не гарантирует свежие изменения. В этом сеансе Context Mode доступен только как ctx_doctor; execute/search не обнаружены. Решение обязано работать без них.

## Правило записи сегодня — без изменения схемы

Worker через update_leaf обновляет только свою карточку с expected_hash после чтения. status — существующий enum; result — что реально работает и уровень проверки; note — один конкретный следующий шаг; blocker/blocker_details — препятствие и рекомендуемое решение; worker/source evidence — путь/commit/receipt. Не дублировать transcript, секреты и отчёт целиком. Подробности — в evidence файле, ссылка в result. Запись при изменении результата, blocker или завершении; для долгой операции к20-й минуте короткая запись о фактической операции, а не heartbeat каждые N секунд. Часы сами по себе не доказывают active/idle.

Первым записывается результат, затем worker заканчивает ход. Если MCP не отвечает, использовать тот же canonical CLI. Если оба недоступны — сохранить scoped WIP/evidence и один блокер координатору; файлы leaf напрямую не переписывать. Недоставленный отчёт не требует повторять native операцию.

## Чтение координатором

Немедленно доступны show_plan плюс bounded чтение явно назначенных leaf. Постоянное расширение: read-only LhcPlan progress_digest(plans,cursor,limit) над теми же leaf; CLI даёт тот же JSON. Cursor — per-plan/per-leaf semantic hash и consumer watermark, не второе состояние задачи. Хеш до сокращения текста включает точные поля status/result/note/blocker/blocker_details/owner/session/harness/worker/depends_on и evidence refs. Время heartbeat само по себе не создаёт change. Plan path/ID и allowlist обязательны; чужие/неразрешённые планы не читаются.

Ответ: source identity, observed_at, rows с leaf_id/owner/status/result кратко/next/blocker/evidence refs, stale/unknown, coverage и next_cursor. Изменённые blockers и готовые зависимости выше routine updates. Никакого вывода всего progress_events/transcript по умолчанию. Первая загрузка bounded snapshot, после compaction — тот же сохранённый cursor или безопасный новый snapshot. Cursor отмечает прочитанное только после обработки страницы. Pagination фиксирует snapshot либо возвращает changed_during_read и повторяет только чтение; не пропускает изменения за страницей. Invalid cursor → объяснимая ошибка и bounded snapshot, не пустой successful ответ.

Context Mode индексирует только полученную короткую проекцию и evidence refs для локального поиска/расширения. Это disposable read cache; authority остаётся LHC. Ошибка индекса/устаревший cache → чтение источника. Нельзя принимать source/test result за installed proof на основании summary.

## Прерывания и контроль

По умолчанию routine сообщения/ACK/commit notifications выключены на уровне assignment. Вопрос посылается только когда ответ реально меняет следующий шаг: ownership collision, внешнее действие UNKNOWN, нарушенный HumanStop или решение вне полномочий worker. Одна запись blocker, один адресный alert со стабильным ключом plan+leaf+blocker_revision; одинаковое не пересылать. Критичный alert не теряется от quiet mode. Новая поправка человека доставляется сразу и не фильтруется как progress.

Активный Lead читает изменения при завершении своего шага и перед новым назначением; один часовой wake остаётся страховкой, без пробуждения на каждую leaf. Истёкший срок карточки означает stale, не доказанный idle: один native status при необходимости, только потом permitted resume той же session. Quota/refusal/stop не обходить. Тера вместо обязательного chat consultation каждые60мин пишет consultation result в план; срочный запрос всё ещё разрешён.

## Минимальные изменения и проверки

Сейчас: общий handoff+существующие fields/show_plan, без нового runtime. После критики: один read-only digest в исходниках LHC, CLI+MCP wrapper, bounded projection и consumer cursor. Herder не меняется, пока не доказано, что assignment+pull не хватает; возможная следующая интеграция — task pointer в context/skills, а не новый chat bus. Не менять установленный plugin-cache вручную.

Проверки digest: две параллельные leaf updates не теряются; одинаковое время разных updates; restart cursor; pagination/update race; повреждённая/недоступная leaf выдаёт partial; revoked access; repeated read не вызывает deliver; один urgent blocker не тонет в100routine; output limit не скрывает has_more; latest human stop виден независимо от summary. Сначала один реальный цикл writer→canonical leaf→digest→следующий шаг без chat. Только после этого включение по умолчанию в LHC. Цель — меньше лишних сообщений и быстрее полезный handoff, не отдельный проект observability.

## Поправки после независимой критики

### Точный источник и запись

Canonical plan paths берутся из JOINT-EXECUTION.md, никогда из cwd. Leaf адресуется парой absolute plan path + leaf ID; на неё один DRI. Пример для уже работающего шага:

```json
{"plan_dir":"/home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-herder-native-mcp-breaking","leaf_id":"QDESIGN","expected_hash":"<sha256 текущего leaf>","fields":{"note":"Далее: проверить исправленную дельту критиком","result":"Проект quiet handoff уточнён; runtime digest ещё не реализован. Evidence: QUIET-COORDINATION.md"},"note":"Далее: проверить исправленную дельту критиком"}
```

fields.note хранит next step в leaf; аргумент note дополнительно пишет progress_events.note, который читает show_plan. До нового digest coordinator всегда читает bounded exact assigned leaves, включая blocked/waiting; show_plan — обзор, не полный inbox. При CAS conflict перечитать актуальное и наложить только собственную дельту, не заменять весь leaf. При overrun сохранить evidence, сменить состояние на честное waiting/blocked с конкретным остатком либо закрыть только доказанную часть и создать остаток; нельзя ставить done всему незавершённому acceptance. CLI не обходит validation. Если допустимая запись тоже отвергается — один технический blocker, native действие не повторяется.

### Не дать тихому handoff заснуть

На текущем этапе подавление routine сообщений действует, пока Lead активен и читает карточки. Для inactive Lead до доказанного pull wake — узкое исключение: один дедуплицированный `ready dependency` alert с plan/leaf/evidence и следующим действием, только если завершение разблокирует уже назначенную работу. Это не ACK. Дедупликация — существующий Herder inputId/durable receipt, UNKNOWN отправки не повторять. Часовой wake — только аварийная страховка, не штатная задержка очереди. Если разрешённый wake отказал по quota/stop, фиксируется точный отказ; не обходить его. Нельзя обещать latency при отсутствии доступного исполнителя. Проектный quiet режим постоянно включать только после consumer proof inactive→leaf completion→одно следующее назначение; проектный режим сейчас не установленный глобальный runtime.

### HumanStop и страницы

Latest human request/stop, Herder persistent control state и harness permission проверяются до нового действия через уже существующий authoritative control path, независимо от progress cursor и Context Mode. В digest stop — подсказка; промежуточный stop нельзя потерять из-за совпадения конечного hash. Никакой generic progress delivery не заменяет этот guard.

Watermark продвигается только для реально выданных и обработанных версий leaf; не для remainder/partial errors. Недоступная leaf помечается unknown/partial, не удаляется из cursor как исчезнувшая. Update уже выданного leaf во время pagination возвращается следующим чтением. Hash применяется к полной проекции до preview truncation. Snapshot/cursor — read cache, никогда authority и не очередь действий.

### Граница готовности

Этот документ — согласованный проект, не реализованный LHC digest или установленный message filter. Сейчас применимы ручной quiet handoff и точное чтение существующих fields. Реализация digest и её негативные тесты — отдельный короткий этап после design review, не зависимость приёмки пяти adapters. Установка/включение LHC следует только после его собственного consumer proof.

## Прямое уточнение владельца: parent wake после дочерней группы (07.11.2026)

Нормальный trigger — закончилась конкретная назначенная группа, а не наступил следующий час. До запуска children зафиксировать existing worker/plan связь parent native identity + group generation + exact child assignment/native execution IDs. После запуска зарегистрировать ожидание с проверкой уже состоявшихся terminal событий, чтобы быстрый child не потерялся между spawn и subscribe. Новая группа получает новую generation; старые callbacks не закрывают её.

Child terminal hook сначала сохраняет outcome/result/evidence в canonical LHC state. `turn.completed` — закончился ход, не автоматически принят leaf; failed/blocked — тоже причина вернуть управление родителю, но не статус Done. Stop человека остаётся отдельным запретом. Обычный Stop hook без exact child/turn/assignment привязки не доказывает окончание задачи. Native identity уже есть в src/common/tools/lhc_native_identity.py; использовать существующие harness hooks и worker registry, не второй реестр jobs.

Когда все children выбранной группы имеют подтверждённый terminal outcome, один атомарный transition группы формирует stable requestId `parent-wake:<parent>:<group-generation>`. Existing Herder service доставляет один короткий pointer на plan/leaf refs. Дубликаты и рестарт после admission сверяют тот же receipt; UNKNOWN не повторяется. Если родитель уже занят, не interrupt и не второй конкурентный turn: существующий transport делает один отложенный continuation. Родитель перечитывает актуальные результаты/stop и решает следующий шаг. Критичный blocker, требующий решения сейчас, может сообщаться раньше окончания остальных; это отдельный уже разрешённый alert.

Уже имеющийся project-integration.ts умеет follow-up по project lifecycle, но project workers ended не равно exact parent assignment group; его нельзя объявлять готовым parent hook bridge без проверки связи. Не менять штатный общий scheduler.

Проверка в этой сессии: timer wait_af49f511763aee0b8c87b18eaf55b3f5 подтверждён waiting на2026-11-07T16:25:17.522Z (19:25:17МСК). Попытка native dependency wait wait_71deae46f7e34e3671b4b6887dbc7e4a зарегистрирована, но перешла delivery_failed: для CI native turn completion unavailable; idle alone is not completion. Поэтому событийное пробуждение текущей группы НЕ заявлено работающим, timer не отменён. Это конкретный integration gap дляQWAKEHOOK/QWAKEPROOF. Проверять native identity/events и раннюю регистрацию; не подменять completion эвристикой idle и не воспроизводить завершённые native sends.

Доставка completion восстанавливается из durable состояния существующей группы: canonical terminal outcome и pending-wake intent сохраняются до сетевой отправки. После crash/restart один bounded recovery pass досылает только pending с тем же requestId; accepted/UNKNOWN только сверяются. Если exact outcome недоступен, группа остаётся incomplete/unknown с точной диагностикой; таймер будит родителя для проверки, не подделывает terminal.

Event trigger и fallback timer для одной группы разделяют continuation generation/claim и admission ledger. Первый атомарно принятый trigger делает второй no-op; после подтверждённого event admission старый fallback этой группы отменяется. При busy parent сохраняется один continuation этой generation. UNKNOWN не запускает запасную отправку под другим ID. После обработки результата родитель может поставить следующий обычный часовой контроль уже как новую generation. В текущем запуске event admission не было (delivery_failed), поэтому действующий19:25timer сохраняется. Это требование к hook bridge, не утверждение, что два самостоятельных existing wait уже объединены такой логикой.
