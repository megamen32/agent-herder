# OpenCode: автовосстановление и квотный fallback

## Настройки, применённые штатным API

- 2026-10-28 18:06:26 МСК: `PUT /api/session-autostart/harnesses/opencode {enabled:true}`; независимый GET подтвердил `enabled:true`, источник `harness`. Общий выключатель и индивидуальные запреты сессий не менялись.
- `fallbackForQuota:true` уже был установлен для OpenCode; `waitForQuota:false` сохранён.
- Исправлен вырожденный список запасных моделей: прежний список состоял только из текущей default-модели `omniroute/minimax-combo-m3.1`. Через If-Match установлен порядок из уже существующих разрешённых маршрутов: `omniroute/glm-5.3-flash-minimax-m3.1`, `omniroute/minimax-combo-m3.1`. Default и модели текущих сессий не менялись. Независимый GET подтвердил список, ETag `02c7e7d8bc5509c579d1c1e6a1838505`.

## Исправление исходников

Обычные turn-записи OpenCode удалялись `pruneAutocontinueScope`, а цикл восстановления пропускал их: предикат ограничивал обычное восстановление Codex/ZCode. Добавлен отдельный предикат нативного восстановления; семантическая инвентаризация и её планировщик не расширялись.

Добавлен ограниченный подхват ошибок OpenCode за последние 24 часа: только свежий exact failed turn с user ID, подтверждённым retryable HTTP 408/5xx, отсутствием более позднего успеха, busy, вопросов, разрешений, inbox и HumanStop. Не более 16 свежих чтений за цикл; неизменившиеся снимки кэшируются 5 минут. Plain idle не считается сбоем. Перед отправкой повторно проверяются тот же turn/user/model и возраст ошибки.

Наш core protocol client читает штатный native inbox и отказывает при непустом, некорректном или недоступном ответе. Native seam проверен read-only официальным CLI: `opencode api GET /api/session/<id>/inbox` вернул `{data:[]}`. Публичные типы/экспорты контракта не менялись.

## Проверки исходников

- RED: exact OpenCode turn удалялся из реестра, отправок было 0 вместо 1.
- GREEN: `tests/opencode-native-recovery.test.ts` — восстановление один раз, отсутствие повтора, idle/старше 24 часов/pending/session-off не продолжаются.
- RED → GREEN: точечный V2 linear-packet test отвергает непустой и некорректный inbox.
- Итого выбранные проверки: 6 passed, остальные тесты этого файла не запускались.
- Общий TypeScript запуск обнаружил постороннюю ошибку `src/web/server.ts` около строки 2137: `noticeAttempt` может быть `{}`/`null`; этот путь исполнитель не менял. Это не PASS общей компиляции.

## Реальные недавние сессии: отправок 0

Ограниченная выборка 500 из 1874 сессий неполна. В ней 32 OpenCode-сессии моложе 24 часов: 5 running, 25 idle, 2 error.

Обе ошибки — старые NoticePlace-исполнители, их сценарий повторно не запускался:

- `ses_e805d6cc5ffegQFxwSAyJ2AbGj`: latest user `msg_17fa296cc001eLyBDYCseuDdl7`; metadata.agentHerderInputId присутствует. После него 7 assistant-сообщений; последнее failed assistant `msg_17fb10f08001Vw79ynRH2nMhcu` не содержит parentID.
- `ses_e80ba367dffewij7NEsdB7clLw`: latest user `msg_17f45ca0d0011KhlpFhzA3Bjkz`; metadata.agentHerderInputId присутствует. После него 78 assistant-сообщений; последнее failed assistant `msg_17fb11515001TJrcizcSjSHQG4` не содержит parentID.

У обоих свежая терминальная причина — `provider.auth`, текст содержит отказ авторизации/invalid_grant, внешняя оболочка status=200. Это не quota и не разрешённый автоматический retry. Проблема не в отсутствии нашей metadata: она есть. Отсутствуют достаточная связь последнего assistant с конкретным user и разрешение автоматически повторить auth-ошибку. Никакие их accepted/UNKNOWN вводы не повторялись.

### Уточнение по прямому вопросу владельца об авторизации

Это исторические ошибки `2026-10-27T23:29:57.843Z` и `23:30:09.330Z` (28.10, 02:29–02:30 МСК). Оба native assistant выбрали `omniroute/minimax-combo-m3.1`, variant default. Безсекретный текст: `mmcode/MiniMax-M3.1-Flash: HTTP 401; MiniMax token refresh rejected HTTP 400; invalid_grant — this refresh token can no longer be used, start a new authorization`. Отказал вращающийся OAuth refresh-token MiniMax Code gateway, не Herder Bearer и не денежный баланс.

Текущий live route readback отличается от исторического: `minimax-combo-m3.1` разрешается только в `minimax/MiniMax-M3.1-Flash` (ветки mmcode уже нет), а `glm-5.3-flash-minimax-m3.1` — в независимые `zcode-start`, `zcode-individual`, `glm` и `minimax`. Поэтому старая ошибка не доказывает нынешнюю поломку всего combo. Переход на независимый GLM-маршрут способен обойти старый OAuth-отказ без ремонта самого MiniMax Code.

Свежая официальная read-only квота в 18:43:17 МСК: GLM reported, remaining interval 18 397 / 28 000, weekly 81 652 / 140 000; MiniMax Token Plan reported 49% interval и 52% weekly. Это наличие allowance, не доказательство ответа реального native fallback и не подтверждение работоспособности старого mmcode OAuth. Старый принятый ввод не повторялся; бесконечный повтор auth-ошибки не включён.

## Изолированная приёмка

Root разрешил один новый собственный native OpenCode server/config, локальный тестовый provider с контролируемым 429 и затем один fallback на реальный разрешённый combo; только benign marker в `.tmp/opencode-recovery-qa-20261028`.

Приёмка остановилась ДО создания сессии и ДО любого provider input:

1. `serve --standalone` не поддерживается v2.1.4. Убран только этот аргумент; отдельный `serve --hostname 127.0.0.1 --port <own>` с отдельными XDG config/data/state/cache успешно запускается.
2. Native catalog содержит `qatest/quota`, но не содержит `omniroute/glm-5.3-flash-minimax-m3.1` из переданного exact provider entry действующего config.
3. Штатный CLI `auth import --server <own-loopback>` принял credential через stdin, но это НЕ подтверждает регистрацию/активацию provider. После `reload --server <own>` каталог по-прежнему содержит только `qatest/quota`; exact `auth export omniroute --server <own>` отвечает `Integration not found: omniroute`; private `/api/provider` не содержит omniroute. Это точный неработающий переход: private provider declaration/import → native registration/activation/catalog.

Не заменяли этот путь чужим provider alias, не правили production OmniRoute/native OpenCode core, не вызывали первичный реальный provider до исчерпания квоты. Ни QA-сессии, ни initial input, ни fallback input, ни marker ещё не созданы; выполненных native/provider input отправок 0. Следовательно, controlled quota → native fallback → marker НЕ проверен и PASS не заявляется. Нужен штатный native API registration/enable contract для private provider; повторять import/новый стенд ради статуса нельзя.

Все собственные приватные серверы и loopback 429 handlers закрыты. Приватная SQLite-база fixture удалена после остановки процессов (сессий/принятых input в ней не было), чтобы не оставлять импортированную тестовую копию credential. Read-only production credential reference остался прежним: `cred_14504c8160016QLQlBiJXwL6Pp`, integration `omniroute`, active=true; значения credential не печатались. В журнале не следует трактовать промежуточный технический stage `isolated-provider-active` как доказательство активации — он отражал только успешный CLI import и исправлен этим отчётом.

## Принятый узкий native backup canary — 28.10, 18:54 МСК

После прекращения private bootstrap Lead разрешил один response-only ввод через СУЩЕСТВУЮЩИЙ native OpenCode. Создана только собственная сессия `ses_e7cc8fce8ffeo2SPpSIQPEcMXK`, cwd `.tmp/opencode-recovery-qa-20261028`. До ввода независимые GET подтвердили exact-session AP=false и autostart=false, waitForQuota/fallbackForQuota=false; native PATCH deny-all permissions подтверждён GET. Собственный AGENTS ограничен ответом без инструментов/действий.

Единственный input `qa-backup-response-20261028-ses-e7cc8fce8` принят как native user `msg_18337b1e2001f4tEetJ7b0sisU`. Native assistant `msg_18337b24f0013tS613aYLDRoFd` завершился 2026-10-28T15:54:17.420Z, exact model `omniroute/glm-5.3-flash-minimax-m3.1`, final text `QA_BACKUP_OK`, finish=stop; последующий idle `msg_1833825df001oYxKTFummFoL62` outcome=succeeded. Tools=0, snapshot.files=[], native cost=0. Native receipt не содержит фактическую ветку router: выбор GLMcombo доказан, конкретный downstream leaf не заявляется. Безсекретная квитанция `backup-native-receipt.json` сохраняет только финальный текст, идентификаторы и настройки, без reasoning.

Повторный readback automation=false после ответа сохранён. Сессия оставлена idle с историей; повторов, архивирования и новых запусков нет. Private серверы ранее закрыты, production provider/config/auth не менялись.

Отдельный focused test `uses current allowed GLM combo once when the default MiniMax combo has exhausted quota` на existing controller с текущими точными моделями/порядком политики прошёл: 1 passed, 77 skipped. Подтверждено: синтетическая quota failure MiniMaxcombo → разрешённый GLMcombo ровно один раз, исходная модель исключена, повторный recoverPending не повторяет accepted отправку.

Граница доказательства: реальный ответ запасного combo и isolated controller decision подтверждены раздельно. Полный native 429 → автоматическое переключение → реальный ответ в одном native canary НЕ подтверждён; не следует выдавать два отдельных среза за него. Private provider activation blocker больше не блокирует доказанный backup response, но остаётся ограничением предыдущего полного стенда.

Lead независимо подтвердил оба старых NoticePlace incident `inc_d9b…` / `inc_2cbe…` уже resolved; их не продолжали. Историческая auth ошибка сама по себе не объясняет текущее поведение, поскольку нынешний route изменился и независимый GLMcombo сейчас реально отвечает.
