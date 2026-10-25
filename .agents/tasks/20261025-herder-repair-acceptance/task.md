# Ремонт Agent Herder: результат и оставшаяся граница nginx

Сессия: `01a172c2-3daf-7190-82ef-639dea9dc8d2`, `gpt-6.1-sol`, server-100.
Исходный checkout сохранён; работа выполнена в разрешённом worktree `repair-20261025`.

## Результат

[Канонический HTML-план](https://lhc.bezrabotnyi.com/agent-herder/plan-20261025-1523-617aa44029ef0090f8e68201/) опубликован и прочитан HTTP200.

Backend и публичный UI: `478e22b965013faf7d43d30df92f626ab5ceb3df`.
Установленный PID: `2847808`. Штатная приёмка `accept-node.py`: **21/21**.
Публичный vhost: infra commit `7075e4feca9ac42d200e1ad3e43108b503ce6d16`.
`nginxctl refresh/check/apply --site agent.bezrabotnyi.com` прошли; rollback `/var/lib/nginx-dev/rollback/20261025T121518Z`.
SSO сохранён: публичный браузер получает штатный переход на auth. Проверка интерфейса выполнена на том же приложении через loopback; авторизованный публичный вход не имитировался.

| Сессия | Exact native ID | Причина остановки | Проверено после установки |
|---|---|---|---|
| Herder | `session_169d99b5-60fc-40cc-bd74-c5f17d3a3cf5` | Разрешение для Bash, `perm_a9aa5066-2a63-4252-b114-82d419d849ee` | needs_input, 3 сообщения, история доступна |
| Broker | `session_d609b412-12d2-44c0-999e-507aba8daba1` | Новое разрешение ctx_execute, `perm_67c91186-223f-4ff5-af8b-02266750504b` | needs_input, 3 сообщения, история доступна |
| Voice/Notice | `session_4af62dcc-f19a-4e36-b093-7f5835b179d0` | Разрешение ctx_search, `perm_c3c6222f-d344-4030-8c6f-f8b052fa44f2` | needs_input, 3 сообщения, история доступна |
| Airlock | `session_de68d80a-1f26-409b-9ae8-2f61ff0baad9` | Разрешение ctx_batch_execute, `perm_eef10dd5-5c34-4ca9-b376-e87227960814` | needs_input, 3 сообщения, история доступна |

Для всех четырёх модель `account:zai-individual-coding-plan/GLM-5.3-Flash$high`, runtime host server-100. Решение по каждому запросу остаётся человеку: на сайте установлена кнопка «Разрешить» для однократного ответа текущему запросу. Старое once-разрешение Broker не распространялось на новый запрос. Broker P0 не переотправлялся.

## Что исправлено

1. Принят готовый scoped фикс `43efcf7` существующего ремонтника, без дублирования его работы: native permission snapshot имеет приоритет над running-tasks; Fleet читает существующий official runtime без активации.
2. Список ZCode перестал принудительно возвращать running при pending permission; bounded cache подтверждён native snapshot, PID и generation. Срок свежести обновляется вместе с подтверждением состояния.
3. Точечный quick-read ZCode больше не перечисляет все соседние сессии перед чтением выбранной. Это устранило native read deadline и занятые read slots.
4. Старый чужой стенд PID2493935 на18957 записывал общий active-inventory под host100. Рабочий сервис получил отдельные пути **существующих** inventory файлов в `autopilot-live`; ownerPid UI/MCP теперь совпадает с PID сервиса. Стенд не останавливался и не присваивался.
5. По новому поручению пользователя огромный banner заменён строкой30px над чатом. По умолчанию свёрнута; клик слева раскрывает инструмент, host/harness/native ID, request ID и время проверки. Кнопка «Разрешить» отвечает однократно без изменения постоянных прав. Приняты готовые серверные guard-коммиты существующего API-ремонтника: свежая exact session/host/request, межпроцессный lock и durable no-replay для accepted/UNKNOWN.
6. Очередь стала компактной строкой над composer: раскрытие слева, «Скорректировать», редактирование и отмена. Редактирование переносит текст в поле; отправка выполняет PATCH той же записи с проверкой исходного текста. inputId/jobId/createdAt и порядок сохраняются, новый native send не создаётся. Начатый native вызов и UNKNOWN не редактируются.

Приёмка очереди на установленном приложении через собственный браузер: создано одно сообщение после ответа в ЭТУ активную ремонтную сессию; раскрыто, отредактировано, сохранено с тем же inputId `329d1871-95ee-489e-a9db-67112ff300f8` и job `job_cc18ca3f823710743c127cf77d99ac0e05d94732572a922e007aca5ceb17c7fc`; затем отменено кнопкой. Сервер подтвердил cancelled/notSubmitted, UI очередь пуста. В бизнес-сессии тестовый текст не отправлялся.

Новый bounded цикл: **57 тестов**, `tsc --noEmit`, production build зелёные. UI проверен браузером, сделаны скриншоты compact-permission.png, permission-expanded.png, queue-collapsed.png и queue-edited-expanded.png. Кнопку одобрения реальных business permission агент не нажимал; её exact/no-replay путь проверен9целевыми тестами. При первом параллельном MCP чтении Airlock был transient unavailable, отдельный exact retry прочитал3сообщения. Начальная история Codex при прогреве тоже была unavailable, свежий read и повторное открытие сессии сработали; ошибки не считаются пустой историей или полезной running-работой.

Проверки: RED→GREEN для списка, exact quick-read и обновления TTL; 12 тестов затронутых путей, затем отдельная TTL-регрессия; `tsc --noEmit` и сборка зелёные. Полные suites не повторялись.

Доставка: `herder-repair-20261025-final-release-v3` принята в уже активный turn `01a172d4-cd99-7463-8230-1019376fc015`. Readback получателя показывает user item `herder://m/fce9aa85`; повторов нет. Неактивные задачи и исходный OpenCode не пробуждались; четыре бизнес-сессии не возобновлялись; звонков нет.

## Полная синхронизация nginx — точный блокер

Наш vhost выпущен отдельно из проверенных source inputs. Использован временный Git index на актуальном remote main: опубликованы только три строки pin и checksum этого vhost; основная ветка, индекс и чужой WIP канонического checkout сохранены. Новой ветки/worktree nginx не создавалось.

Автоматический sync сейчас отказывает на dirty nginx-dev. Кроме того, каноническая Git-линия разошлась на16 local-only/537 remote-only commits. В nginx-dev остаются чужие `new.auto-gram.ru`, `lhc.bezrabotnyi.com` и generated manifest. Общий deployed SHA остаётся `57716785aa315772d1c7695e06f76f31570932ba`; он **не** выдан за SHA нашего отдельного site apply.

Managed live drift вне Herder:

- Только live: `conf.d/vpn-panel-log-format.conf`, `sites-available/acme-fleet-catchall.conf`.
- Изменены live/source: `android-mcp.bezrabotnyi.com`, `became.bezrabotnyi.com.conf`, `excode.bezrabotnyi.com`, `helper.bezrabotnyi.com`, `vpn.bezrabotnyi.com`.
- Только source: `sites-available/simplysmeta.bezrabotnyi.com`, `sites-enabled/simplysmeta.bezrabotnyi.com`.

Минимальный следующий шаг — сверка live/source владельцами этих сайтов и публикация их WIP, затем согласованное объединение Git-линий. Полный nginx apply, stash/reset, force-push и выбор чужой конфигурации вслепую не выполнялись.

Notice Place уже подключён через существующий OnFailure. Read-only mesh подтвердил открытый инцидент `inc_55aaf7978b0c40ae8cfa2c496e3dd447`, отсутствие mute и последние `telegram.main: sent`. На момент проверки incidents.occurrences=8550, то есть уведомление не отсутствовало; новая отправка/новый watchdog не создавались.

## Артефакты

- [План](plan.html), [машинная квитанция](receipt.json).
- [Herder](screenshots/herder.png), [Broker](screenshots/broker.png), [Voice](screenshots/voice.png), [Airlock](screenshots/airlock.png).
- [Повторяемый scoped Git publish](publish-nginx-pin.py), [inventory drop-in](20-repair-inventory.conf).

## Plan

Цель: восстановить управление четырьмя существующими ZCode через UI/MCP и проверить ограниченный выпуск.
Бизнес-результат: Herder опубликован и проверен; полная синхронизация nginx имеет отдельный точный блокер.
Декомпозиция: 4 листа · 1 параллельно · 2 волны · слотов: 1

✅ L01 · Установить готовое исправление и проверить управление четырьмя ZCode
⛔ L02 · Сверить полную синхронизацию nginx и уведомление о её блокировке · зависит: L01
✅ L03 · Сделать компактный запрос разрешения с кнопкой на сайте · зависит: L01
✅ L04 · Сделать компактную очередь с правкой существующего сообщения · зависит: L01
