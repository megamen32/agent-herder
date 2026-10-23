# Быстрый список активных сессий и реальных мест работы

Режим: fullcycle. До: исторический ограниченный список и место запуска скрывают активные Mavis-сессии. После: одна быстрая команда возвращает активные сессии всех пяти компьютеров, отдельный компьютер исполнения и все подтверждённые места изменения кода. Основной фильтр выбирает место работы; неизвестность остаётся явной.

## Plan
Цель: пользователь одной командой получает текущие активные сессии всей сети и реальные абсолютные пути изменения кода без исторического сканирования при запросе.
Бизнес-результат: правильный глобальный список и количество; у каждой сессии отдельно компьютер исполнения и один или несколько подтверждённых рабочих каталогов.
Декомпозиция: 6 листьев · 3 параллельно · 4 волны · слотов: 3

✅ (Исследовать живую активность Mavis и доказать ошибку списка) начата 21:07 закончена 23:01, оценка 15 минут, факт 114 минут
  Описание задачи: active_minimax_truth исследует native activity и исправляет наблюдатель MiniMax без вывода активности из persisted status.
  Приёмка: native/GUI evidence и RED→GREEN; TTL и неизвестность явно представлены.
✅ (Восстановить подтверждённые места изменения кода) начата 21:07 закончена 23:16, оценка 15 минут, факт 129 минут
  Описание задачи: active_workspaces восстанавливает несколько рабочих каталогов с hostId и источником, используя существующие декларации.
  Приёмка: удалённая работа на server100 не превращается в M1 или каталог ~/.minimax.
✅ (Собрать быстрый глобальный API и MCP) начата 21:10 закончена 23:08, оценка 20 минут, факт 118 минут
  Описание задачи: active_inventory_product создаёт материализованный текущий список; фильтры до пагинации, компьютер работы отдельно от компьютера исполнения.
  Приёмка: list_active_sessions без hostId охватывает все пять компьютеров; запрос не сканирует историю.
✅ (Интегрировать и доставить на пять компьютеров) начата 21:40 закончена 23:16, оценка не измерено, факт 96 минут
  Описание задачи: сохранить чужие изменения и фактические версии сервисов; опубликовать только owned paths в main.
  Приёмка: installed readback каждой машины и сохранность чужого WIP.
✅ (Независимо сверить реальную активность и время команды) начата 21:49 закончена 23:11, оценка не измерено, факт 82 минуты
  Описание задачи: независимая GUI/native сверка и три последовательных измерения без LLM внутри критического времени.
  Приёмка: два бизнес-результата подтверждены; частичные и неизвестные состояния не маркируются PASS.


✅ (Исправить видимость официального текущего экземпляра ZCode) начата 21:54 закончена 23:11, оценка не измерено, факт 77 минут
  Описание задачи: active_sessions_review выполняет новое прямое поручение пользователя: official control.sock running-tasks имеет текущую сессию и двух детей, старый stdio смотрел другой экземпляр.
  Приёмка: RED→fix→GREEN и отдельная реальная потребительская проверка; текущая native identity имеет приоритет над историческим completed.
  Затрагиваемые файлы: src/adapters/zcode.ts, src/adapters/zcode-server-control.ts, tests/zcode-official-running.test.ts.

## Итог принятого результата, 23:16 МСК
Одна команда `list_active_sessions({})` читает материализованный глобальный index и по умолчанию охватывает все пять компьютеров. `hostId` выбирает компьютер изменения кода по любому подтверждённому workspace; `runtimeHostId` отдельно выбирает компьютер GUI/исполнения. Ответ содержит все строки без неявного исторического окна100, несколько абсолютных путей, evidence/timestamps, roots/children, freshness, partial и unknown. Неполнота не маскируется exact0.

Независимая API/MCP приёмка9cff: 38 одинаковых ID/поколений на HTTP и MCP; все5 owners available. Три строгие последовательные проверки без LLM/sleep внутри таймера: ALL HTTP+MCP0.051948с; фильтры code/runtime0.016230с; selected native/workspaces/ZCode и M1-origin ALL2.108505с, всего2.176823с. Root HTTP отдельно5.878мс. Последняя проверка включает SSH до M1 и native evidence; это не обещание каждого запроса меньше100мс. Независимый32.8974с hold: все5 available, все owner timestamps/index mtime продвинулись через3поколения,0expiredactivityrows, одинаковые PID. M1 localHTTP на занятом хосте0.912–2.293с; прежних deadline/потерянных owners в проверенном интервале нет. Старые FAIL и raw полностью сохранены в tester2.md/tester2-benchmark-raw.json.

После этого установлен только100 owner-core parent-normalization delta2a438e0: два query-модуля byte-identical9cff; изменённый native-parent boundary отдельно проверен exact existing native thread/read без turns/history. ParentThreadId/parentID теперь доходят до workspace inheritance; явные собственные/пустые декларации детей защищены,14focusedGREEN/tscGREEN. One-shot actual parent proof добавил5деклараций без restart; только1изэтихсессий оставалась активной при первом readback, остальные завершились естественно.

Финальный сохранённый snapshot `evidence/final-inventory-readback.json`: owner observations20:15:50.189–20:15:51.767UTC,36подтверждённых активных=19корневых+17дочерних; runtimeM1=17, workHost100=35, workHostM1=1. Совпадение по любому workspace не предполагает взаимоисключающих категорий. UnknownActivity0 и UnknownWorkspace0 именно в этом cohort; future unknown не скрывается. Partialtrue/activeCountExactnull сохраняются из-за неподтверждённой полноты отдельных native providers. Последний HTTP read38мс. Эти36 не подменяют более ранние38 независимой приёмки.

Версии:100 runtime2a438e006277eab5879e3919569f00a71de2a819;44/88/Mini/M1 runtime9cffc9efa0dfe05eed6eb67c2b9a21db877dba7e. Query-модули одинаковы. M1 managed observer helper SHA1dfa7c46a4c6f2d4991af9b3463e78e9ed2b6c964c22cf4c0504b148fb8a08fa; исправление bounded transient retry опубликовано в main, capacity quotas не повышены. Неактивные Mac payload сохранены вне active census с rollback receipts, не удалены. Native GUI/исходники MiniMax/ZCode не изменялись.

ZCode: доказана исходная ошибка другого stdio экземпляра; официальный control.sock + authenticated WS reuse current native identity. Собственная изолированная source-consumer canary отправлена1раз, native queue→turn→assistant marker completed через66с; user sends0/replay0. Установленные module bytes, existing-only native readback и discovery/delivery capability проверены отдельно. Тестовых звонков/голосовых уведомлений/сообщений владельцу0.

Чужой WIP сохранён. Для пересечений Codex/web использованы подготовленный отдельный index, настоящий index.lock, HEAD/index CAS и атомарная замена index; receipts содержат совпадающие foreign hashes. Чужие изменения не reset/stash/rebase и не включены в owned commits. Checkout не объявлен целиком clean. Source main2a438e0 опубликован; отчёты публикуются только scoped commit в каталоге этой задачи. Подробные прежние FAIL и исправления сохранены в tester2.md/raw и отдельных evidence receipts.

## Проверенные маршруты для повторного использования
- Native current MiniMax: src/adapters/minimax-code-active.ts — read-only accepted ingress + per-ID current controller, metadata cache только title/parent; historical metadata enumeration исключена из activity refresh.
- Native current Codex: src/adapters/codex-active-runtime.ts — connected controller loaded/list + metadata-only reads, без history/runtime activation.
- Owner activity/workspaces: src/active-session-inventory.ts — immutable runtime identity, actual TTL, production native workspace ingestion и common native parent normalization.
- Global fast read: src/active-session-fleet.ts — независимый per-peer singleflight background + atomic persisted index; consumer не запускает SSH/native reads.
- Workspaces: src/session-workspaces.ts и session-workspaces-backfill.ts — compound identity, несколько путей, CAS, explicit native execution provenance; generic launch cwd/title не доказательство.
- API/MCP: /api/sessions/active и list_active_sessions используют общий reader/filter; session_workspaces_declare/get — поддержанная декларация места изменения кода.
- Managed M1 observer: deploy/fleet/mac-node-watchdog.py — ограниченный retry только transient deadline; sustained/identity/budget failures остаются отказом.

Практический вывод этого цикла: быстрый локальный reader недостаточен, если global request каждый раз заново ждёт SSH; нужны проверяемые материализованные owner observations и независимая приёмка нескольких поколений. Native activity, source/tests, runtime bytes, current where evidence и consumer receipt — отдельные утверждения.
