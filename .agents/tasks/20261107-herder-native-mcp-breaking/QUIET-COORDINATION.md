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
