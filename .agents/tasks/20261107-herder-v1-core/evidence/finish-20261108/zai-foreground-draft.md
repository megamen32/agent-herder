# Z.ai foreground admitted-draft state: RED → GREEN

2026-11-08. Owned source: `src/adapters/zai-cdp-driver.ts`,
`src/adapters/browser-chat.ts`; regression `tests/zai-foreground-draft.test.ts`.
Live browser/native calls, новые страницы, install/deploy/commit не выполнялись.
Уточнение о пяти минутах cooldown сохранено: все проверки offline, global polling
и закрытые parent tabs не затрагивались.

## Root cause

После первого send admitted draft содержит remoteId `route:<native>`.
`ZaiCdpDriver.sendMessage` сохраняет в in-memory cache native chat working=true.
`BrowserChatAdapter` копирует это в свой inventory для стабильного draft ID.
Дальше core проверяет getSession перед follow-up и получает running.

Прежний `refreshTurnState` сразу возвращал false при pollingEnabled=false.
Даже при включённом polling он не разрешал `draft:` в `route:`, а успешный
API refresh обновлял durable inventory, тогда как getKnownChat(draft) читает
in-memory native cache. Поэтому готовый ответ не снимал busy у admitted draft.

## Минимальное изменение

- Driver refresh получил optional `{foreground:boolean}`. Только
  foreground-only BrowserChatAdapter при getSession явно передаёт true.
  Обычный adapter передаёт false; observer `refreshSession` по-прежнему вызывает
  default background path, защищённый liveHarnessPollingEnabled.
- Foreground path разрешает draft remoteId, требует ранее verified account
  scope, ищет существующий exact route через list_pages и configured pin либо
  account-owned marker. Не использует page(), чтобы не открывать/выбирать вкладки.
- Проверяет scope существующим verifier и точный DOM activity snapshot.
  Другой origin/path/account, отсутствующий target, read failure, unknown phase
  и security verification не дают ложного idle. Generating и post-send guard
  остаются busy. Заголовок чата не используется для угадывания target.
- Обновляет exact native entry одновременно для getKnownChat(draft) в памяти
  и durable inventory. Adapter заменяет свой stale draft inventory обновлённым
  getKnownChat. Stable session ID, authority и operation keys не меняются.
- Один foreground read использует один existing account verifier и один DOM
  activity snapshot; native messages/full export/list polling не добавлены.
  Успешный second send выполняется отдельным явным consumer действием.

## Regression proof

`node_modules/.bin/vitest run tests/zai-foreground-draft.test.ts --reporter=dot --silent`

RED до source fix: 1 failed, 6 passed. Полный create/first send/read путь
возвращал running там, где exact idle должен разрешать second admission.

GREEN после fix: lifecycle стал idle, второй correlated send получил отдельный
native user-message ID; first-message helper вызван один раз, всего две
model-send попытки внутри fake fixture (ни одного внешнего эффекта).

Fixture использует реальные BrowserChatAdapter, ZaiCdpDriver, local durable
draft/inventory stores; подменены только boundary Chrome tools и first-message
browser helper. read возвращает реальные по структуре user/assistant messages;
не присваивает adapter working=false через mock refresh.

Дополнительные проверки: paused default background refresh и getSession обычного
adapter делают ноль browser requests; mismatched account/origin/path, отсутствующая
страница, ошибка account read, generating/unknown/security не снимают busy;
unpinned exact account-owned target разрешается без new_page/navigation/click.
Exact idle entry проверяется и в durable inventory.json.

Финальный affected suite:
`node_modules/.bin/vitest run tests/zai-foreground-draft.test.ts tests/zai-cdp-driver.test.ts tests/browser-chat-adapter.test.ts tests/browser-chat-create.test.ts --reporter=dot --silent`
— 111/111 PASS в4files, 24.69s; новая regression содержит11cases.

Reviewed diff: один явный foreground selector, отдельная serialised read-only
ветка, две синхронизированные cache projections. Background implementation
не переписан и не разблокирован. Другие source не изменялись.

`node_modules/.bin/tsc --noEmit --incremental false` и `git diff --check` прошли.
Это source/fake-boundary evidence, не live acceptance и не разрешение replay
исторических accepted/UNKNOWN операций.
