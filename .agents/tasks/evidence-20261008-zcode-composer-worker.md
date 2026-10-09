# Evidence: ZCode worker — composer outbox preview + steer/queue + сохранённый режим (2026-10-08)

## Delta по интеграционному review root (ход 2, тот же день)

Внесены все пункты review root (передано через Herder queue, не ACK):

- **capOutbox больше не теряет недоставленное**: лимит 50 применяется только к terminal-строкам
  (delivered/failed, срезаются самые старые); незавершённые (sending/accepted/deferred/pending/
  unknown) сохраняются все. Молчаливой потери нет; новой отправке не отказываем — cap режет
  только терминальные.
- **accepted не считается terminal-доставкой**: исключён из TERMINAL (TTL-прун и cap),
  добавлен в незавершённые → такие строки досматриваются polling'ом до исхода.
- **admissionUnknown проверяется ДО ошибок/ok===false** в classifyMessageDelivery:
  `{ok:false, admissionUnknown:true, error}` → unknown (не safe-retry failed); принятая
  native-ошибка не пересылается.
- **Bounded polling** GET `/api/sessions/:harness/:id/message-status?inputId=` (endpoint root'а):
  один active-session poll каждые 2с (setInterval + clearInterval cleanup на смене сессии/
  unmount), только незавершённые previews (isOutboxUnfinished), reconcile через
  `reconcileMessageStatus`; POST из polling-пути отсутствует физически (закреплено тестом на
  срез исходника). 404/502 статус-запроса = «no info»: после 3 промахов подряд строка честно
  становится unknown («Доставка не подтверждена»), не повторная отправка.
- **Reload reconcile**: сохранённые `sending` воскрешаются как `pending` («уточняю состояние
  доставки у сервера») и сразу опрашиваются через GET; авто-POST никогда.
- **job.state из GET**: failed → failed(nonRetryable, ошибка в «Детали:»), interrupted/cancelled
  → unknown с пояснением; прямое подтверждение delivered (admitted/turnId) исходом job не
  понижается. Вечного deferred больше нет.
- **GUI**: raw English/native текст сервера не основной — главная строка русский статус,
  детали сервера вторичной строкой под префиксом «Детали: ».

Правки только в моих файлах: `src/web-ui/composer-delivery.ts` (+reconcileMessageStatus,
isOutboxUnfinished, новая семантика cap/TTL/updateEntry со сбросом устаревших note/error,
revival→pending), `src/web-ui/main.tsx` (poll-эффект, outboxRef/statusMissesRef, «Детали: »),
`tests/composer-delivery.test.ts` (+7 тестов: порядок admissionUnknown, reconcile job-исходов,
cap хранит все незавершённые, accepted вне TTL-пруна, сброс stale note/error, polling-анкоры,
вторичность деталей; обновлён revival-тест).

Проверки по review root НЕ запускались (build/tests — единственный guarded прогон root).
Сделан только миллисекундный esbuild-парс трёх файлов (single-file, без артефактов): все OK;
анкоры тестов и отсутствие POST в poll-блоке проверены grep'ом.

---

Task marker: composer-worker-20261008-6f87fee7. Worker ZCode (sess_6f87fee7), root Codex
01a11b43-e944-7663-9ce8-d75df67c1167. Canonical repo `/home/roomhacker/agents-projects/agent-herder`, main.
Работа не коммитилась (root интегрирует и делает commit/push/deploy).

## Изменённые места (только моя зона ownership)

- `src/web-ui/composer-delivery.ts` (новый, 189 строк) — чистые помощники без React/fetch:
  типы `DeliveryMode`/`OutboxStatus`/`OutboxEntry`/`MessageDeliveryResponse`;
  `newInputId()` (crypto.randomUUID, fallback); `classifyMessageDelivery(payload, httpOk)` —
  маппинг ответа POST /message по контракту root'а; `deliveryConnectionFailure` (сеть оборвалась
  → unknown, не safe-retry); append/update/remove outbox-записей (upsert по inputId — повтор
  того же inputId не создаёт вторую строку и сохраняет позицию); persistence в localStorage
  (`agent-herder.outbox`, cap 50, терминальные >24ч прунятся, битые строки отбрасываются,
  записи `sending` после reload воскрешаются как `unknown` с предупреждением); предпочтение
  режима `agent-herder.delivery-mode` + флаг «Запомнить» `agent-herder.delivery-mode-pinned`
  (существующий паттерн `agent-herder.*` в main.tsx).
- `src/web-ui/main.tsx` (+85/−15 в пределах state/sendMessage/composer-рендера):
  - state: `deliveryMode`, `deliveryModePinned`, `outbox` (+persist-effect), отдельный
    `resumeSending` для кнопки «Продолжить» (раньше использовался общий `sending`);
  - derived: `activeOutbox` (записи активной сессии), `sending` = есть ли запись в статусе
    sending — больше НЕ блокирует композер;
  - `submitOutboxEntry`: сразу добавляет строку предпросмотра со статусом «Отправляется…»,
    шлёт `{ message, mode, humanRequested: true, inputId }` (fetch напрямую, не через api(),
    чтобы отличать «сервер ответил» от «сети нет»), классифицирует ответ, обновляет ту же
    строку; `sendMessage` очищает draft ДО отправки и не блокирует ввод/отправку следующих
    сообщений; `retryOutboxEntry` — ручной «Повторить» только для failed (тот же inputId,
    вторая строка не создаётся); `dismissOutboxEntry`;
  - рендер: панель `.composer-outbox` над композером (полный текст сообщения, режим, статус,
    ошибка/примечание рядом с конкретным сообщением), сегментированный выбор режима
    «В текущий ход»(steer)/«После ответа»(queue) + чекбокс «Запомнить» (сохранение личного
    режима по умолчанию). textarea и кнопка отправки больше не disabled на время полёта.
- `src/web-ui/styles.css` (+24) — селекторы `.composer-outbox*`, `.composer-mode*`, статусные
  цвета (delivered/failed), mobile-правило @media 900px.
- `tests/composer-delivery.test.ts` (новый, 245 строк, 24 теста) — юнит-тесты помощников
  (классификация всех веток контракта, уникальность inputId, порядок/upsert, persistence,
  cap/TTL/revival, preference round-trip) + source-ассерты на main.tsx/styles.css по образцу
  `web-ui-controls.test.ts` (нет hard-code `mode: "queue"`, композер не блокируется, предпросмотр
  до сети, draft очищается до сети, localStorage-ключи, both mode buttons).

## Статусы по контракту root'а

generic ok → «Сервер принял»; admitted/turnId → «Доставлено»; delivery:'deferred' →
«Ожидает окончания ответа»; pending → «Подтверждается доставка»; admissionUnknown/нет ответа
сети/неузнаваемый ответ → «Доставка не подтверждена» (+note: повтор может задублировать);
error/HTTP-отказ → «Не удалось» (+текст ошибки, ручной «Повторить» тем же inputId, если
nonRetryable не выставлен). Native-доставка по одинаковому тексту/timestamp не выдумывается.

## Проверки (bounded, без build/deploy — их делает root)

- `npx vitest run tests/composer-delivery.test.ts tests/web-ui-controls.test.ts --maxWorkers=1`
  → 2 файла, 42/42 passed (web-ui-controls не сломан, включая структурный ассерт
  activity-line → composer form).
- `npx tsc -p tsconfig.json --noEmit --declaration false` → 0 ошибок в web-ui/composer-delivery.
  Единственная ошибка в чекауте: `src/session-supervisor.ts(433,11) TS2367` — файл root'а,
  изменён параллельной работой root (queue/admission transport), мной не тронут.

## Короткая реальная приёмка (настоящий браузер, после интеграции/deploy root'ом)

1. Открыть сессию, отправить 2–3 разных сообщения подряд, не дожидаясь сети: каждая строка
   появляется сразу над композером со своим текстом и статусом; draft очищается; можно
   печатать и отправлять следующее, пока предыдущие «Отправляется…».
2. Переключить «В текущий ход»/«После ответа», отметить «Запомнить», перезагрузить страницу:
   выбранный режим сохраняется (localStorage `agent-herder.delivery-mode`).
3. Reload во время «Отправляется…»: строка не исчезает, становится «Доставка не подтверждена»
   с предупреждением; кнопки повторной автоотправки нет.
4. Повторно идентичная задача = отдельная строка с новым inputId; «Повторить» у failed
   обновляет ту же строку, не добавляя вторую.
5. steer до серверной поддержки root'а честно даёт «Не удалось: mode must be queue or sync»
   рядом с сообщением.

## Неопределённости / решения за root

- Сервер сейчас принимает web-роут `/message` только `queue|sync` (server.ts:1170): steer
  из UI до транспорта root'а будет честно падать строкой failed. Root параллельно вносит
  `src/web/server.ts`, `src/session-supervisor.ts`, `src/user-message-delivery.ts` (+свой тест).
- Кнопка «Повторить» показывает/шлёт тот же inputId — дедуп на стороне сервера ожидается от
  inputId-forwarding root'а; UI повтор не «безопасный» для unknown-строк (скрыт для них).
- «Запомнить» хранит личное предпочтение человека в localStorage браузера (не глобальная
  автоматика, не межагентный steer) — как требовал tracker.
- Resume-режим («Продолжить») использует свой `resumeSending` и прежний endpoint `/resume`
  без inputId — не входил в задачу, поведение сохранено.
- Vite build не запускался (deployment-affecting по docs/web-ui-validation.md) — его и
  browser-приёмку выполняет root под своими locks.

Root correction: worker referenced queue|sync validation of the named new_or_resume route, not the /sessions/:harness/:id/message consumer. The existing actual message route already maps mode steer; its current native support is Codex-only. Root gates unsupported ZCode steering and implements managed human queue/jobs/inputId in the real message route. Source reflection assertions removed; data/state regressions and actual HTTP path cover the behavior. Root integrated polling cleanup, one in-flight poll, terminal-only50 retention, quota admission, HTTP ordering and fresh active-key guard. Native group restart remains forbidden.
