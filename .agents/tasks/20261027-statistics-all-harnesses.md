# Статистика Codex + OpenCode — 27.10.2026

## Результат

Обычная страница «Статистика» открывается без зависания, по умолчанию объединяет
сохранённые данные Codex и OpenCode (ZCode при том же native-контракте), позволяет
посмотреть каждую среду и период7/30/90дней. Неполное покрытие явно подписано.
Ранее принятый disk fix b76e435 и все runtime policies сохраняются.

## План и ownership

1. Backend worker project_switch_backend: только src/session-statistics.ts и
   новые session-statistics-* modules. Потоковое чтение, readonly nativeSQLite,
   compact stamp cache, агрегат и per-harness цифры; тяжёлый расчёт вworker,
   мгновенный last-good/ожидание+progress, singleflight приrefresh.
2. Root: src/web-ui/main.tsx и src/web/server.ts еслинужно. Объединённые карточки,
   выбор среды, coverage, polling без устаревшего ответа и повторного расчёта.
3. Root один: scoped main push/build/immutable install/static pin, actual
   browser путь той же страницы, повторный cache/HTTP/I/O readback.

Критический путь backend→общая сборка→установка→браузер. UI идёт параллельно.
Не создаём новые source copies/ветки, не меняем native DB, provider/settings,
не запускаем модели/уведомления/сессии. Чужой WIP сохраняется. По developer
инструкции suite/tests не добавляются и не запускаются; доказательства —
сборка и действующий API/UI с сохранёнными данными.

## Начальная диагностика

getAgentActivityStatistics читает каждый Codex JSONL readFile/split на main
thread, только Codex; OpenCode присутствует лишь в дешёвом capped portfolio.
GET days7 не ответил за12s, затем cache создался15:33:43UTC:749файлов,
228225toolCalls. Diskcache30d устарел25Oct. UI snapshot/screenshot независимого
read-only посетителя: /tmp/st27-statistics-after-12s.png — perpetual spinner,
нет карточек или выбора периода. Refresh не повторяли.

Shared AgentMemory recall выполнен scopeagent-herder; полезных решений не найдено.
Canonical main чист по tracked files доработы; ownership note dc5bb590-d222-417b-a619-0a9819065615.

## Дополнение владельца: навигация и текущие источники

Первый установленный срез 78385e3 принят через UI: агрегат, среды, периоды.
Остаток: OpenCode v2 session_v2/session_message вместо остановившегося legacy,
per-session reuse при изменении WAL, ограниченный retry обычного чтения статистики.
Старый агрегат инвалидируется отдельно, Codex source cache сохраняется.

Владелец добавил конкретные UI-дефекты: пустой работающий ZCode-фильтр маскируется
скелетонами; ссылки автоматики загромождают список; дублирующие collapse-кнопки;
у разделов нет копируемых URL; неясный раздел задач; ошибка чтения машин и
непонятное разрешение выбранной модели проекта.

Root владеет main.tsx, codex-navigation.tsx, rag-search-view.tsx,
settings/settings-screen.tsx, session-statistics.ts и выпуском. Backend worker
владеет statistics-sources.ts и ограниченным исправлением fleet/project model
компонентов/API. Настройки/выбранные модели не меняем. Работающие сессии не
запускаем, не останавливаем и не повторяем прошлые действия.

Потребительский критерий: переход по ?page=statistics/search/machines/projects/settings
восстанавливает раздел, назад/вперёд работают; поисковая ссылка сохраняет запрос
и фильтры; «Чаты» на рейке открывает/закрывает панель; пустой фильтр объяснён и
сбрасывается явно; автоматика доступна из настроек. «Задачи» называются
«Операции»: это журнал фоновых действий Herder, не проектная доска.
