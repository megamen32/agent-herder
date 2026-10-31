# Сокращение каталога инструментов Agent Herder

## Поручение и границы

Принят полный план первого цикла. Эта поставка содержит только LHC artifacts в .agents/tasks/20261024-herder-tool-catalog/. Исходники, существующие task/roadmap, foreign WIP и release файлы не изменяются. Статус L02 running задан владельцем; реализация и release этим документом не объявляются выполненными.

Прочитаны текущие AGENTS.md, .planning/PROJECT.md, REQUIREMENTS.md, ROADMAP.md и STATE.md. Существующий roadmap и текущая работа сохраняются. Нативная активация LHC hook в этой сессии не подтверждена; artifacts создаются по установленной plan-artifacts процедуре с ручным запуском проверок.

## Baseline и метрики

Текущий readback доступного подключённого каталога: 87 tools. L01 done относится к этому подтверждённому baseline count. Полные JSON-схемы, runtime revision, transport/profile, byte count и матрица прав должны быть сняты перед реализацией; эти расширенные доказательства пока не получены.

Различать advertised (tools/list), callable (точный tools/call) и authorized (права конкретного субъекта). Скрытие не меняет прав. Последовательность advertisement: 87→85→79→76. Optional профиль: 42 основных +34 дополнительных. Снижение 87→76 = 12,6%; 87→42 = 51,7%. При сохранении aliases и добавлении двух новых read имён временно 89 callable endpoints. Неподтверждённые объединения чтений исключаются с честным пересчётом итога.

## Plan

Цель: сократить каталог Agent Herder на реальном подключённом MCP с сохранением exact endpoints и полномочий.
Бизнес-результат: меньший advertisement с доказанной совместимостью и работающими очередями и active-session lifecycle.
Декомпозиция: 7 листьев · 1 параллельно · 7 волн · слотов: 1

✅ Зафиксировать live baseline и матрицу контрактов. Подтверждён baseline count; время не измерено.

🔄 работаем Доставить первый scoped slice 87 → 85. Назначено владельцем; реализация не подтверждена, время не измерено.

⏳ Сократить advertisement 85 → 79 через sync aliases. Начнём после L02: нужен проверенный результат предыдущего среза; оценка времени неизвестна.

⏳ Объединить однородные чтения 79 → 76. Начнём после L03: нужен проверенный результат предыдущего среза; оценка времени неизвестна.

⏳ Проверить профили 76 и optional 42-agent-profile. Начнём после L04: нужен проверенный результат предыдущего среза; оценка времени неизвестна.

⏳ Уточнить descriptions и мигрировать потребителей. Начнём после L05: нужен проверенный результат предыдущего среза; оценка времени неизвестна.

⏳ Выполнить контролируемый релиз и consumer acceptance. Начнём после L06: нужен проверенный результат предыдущего среза; оценка времени неизвестна.

## Семь критериев приёмки

L01: Текущий readback подтверждает 87 tools; исходные имена сохранены в task.md. Полный снимок схем, размер в байтах, версия runtime и матрица прав остаются обязательными входами перед реализацией.

L02: Реальный подключённый агентский MCP показывает ровно 85 tools; разрешённый legacy/peer вызов работает, запрещённый прямой вызов отклоняется; source tests, установленная ревизия и consumer readback представлены отдельно.

L03: Подключённый MCP показывает 79 tools; sync endpoints сохраняют прежний результат и права, async возвращает job receipt, reconnect/readback не повторяет принятую операцию.

L04: Каталог содержит 76 tools при доказанной эквивалентности прав всех трёх объединений; get-only субъект не получает list-доступ, неверные ветви отклоняются до handler. Если эквивалентность не доказана, merge исключается и итог увеличивается на один.

L05: Полный профиль показывает 76, legacy сохраняет исходные 87 имён, peer сохраняет внутренние exact endpoints. При включении optional профиля он показывает ровно 42; reconnect/обновление каталога подтверждены клиентом, скрытие не меняет authorization.

L06: Descriptions и migration guide отражают реальные контракты; существующие callers проверены, aliases сохраняются до инвентаризации и согласованного периода без legacy вызовов. HumanStop, queued delivery и active-session lifecycle проходят регрессионную проверку.

L07: Есть runtime revision и полный tools/list с пагинацией; доказаны 87→85→79→76, optional 42, размеры схем и отдельный callable count; тестовая сессия подтверждает steer/queue, async reconnect, legacy sync и отрицательную авторизацию без повторов UNKNOWN/accepted.

## Owned paths будущей реализации

Пути ниже — границы принятого implementation plan, не разрешение artifact writer менять исходники. Общие файлы правит один назначенный владелец; никакого параллельного редактирования catalog policy/index.

L01: `.agents/tasks/20261024-herder-tool-catalog/task.md`.

L02: `src/mcp/catalog-policy.ts`, `src/index.ts`, `tests/mcp-catalog-policy.test.ts`, `tests/mcp-catalog-contract.test.ts`, `docs/mcp-catalog-migration.md`, `src/mcp/catalog-projection.ts`.

L03: `src/mcp/catalog-policy.ts`, `tests/mcp-catalog-policy.test.ts`, `tests/mcp-catalog-contract.test.ts`, `docs/mcp-catalog-migration.md`.

L04: `src/mcp/control-plane-tools.ts`, `src/common-settings/tools.ts`, `tests/mcp-read-tools.test.ts`, `src/mcp/catalog-policy.ts`, `tests/mcp-catalog-policy.test.ts`, `tests/mcp-catalog-contract.test.ts`, `docs/mcp-catalog-migration.md`.

L05: `src/mcp/catalog-policy.ts`, `src/mcp/catalog-projection.ts`, `tests/mcp-catalog-policy.test.ts`, `tests/mcp-catalog-contract.test.ts`, `docs/mcp-catalog-migration.md`.

L06: `src/mcp/control-plane-tools.ts`, `src/common-settings/tools.ts`, `docs/mcp-catalog-migration.md`, `src/mcp/session-tools.ts`.

L07: source/release paths пока не назначены.

## Сохранение WIP и совместимость

Foreign WIP найден в definitions.ts, cadence, web/server.ts, адаптерах, integrator файлах и тестах; не stage/reset/stash/commit его. Полный checkout не объявлять clean. src/mcp/session-tools.ts включается только после явного назначения владения. src/mcp-tools/definitions.ts не входит в owned paths; нужная интеграция согласуется отдельно. Работа только на main в каноническом checkout, без новых копий/worktrees.

Legacy профиль сохраняет исходные имена. Разрешённый скрытый endpoint остаётся callable; запрещённый вызов отклоняется до handler. Новые read tools не расширяют get-only права до list. Sync ожидает прежний результат, async возвращает job receipt. UNKNOWN/accepted не повторять. Алиасы удалять только после миграции callers и согласованного периода отсутствия legacy вызовов.

## RED → fix → GREEN и реальный потребитель

Для каждого среза сначала RED на ожидаемый tools/list и границы прямого вызова; минимальный fix; GREEN целевых catalog/contract тестов и соответствующих существующих MCP/control-plane/transport/delivery/resume/cadence/human-request/workspace suites. Проверять strict discriminator/неверные поля, отсутствие вызова mutation handler у наблюдателя, host-scoped workspace ownership, HumanStop и idempotency после потери ответа. После целевых проверок выполнить релевантную сборку перед release.

На реальном подключении сохранить полный tools/list с пагинацией, runtime revision, transport/profile/client version, байты схем и токены только с указанным tokenizer. Проверить session search и active inventory с coverage; выделенную тестовую сессию для steer и явной queue с receipt и независимым readback; безопасный async export с reconnect/readback и отдельно legacy sync; отрицательный вызов скрытого запрещённого endpoint. Не отменять чужие jobs, не трогать чужие сессии. Телефонные тесты не нужны и запрещены. Успех исходников, установки и потребителя доказывается отдельно.

## Порядок выполнения

L01→L02→L03→L04→L05→L06→L07. Optional 42-agent-profile не блокирует базовый результат 76. Политика advertisement изменяется одним исполнителем. Deployment/топология сначала сверяются с каноническим ServersAdministartion и актуальным release contract; runtime и release файлы этим artifact task не назначены.
