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
Бизнес-результат: Combined backend release a34a4fee0ddd8e1e31f2911699e170c142226ab7 установлен и принят 21/21. На нём публичная новая ZCode сессия, созданная без параметров режима, прочитана как native YOLO без pending/активного turn; своя fixture закрыта официально, пять старых сессий не изменялись. Frontend pin `57d2adee` применён штатным timer, managed nginx drift 0. Остальной четырёх-harness цикл открыт.
Декомпозиция: 18 листьев · 3 параллельно · 11 волн · слотов: 3

**Подтверждено:** source a34 опубликован и independently reviewed; focused ZCode tests 98/98; official artifact checks 14/14; installed host100, PID readback и owner acceptance 21/21. Отдельный baseline 49b также был установлен/принят, но заменён a34. UI static tree точно скопирован из verified live release; commit 57d2adee изменил две root pins и один source header. Nginx timer применил commit, deployed-git-sha=57d2adee, `nginxctl diff` сообщает no managed drift. Публичный endpoint остаётся за auth; authenticated browser readback и workspace filter остаются открытым доказательством.

**ZCode default create:** первая ограниченная canary на 49b трижды завершилась `created=false`, native session не создавалась; причина — отсутствующий native `projectId`. В a34 вошёл reviewed exact owner-scoped project mapping. Одна публичная canary после установки a34 создана без mode/fullAccess/model/initialMessage; exact same-session native readback показал YOLO, pending пусто, humanMessageCount=0, active turn отсутствует. Тестовую fixture закрыли `closeSession` + `archiveTask`; итоговый readback idle/nativeLoaded=false, root untouched. Task-delete query был unavailable, повторов не было; приватный receipt вне public plan. Пять старых ZCode sessions не менялись.

**Search:** 6099a19 metrics входят в установленный a34 и различают current processed и durable indexed значения. Приёмка требует свежий source receipt и read-only COUNT на одном snapshot/version, exact host+harness scope; partial/stale отражать явно, counts динамические. Нужен точный реальный query→message/snippet. Цитата пользователя и её root cause пока не подтверждены.

**Открыто:** аутентифицированный UI/browser readback нового frontend pin и TelegramAuto workspace filter; Codex mode не поддержан; MiniMax mode/delivery; Notice Place permission observer/response; idle MiniMax delivery; общий четырёх-harness consumer acceptance. Не считать ZCode canary или installed source доказательством этих веток.

**Листья по порядку графа:**

✅ L01 — Проверить нативные возможности и безопасные тестовые сессии.
🔄 L18 — Исправить нулевые текстовые результаты поиска по каталогу.
✅ L02 — Определить единый контракт режима и точного разрешения; зависит: L01.
🔄 L03 — Подключить смену режима в четырёх адаптерах; зависит: L01.
✅ L13 — Восстановить рабочие папки MiniMax в Herder; зависит: L01.
⏳ L16 — Доставлять сообщение в idle MiniMax desktop без повтора; зависит: L01.
✅ L17 — Исправить заголовки задач в Herder и проверить восемь сессий; зависит: L01.
⏳ L04 — Собирать запросы и возвращать точный ответ в нативную среду; зависит: L03.
✅ L14 — Проверить активность агента в TelegramAuto; зависит: L13.
✅ L15 — Установить Full Access по умолчанию для новых ZCode-сессий; зависит: L03.
⏳ L05 — Доставлять карточку с контекстом через Notice Place; зависит: L02, L04.
⏳ L06 — Показать управление режимами и разрешениями в Herder; зависит: L03, L05.
✅ L07 — Опубликовать и установить согласованный выпуск; зависит: L06, L14, L15, L17.
✅ L08 — Проверить живой путь ZCode; зависит: L07.
⏳ L09 — Проверить живой путь OpenCode; зависит: L08.
⏳ L10 — Проверить живой путь Codex; зависит: L09.
⏳ L11 — Проверить живой путь MiniMax Code; зависит: L10, L16.
⏳ L12 — Закрыть полный цикл по пользовательскому результату; зависит: L11, L14, L16, L17.

Слотов: 3; исходные оценки сохранены. Public plan содержит безопасные метаданные; private native IDs/receipts/transcripts не публикуются. Не повторять accepted/UNKNOWN.
