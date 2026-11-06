# Независимая критика Astra: REVISE

7 ноября 2026. Область ревью — SPEC, RUST-DESIGN, COORDINATION, RECOVERY-STORAGE, WORKPLAN, plan.json и все R001–R149 ревизии 4. Выводы автора проверялись как гипотезы. Реализация и эксплуатационные изменения не выполнялись. [Исходная ревизия](history/revision-4-before-astra/SPEC.md) сохранена побайтно; [SHA256](history/revision-4-before-astra/SHA256.json).

**Вердикт:** намерение и большая часть предметных требований верны. План нельзя принимать как оценённую программу реализации: он недооценивает durable MCP/клиентскую совместимость, размножает ответственность за владение, предполагает одинаковые возможности 11 разных продуктов и откладывает доказательство результата слишком далеко. Исправленная архитектура проще, но честный полный граф стал длиннее: короткие листья перестали скрывать много независимых работ.

## Замечания с последствиями и заменой

| Приоритет / место ревизии 4 | Дефект и последствие | Конкретная замена ревизии 5 |
|---|---|---|
| P1 R011–R012; RUST-DESIGN «TaskManager связан с durable store» | Официальный TaskManager хранит HashMap/oneshot. Простой wrapper не восстанавливает Task/input после процесса. Два store дадут расхождение. | Один SQLite backend стандартных Tasks, SDK используется для типов/handlers; отдельные slices persistence/input/reconciliation/retention A013–A016. [Доказательство](MCP-EVIDENCE.md). |
| P1 R004/R110/R117 | Версия сервера не доказывает поддержку per-request capabilities, Tasks и Skills реальным host/gateway. Несовместимость найдётся после всех адаптеров. | A001–A003: wire + конкретный primary client gate перед A010 и основной реализацией. Неподдерживаемые долгие вызовы отвергаются до эффекта, без downgrade/jobs. |
| P1 R020/R039 и однотипные send leaves | «Один вызов → одно admission» не определяет completion и гонку двух повторов. Дедупликация только результата недостаточна. | Unique intent/CAS до native call A012; отдельные admitted/confirmed/unknown; deliver completion = входящее сообщение подтверждено, не ответ модели. Crash native A157. |
| P1 R012/R139 | Task TTL и retention сообщений не связаны с сроком дедупликации. Удалённый Task может позволить повторить эффект. | A016 tombstone/receipt живут по отдельной политике; expiry никогда не даёт нового send с прежним key. |
| P1 R032/R137/R143/R145 | Reservations, CAS claim и двухфазная запись owner/state описаны в нескольких местах. Сложность recovery выше необходимой, особенно crash между файлами. | A036–A043, один atomic owner JSON + стабильный lock; UUID epoch вместо общего monotonic fencing. Release сериализует один target runner с ledger. Цена и пределы явно записаны в RECOVERY-STORAGE. |
| P1 R145 | Фраза «remote runner проверяет fence» не описывает линейную границу admission и смерть родителя. TTL может разрешить второй эффект, пока первый ещё идёт. | Target lock берётся раньше live owner/revision проверки, child держит его; UNKNOWN внешний эффект блокирует следующий конфликтующий release до reconciliation. Гарантия требует одного target runner. |
| P1 R121/R149 | «Проверенный откат после новых записей» за час не раскрывает reverse migration и возврат старого writer. Потеряются holds/receipts или возникнут два владельца. | A183–A189: схема импорта, два раздельных импортера, ownership cutover, репетиция и maintenance rollback с сохранённым новым ledger. Старый daemon не возвращается без отдельного reverse proof. |
| P1 R037–R102 | Один и тот же шестишаговый шаблон для Codex, Claude, ACP и browser предполагает доступные create/steer/permissions/full history. «native session transport» не является контрактом. | По каждому продукту bounded native gate, затем connection/read/create/send/history/control/context/native proof. Отрицательный gate не списывает поддержку; фиксирует blocker и следующий минимальный design slice. |
| P1 R106/R138/R140 | Общий hook client не доказывает инъекцию в каждый harness; подписка не равна доступному модели контексту. | A046 projector и отдельный context leaf каждого adapter; A156 реальный A→B/C→B/compaction/reply. Manual-only обозначается честно и не закрывает automatic requirement. |
| P1 R017 | Origin Task и proxy handles не определены; легко получить второй controller или потерять task после proxy restart. | A020–A021: одна origin task identity, routing token и ACL, без копии состояния. |
| P1 R013/R133/R134 | Текстовая attribution и общий node token недостаточны для self/sender. Scope на tools не защищает polling/cache/subscription автоматически. | A008 проверенная binding, A017 ACL/cacheScope для всех ресурсов; reply_to вычисляется сервером и проверяет исходного recipient. |
| P2 R005/R008 | Число 17 закреплено до проверки границ; модели/заметки/cron отдельны, но session/deliver перегружены разнородными мутациями. | 14 typed tools. Session read-only, configure для mutations, discovery моделей; notes в workspace; единый automation executor. Убраны implicit create/delayed deliver и dependency-DAG wake. |
| P2 R023–R025 | Cron, delayed deliver, wake-after-task и autopilot создают несколько планировщиков одного эффекта. | Schedule/one-shot и autopilot rules → один admission executor A047–A050. Workflow dependencies остаются у workflow consumer через standard Task. |
| P2 R016 | Skills read заявлен как потребительская готовность; не различены manifest verification и активация в host. | Статический manifest без ненужного directoryRead; live activation отдельно, локальная копия всегда доступна. |
| P2 R035/R112 | Внешний Notice Place callback и MCP input_required объединены слишком рано; ответы могут возобновить дважды. | MRTR/Task input отдельно от external correlation; один resume request_key. Native callback proof через test contact, ноль телефонных тестов людям. |
| P2 R119 | Лист одновременно импортирует все виды state с разной семантикой. | Раздельные effects и context import, явные unknown/tombstones и повторная no-send репетиция. |
| P2 R122/R123 | Две архитектуры в одном 45-минутном листе скрывают cross-build/native distinction. | Четыре platform artifacts A190–A193 и отдельные installed Linux/macOS проверки. Недоступный native runner не PASS. |
| P2 R125–R132 | «Весь native CI за 60 минут», «независимая приёмка всего за 60 минут» нереалистичны; удаление legacy и финальный build не связаны достаточно явно. | Один RC после удаления legacy, отдельный bounded replay каждого adapter, затем установка и две отдельные независимые приёмки. |
| P2 RUST-DESIGN «Почему Rust» | Tagged Rust сравнивается с ограниченным scan Go main; negative search не доказывает отсутствие расширения. | Сохраняется условный Rust baseline по положительным свидетельствам; Go не объявлен неспособным. Официальные версии проверены, пробелы проверки названы. |
| P2 WORKPLAN оценки/dependencies | 138,5 ч — сумма точек без диапазона, критического пути, client/native gate риска и ресурсной модели. Adapter-повторы выглядят уверенно, но одинаково неизвестны. | 219 slices с диапазонами 20–60 мин, отдельно scope uncertainty/reserve и ресурсное расписание на 1/2/4 исполнителя. Не обещать верхнюю границу для неизвестного native API. |

Идентификаторы A берутся из текущего WORKPLAN; конкретные входы/приёмка/пути находятся там. Если при правке графа число/ID изменятся, эта таблица проверяется вместе с ним.

## Что сохранено и почему

Сохраняются Node→много instances→Session; отделение capability/availability/permission; точный creator/native parent/sender; no replay UNKNOWN; durable HumanStop; roster по проекту и worktrees; самовосстановление контекста; обязательный offline locator; обе целевые ОС; все 11 adapter lanes и все перечисленные consumers. Breaking означает удаление callable legacy, но не удаление native истории и пользовательских данных.

Официальная wire revision и SDK версии оказались реальными. Критиковать их как «будущие/выдуманные» было бы ошибкой. Основные подтверждённые проблемы — durability реализации, границы результата, неизвестные native capabilities и гранулярность оценок.

## Что удалено / объединено / добавлено

Удалены из нового дизайна: отдельный recovery executable; prepared state.json/owner.json transaction protocol; универсальный распределённый fencing framework; неявное создание получателя внутри deliver; второй delayed-delivery scheduler; wake DAG. Ownership epoch сохранён как UUID equality, а реальные эффекты защищаются target serialization и receipt, не просто временем аренды.

Объединены: model discovery с node/instance discovery; notes с workspace; cron и autopilot admission. Не объединяются authentication и attribution, delivery и generation completion, Task lifetime и receipt retention, cooperative checkout и физическое release exclusion.

Добавлены: ранний concrete-client gate; проверка native контракта каждого продукта; durable input requests; expiry/tombstones; origin Task routing; per-adapter context hook; раздельные migration artifacts; target lock/UNKNOWN proof; четыре platform receipts; отдельные финальные adapter lanes. Увеличение числа листьев не является увеличением числа subsystem: тот же scope перестал быть скрыт за часовыми контейнерами.

## Функциональные адаптеры

Полностью функциональная перепись не нужна. Чистые решения/парсеры/reducers плюс маленькие stateful connections дадут независимые тесты без лишнего framework. Traits нужны у границы эффекта, composition — внутри adapter. OOP не мешает тесту, если зависимости явные; свободная функция с глобальным I/O не чистая. Конкретный Rust port, границы и два примера находятся в [RUST-DESIGN](RUST-DESIGN.md#адаптеры-функциональное-ядро-и-небольшие-stateful-соединения).

## Что ещё требует факта или решения

1. Primary client/Hub действительно поддерживает выбранную wire и extensions: gate A003, а не вопрос владельцу до проверки.
2. Конкретные версии/операции ZCode/Qoder/Hermes/Fast Agent/MiniMax/browser и значение «Browser Chat»: gates по одному native контракту. Нет доказанного route — исправить/перепланировать этот lane, не объявлять всё готовым.
3. У каждого release target ровно один runner. Если это нельзя обеспечить, нужен отдельный target-specific fencing дизайн; текущий простой механизм не обещает распределённого consensus.
4. Реальные полномочия и write paths внешних consumers подтверждаются узким target gate. Это план интеграции, не выданное этой сессии право менять другие проекты.
5. Retention receipts и downtime cutover: предложен maintenance при остановленных writers и сохранение tombstones не короче supported retry horizon. Точные значения фиксируются в implementation contract до мутации данных; при уже выданных полномочиях не просить их повторно.

AgentMemory был вызван с project-qualified запросом, но вернул посторонние результаты: они не использованы. Историческая заметка о no-replay использована только как напоминание, не доказательство текущего runtime. Shared WIP вне каталога плана не менялся.
