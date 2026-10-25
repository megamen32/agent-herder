# ZCode Full Access по умолчанию, режимы доступа и запросы разрешений

Прямое поручение пользователя 25.10.2026: полный цикл LHC в ZCode, OpenCode, Codex и MiniMax Code. Дополнительное прямое уточнение владельца: каждая новая ZCode-сессия должна стартовать в native YOLO/Full Access; текущий exact pending request обрабатывает только назначенный native approval executor. «Polaris Human Commit» в контексте текущего разговора трактуется как Last Human Commit.

До: установленный backend остаётся на release 478e; новые ZCode-сессии по умолчанию не подтверждены как YOLO, текущий native request и автоматическая карточка с точным ответом не имеют принятого полного цикла. После: новые ZCode-сессии стартуют в YOLO/Full Access, выбранные поддерживаемые режимы видны с точным readback, разрешение/отказ возвращается ровно тому native request через существующий Notice Place/UserIO путь, а OpenCode может доставить новое сообщение в idle MiniMax desktop без повтора accepted/UNKNOWN.

Режим работы: fullcycle. Пользователь снял прежний запрет на субагентов: доступны три проверенные native LHC worker-сессии на gpt-6-luna; дополнительных сессий и worktree не создаём. Codex weekly quota — 97% remaining; secondary отсутствует/неизвестна. Исходные оценки L01–L14 сохраняются; L15 добавляет отдельную оценку 10–20 минут усилия. Срок зависит от source join, независимого review и live acceptance.

## Решение

Рабочее решение: единый Herder contract поверх четырёх штатных native adapters, события разрешений → существующий Notice Place human-request API → UserIO delivery → коррелированный native response. Смена режима отдельно от ответа на уже ожидающую команду; readback обязателен.

Идеал: полная динамическая матрица всех native режимов и scopes, редактирование сложных правил, история политик и расширенная настройка каждого типа карточек. Это усложняет интерфейс и риск несовместимых обещаний между средами.

Минимальная полная версия: переключение только реально поддержанных режимов, включая требуемый Full Access; однократное разрешение/отказ; четыре обязательных живых сценария. Один существующий UI и MCP, одна карточка на запрос, короткий очищенный контекст. Редактор произвольных правил, массовая смена режимов, автоматический Allow All и новая коммуникационная служба исключены. Нативное ограничение не обходится fork/runtime patch и не считается выполненным требованием.

## Границы

Работа только в Agent Herder. Notice Place и UserIO используются через существующие API; новый Telegram-клиент и прямой Bot API не добавляются. Никаких телефонных тестов, дополнительных исполнителей или worktree, моделей/fallback, изменений брокера/AFC/TGC, снятия HumanStop или воспроизведения accepted/UNKNOWN. Текущие четыре product-сессии не становятся тестовыми автоматически. Full Access не означает выдачу владения исходниками соседних проектов.

Canonical checkout остаётся на main, чужой WIP сохраняется. Пользователь отдельно разрешил один Git worktree `/home/roomhacker/agents-projects/.worktrees/herder-permissions-20261025` и ветку `codex/herder-permissions-20261025` от актуального origin/main. Дерево создано на `9d2abbe`, подготовлены собственные зависимости из lockfile. Предыдущий интегратор подтвердил принятую первоначальную поставку `9d2abbe` и освободил исходники и выпуск; дальнейшая запись нового цикла выполняется только в разрешённом дереве. План остаётся единственным, в canonical `.agents/tasks/20261025-permission-control-fullcycle`.

## Доказательства

Каждая из четырёх приёмок отдельно доказывает source regression, установленную версию, native mode readback, доставку карточки, ответ в exact request и единственное завершение. Карточка не содержит секретов; unavailable context обозначается явно. Реальный отказ пользователя не заменяется тестовой фикстурой. Реальный ответ человека и тестовый callback — отдельные виды доказательств.

## Plan
Цель: Доставить полный цикл управления native permissions и режимами для ZCode, OpenCode, Codex и MiniMax Code, плюс исправить обнаруженные workspace, activity, titles и session-search дефекты в Agent Herder; без Telegram API, runtime forks и replay accepted/UNKNOWN.
Бизнес-результат: Установленный combined backend release a34a4fee0ddd8e1e31f2911699e170c142226ab7 на host100 принят 21/21. На нём одна публичная новая ZCode-сессия без параметров режима прочитана как native YOLO без pending/active turn, fixture официально закрыта, пять прежних сессий не изменялись. Frontend pin 57d2adee применён штатно, managed nginx drift 0. Это подтверждённый предыдущий выпуск; полный четырёх-harness цикл и новый combined release остаются открытыми.
Декомпозиция: 19 листьев · 3 параллельно · 11 волн · слотов: 3

**Подтверждено:** source и installed a34 отдельно приняты; focused ZCode tests 98/98, official checks 14/14, host100 PID/readback и owner acceptance 21/21. Для a34 frontend pin 57d2adee применён штатным timer, `nginxctl diff` сообщает no managed drift. Эти факты относятся только к предыдущему выпуску.

**ZCode default create:** Первая ограниченная canary на 49b завершилась `created=false` из-за отсутствующего native `projectId`; повторять её не стали. Reviewed mapping вошёл в a34. Одна новая публичная ZCode-сессия после установки создана без mode/fullAccess/model/initialMessage; exact same-session readback подтвердил YOLO, pending пусто, humanMessageCount=0, active turn отсутствует. Fixture официально закрыта; пять прежних сессий прочитаны как YOLO и не изменялись. Это принятая ZCode canary, не полный цикл.

**Source/review:** UI/API `509f2b8` и UI↔MCP source join получили independent SHIP; focused UI/permission tests 44/44 и TypeScript GREEN. MiniMax durable source `5f3d3a9`, consumer WIP и same-DB atomic proof имеют ранее подтверждённые 52 tests + TypeScript; review correction `7643500` получила independent SHIP. Search fixes `3380e8a` и `896a38be` получили independent SHIP, focused 15/15. Ни один из этих fixes не входит в установленный a34; build/install и live consumer checks остаются в L19.

**Открыто:** Codex и MiniMax не поддерживают session-mode change; UI должен показывать это честно. Browser inspector readback ещё не выполнялся, production mode writes не делались. Для MiniMax pending exact-fixture consumer proof; для OpenCode — filtered native query/readback. Automatic Notice permission trigger и реальный Notice consumer proof отсутствуют. L19 ждёт reviewed source join и затем докажет install/consumer слой. Полный четырёх-harness результат остаётся открытым; незапущенные проверки не считаются PASS.

**Листья по порядку графа:**

✅ L01 — Проверить нативные возможности и безопасные тестовые сессии.
🔄 L18 — Исправить нулевые текстовые результаты поиска по каталогу.
⏳ L19 — Установить и проверить объединённые исправления.
✅ L02 — Определить единый контракт режима и точного разрешения; зависит: L01.
🔄 L03 — Подключить смену режима в четырёх адаптерах; зависит: L01.
✅ L13 — Восстановить рабочие папки MiniMax в Herder; зависит: L01.
⏳ L16 — Доставлять сообщение в idle MiniMax desktop без повтора; зависит: L01.
✅ L17 — Исправить заголовки задач в Herder и проверить восемь сессий; зависит: L01.
⏳ L04 — Собирать запросы и возвращать точный ответ в нативную среду; зависит: L03.
✅ L14 — Проверить активность агента в TelegramAuto; зависит: L13.
✅ L15 — Установить Full Access по умолчанию для новых ZCode-сессий; зависит: L03.
⏳ L05 — Доставлять карточку с контекстом через Notice Place; зависит: L02, L04.
🔄 L06 — Показать управление режимами и разрешениями в Herder; зависит: L03, L05.
✅ L07 — Опубликовать и установить согласованный выпуск; зависит: L06, L14, L15, L17.
✅ L08 — Проверить живой путь ZCode; зависит: L07.
⏳ L09 — Проверить живой путь OpenCode; зависит: L08, L19.
⏳ L10 — Проверить живой путь Codex; зависит: L09.
⏳ L11 — Проверить живой путь MiniMax Code; зависит: L10, L16.
⏳ L12 — Закрыть полный цикл по пользовательскому результату; зависит: L11, L14, L16, L17.

Слотов: 3; исходные оценки сохранены. Public plan содержит только безопасные source/review/install facts; private native IDs и receipts не публикуются. Не повторять accepted/UNKNOWN.
