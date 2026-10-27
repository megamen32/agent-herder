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

## Установленный совместимый срез

1c62467c546876c124ad7aeccd69f01a48ffd11b опубликован в main; TypeScript и
npm build/plugin/package checks прошли. Suite/tests не запускались.
Immutable bundle 0ade62209222df3f0b7f91162a98d04e11eaab6d4163068edfe21d77fe352f11;
Herder PID3310742 start19:47:33MSK, runtime entrypoint exact release.
Policy ETag c4d46cbefd965e8eb4e21d1426355edd/settings hash сохранены;
events23575963 persisted→23575981 restored. Public pin dea27e40, no managed drift.

30d readback16:49:23UTC:4385 sessions =929Codex+2390OpenCode+1066ZCode.
Exact ses_e8ab75780ffeqDhM84IXxDabXN присутствует в V2 source cache;
3551 per-session envelopes, старый Codex cache не инвалидирован.
7d следующий cached-source расчёт18.472s:778Codex+2372OpenCode+96ZCode,
все источники ready. Process counters этого окна:1432MiB physical reads,
27.23MiB writes,5680MiB rchar. Это общий процесс вместе с индексатором,
не отдельный замер статистического worker и не доказательство постоянного I/O.

Конкретный независимый остаток model route: exactcombo proof409, underlying
OmniRoute catalog401/403; Herder process credential не принимается текущим
API, management endpoints требуют отдельный management credential. Выбранный
combo/policy не менялись. Source даёт явное разрешение выбранной модели только
при notAllowed; unverified объясняет проверку каталога, не требует смены модели.

## Финальный узкий follow-up: catalog auth и owner SSO

Браузер st27 подтвердил 1c62467: Chats toggle, automation settings location,
page URLs/back/forward, восстановление поисковых параметров, V2 statistics.
Также нашёл реальный 401 fleet API при homepage200. Публичный nginx использует
существующий signed GPTAdmin SSO; Herder требовал отдельно HAOS cookie. На100
проверяем точную owner identity через действующий local checker, сохраняя HAOS
как существующую authority. Никаких caller identity headers и fake owner ID.
При отказе UI не выдаёт незагруженные placeholder rows за проверенные машины.

OMNIROUTE_API_KEY из старого Herder процесса невалиден. Штатный existing native
OpenCode auth key даёт inference catalog200; отдельный local machine-bound CLI
credential даёт management catalog200. configure-catalog-auth.mjs сохраняет
их в существующий private Herder env без вывода/ротации и с no-replay backup;
explicit adapter constructor seam отделяет два auth class, CLI header loopback-only.
Resolver понимает authenticated management combo members, которых нет в
scoped inference catalog, и разные terminal model IDs; конфликты/alias/cycles
по-прежнему отказываются. Нативные/provider source не меняются.

Фактическая выбранная combo имеет zcode-start/glm-5.3-flash,
zcode-individual/glm-5.3-flash, glm/glm-5.3-flash, minimax/MiniMax-M3.1-Flash.
Owner-selected GLM family добавлена строго для этих двух ZCode providers и
точного glm-5.3-flash в canonical leaf policy; generated plugin/core copies
синхронизированы. Не разрешаем произвольный ZCode model/provider; закрытые
Codex/Claude/Anthropic остаются закрыты. Web verdict использует тот же helper.
Это не запуск LLM и не доказательство native execution; только catalog proof.

48ca2c09644b885d07a6c0c41152135202219743 installed/public; build/manifest/package
checks passed. Bundle a4ed0b2401d21aaf06e52425f28b692a148a6e1d61d6f459cdf7ae03ed11f852;
vhost d57f8d45, rollback20261027T170757Z, no managed drift.
Browser st27 на этом срезе под testlogin получает законный owner-only401,
видит явный отказ доступа без фиктивных «Нужна проверка». Это не owner readiness
acceptance. Ранее UI принял URL/reload/back-forward/search filters/Chats toggle.

Дополнительно найден устаревший Herder Basic password для official OpenCode.
Четыре public default model IDs оказались hardcoded fallback клиента при401,
а не реальным каталогом. configure-native-auth.mjs подтвердил current protected
native credential GET /api/config200 и обновил только Herder credential;
native PID2830250 не рестартован. Herder PID3887700 start20:11:59MSK,
тот же compiled48ca2c0; launch policy/settings preserved.
Native v2 каталог содержит оба точных combo IDs. Значения23символа sha256:...
в /proc initial environ — fingerprints; loadSecretEnvironment разрешает их
до init adapters. Не считать такие markers сырыми токенами и не утверждать
credentials mismatch по одному /proc. Exact combo verdict покаunknown;
следующий шаг — resolved-secret compiled resolver, точная строка отказа.

Последний parser defect подтверждён resolved-secret read-only проверкой:
OmniRoute catalog1383rows/1372uniqueIDs,11 повторов с одинаковыми routing
metadata,0 конфликтов. Парсер отказывался от всего каталога. Теперь одинаковые
owner/root/parent дубликаты схлопываются, различающиеся по этим полям
по-прежнему отклоняются. In-memory source validation разрешила обе exactcombo
в ожидаемые leaves и получила200 всех каталогов; final install/readback далее.
Shared Herder OpenCode client больше не выдаёт hardcoded GPT/Gemini/DeepSeek
модели за доступный каталог при ошибке чтения: возвращается пустая выборка.
