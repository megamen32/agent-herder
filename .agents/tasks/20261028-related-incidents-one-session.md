# Связанные инциденты продолжают одну сессию ремонта

Прямое поручение владельца 28.10.2026: новые тревоги одной проблемы должны
попадать в уже незавершённую OpenCode-сессию, вместо параллельного ремонта.
Ответственный: Codex `01a17ea3-5600-7580-aba9-1badd2187dd5`, server-100.

## Исправлено и установлено

Раньше operation_id зависел от incident_id: идемпотентность защищала повтор
одного события, но новый incident_id создавал другого исполнителя.

- `src/automation/incident-session-router.ts`: durable source-group binding,
  межпроцессная блокировка, резервирование до native-вызова. Группа определяется
  project/source_id/host_id/signal_type плюс фактические harness/cwd; заголовки,
  correlation_id и fingerprint образца не являются ключом ремонта.
- `src/index.ts`: существующие дорелизные сессии подхватываются только после
  сверки исходного native first-user-message. Приоритет — текущая работа,
  затем незавершённая idle-сессия; HumanStop не обходится созданием нового ID.
  Завершение подтверждается native/incident/autopilot/inventory readback;
  отсутствие связи не является разрешением на второго исполнителя.
- `src/named-session.ts`: verified existingSessionId проходит обычные gates;
  исчезнувший выбранный ID не заменяется автоматически новой сессией.
- Существующий per-operation admission journal сохранён: принятые/UNKNOWN
  операции не повторяются. Второй инцидент получает свой operation_id,
  тот же session_id и `coalesced=true`; input поступает через native steer.
- NoticePlace helper сохраняет исходную immutable-привязку автопилота;
  новый инцидент отдельно получает session callback, observer и progress.
  Каждая карточка закрывается собственным независимым подтверждением.
- Обнаружено при консолидации: OpenCode interrupt без `resume=false` мог
  возобновлять принятую steering/control работу. Штатный Stop теперь явно
  передаёт `resume=false`; RED показал отсутствие query-параметра, GREEN прошёл.

Installed Herder: `030eba573c9f33bfced625cbfd2b50752fa27340`.
Systemd ExecStart: release-local `dist/index.js` этого SHA, active,
PID 3022426, старт 28.10.2026 15:37:35 МСК.
`fleet-deployment-manifest.json`: тот же source_sha, source_dirty=false.
Installed NoticePlace: `e34e7749ef2c7ebea1dc00c5bd6c4e0f4e18f95a`,
release `/opt/noticeplace-releases/20261028T121632Z-e34e7749ef2c-2564204`,
API active. Существующие секреты, nine health flags и native OpenCode process
не менялись. Global incident model setting не редактировался.

Source опубликован в origin/main обоих проектов до установки. Shared WIP
NoticePlace (code-map, bin/notify-center, старые UI screenshots) сохранён.
В Herder сборки содержат опубликованные соседние fleet-fixes до c6646dc.
Публичные UI assets не изменялись: изменение относится к launch/runtime API.

## Реальная проверка двух инцидентов

Использован существующий QA consumer `noticeplace-qa-stop-20261023b`,
loopback-only HTTP fixture `127.0.0.1:39128`, отдельный cwd. Создание и mute
выполнены одной транзакцией установленного NoticePlace domain API. Каждый AI
action вызван ровно один раз через штатный `apply_telegram_action(..., ai)`.

| | Первый инцидент | Второй инцидент |
|---|---|---|
| incident_id | inc_c374f68601914345a3bec6b62353a020 | inc_e6cebc76ac0e492bb2c6a277367d1bad |
| operation_id | 4917ebfdb418c7b0082f59f4a5de1623 | de7a55c64e919552d7473cc7d351a3df |
| session_id | ses_e7d8bd234ffeWtxZF0AHPLM31E | ses_e7d8bd234ffeWtxZF0AHPLM31E |
| created | true | false |
| coalesced | — | true |
| delivery | sent | sent |
| final incident state | resolved | resolved |

Фактические native harness/model: OpenCode,
`omniroute/glm-5.3-flash-minimax-m3.1`, подтверждены native message model и
session readback. Модель взята из действовавшей настройки NoticePlace.
Autopilot enabled=true подтверждён после присоединения второго инцидента;
исходная привязка сохранилась. Между первым и вторым launch Herder был
перезапущен для установки фикса — durable source binding пережил restart.

Пользовательский результат: исполнитель воспроизвёл 503 `degraded`, обработал
новый инцидент в той же сессии, выполнил fixture repair, получил HTTP 200
`healthy` и опубликовал progress по обоим ID. Native user message второго
input: `msg_182793960001QjNeP0u7q6y1Vo`; последующий assistant прямо подтвердил
получение второго operation_id в своей сессии и восстановление сервиса.
Первое ограниченное ожидание fixture signal истекло во время выкладки;
исполнитель продолжил после второго сигнала в том же ID, без нового AI action.

Затем отдельный producer проверил HTTP 200/body=healthy и записал совпадающие
source fingerprints для каждой карточки. Verification events:
`evt_3aac7747fb8240aa988d4da12a56d49d`,
`evt_a407466350d5447baee848a10c57c246`.
Обе карточки прочитаны повторно как resolved. В QA deliveries только два
sent agent jobs и две cancelled Matrix-карточки; людям сообщений/звонков ноль.

QA route удалён через GET/PUT launch-policy с If-Match. Собственный QA
autopilot выключен после завершения, сессия остановлена, сервер PID2636530
завершён, порт39128 освобождён. Рецепты, receipts, verification.log и build
logs сохранены в `.tmp/incident-coalesce-20261028/` двух owning projects.
Build staging directories и три собственных промежуточных release удалены;
финальный030eba5 и предыдущийbb69dce сохранены. Контейнеры/worktrees не создавались.

## Существующие три сессии vusa

У всех трёх native original facts совпали:
project=fleet-health, source_id=fleet-health:vusa, host_id=vusa, signal_type=load.

- Продолжает общий ремонт: `ses_e7db9f4c0ffeBh3PLIf0Ul8vci`, autopilot=true.
- `ses_e7deca8f5ffexLuwUnqu5ggpRY` и `ses_e7dbd3844ffe6ybEYA9650sHzK` получили
  handoff/завершение, затем HumanStop-held и autopilot=false. Native active
  readback после явного interrupt?resume=false: оба отсутствуют; основной running.
- История, notes и WIP сохранены. Основному доставлены три исходных incident_id,
  результаты дублей и явное указание не возобновлять их. Native receipts:
  msg_1827a3f3d001sLzByERt4R7WtA, msg_1827a4124001AXA5hurTINKCAW,
  msg_1827a432f001rBippZH1o5zmLR; заключительное уточнение основному:
  msg_1827e690f001BknbbcQLGZ5iOY.
- Консолидация не означает, что production vusa восстановлен: это остаётся
  задачей продолжающейся основной сессии. Ни один production incident здесь
  не закрывался наблюдением модели.

## Адресные проверки и границы

30 Herder tests (source router: concurrent/restart/unknown/held/completed/legacy
adoption; real HTTP native seam forced-ID reuse/no replacement; project dispatch),
42 NoticePlace helper tests, 3 core Stop/rename tests; полные release builds
прошли. Окончательный приёмочный факт — описанные выше два реальных события,
одна native-сессия и два independently resolved incidents.

При неполных source fields инциденты не объединяются по одному заголовку.
Неизвестный исход создания остаётся fenced для source-group; автоматического
повторного launch нет. Отдельные источники/хосты/сигналы не объединяются.
Восстановление vusa не включено в заявление об успешном QA этого исправления.
