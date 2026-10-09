# Прямая доставка и очередь ZCode

Исполнитель: Codex01a11b43. Интеграция, публикация и выпуск: Codex01a11b54.
Границы: `src/adapters/zcode.ts`, новый `tests/zcode-communication-delivery.test.ts`, этот журнал. Чужие Codex adapters/handlers/receipts и AutoFind не меняются.

## Подтверждённая ошибка и настоящий маршрут

После выпуска Herder00c7b9a зарегистрированный `send_message(mode=steer)` активному ZCode вернул `A prompt is already running for this session`. Старый адаптер не использует `options.steer`, вызывает legacy `sendPrompt`, а `queue` складывает в RAM и при flush создаёт новый inputId.

Установленный `/home/roomhacker/.zcode/server/zcode-server.cjs`, SHA256 `f7a537a644611ba03099f4e06c395f0b064dde9b1ceb232bd5652637b03c8550`, действительно экспортирует через `zcode-agent` метод `sendConversationCommandV4`. Его `sendText` принимает `requestedDelivery=guide|queue`; envelope содержит стабильные commandId/clientId/sessionId/issuedAt. ACK различает accepted/duplicate/rejected и native `inputAccepted` с inputId/delivery. Legacy `buildSessionSendParams` эти режимы не передаёт. Это проверка установленного native протокола, без нового app-server.

## Проверки и изменение

До изменения source реальные8 focused regressions получили8 FAIL на запрещённом legacy sendPrompt. Штатный bounded helper: lease `.tmp/herder-steer-idle-ack-20261009/run-temp/bounded-q_am93ou`, exit1, native peak171520000B, swap0/OOM0. Старые логи сохранены.

Новая source delta переводит explicit steer/queue на V4 admission без старой RAM очереди, stop/cancel, повторного sendPrompt и ожидания completion. Стабильный caller inputId используется как commandId; automation получает существующий `agent-herder:auto:` prefix. Неверный/потерянный ACK остаётся unknown/nonRetryable. Guide fallback в queue — явная ошибка уже принятого сообщения, повторять запрещено.

Native inputId может отличаться от commandId. Сверка использует persisted sourceCommandId и две стадии корреляции IDs из turn.steerQueued/turn.steerDrained/drainedInputs и пользовательской native истории. Exact native turn.failed имеет приоритет. Независимый read-only reviewer business_supervisor обнаружил эти два случая; regressions добавлены. Всего15 новых случаев. После независимого SOURCE_ACCEPTED штатный focused case получил15 PASS и tsc --noEmit exit0 (lease bounded-qm5_iids,22.305s,payload exit0,native peak499466240B,swap/OOM0). Outer helper exit75 на cleanup population race; own scope/PID/cgroup и controlfiles уже отсутствуют, но capacity book ещё держит cleanup reservation. Infra2c получил exact generation; повтор payload запрещён, следующая backend сборка ждёт штатной сверки/освобождения резерва.

Пересоздание адаптера в focused fixture проверяет сохранение стабильного commandId и сверку из native facts. Оно **не доказывает** переживание перезапуска CLI. Installed commandAckSchema прямо ограничивает accepted состоянием native runtime; результат после рестарта определяется persisted input facts. Нельзя обещать бессрочную RAM очередь или replay неизвестной команды.

## Runtime и следующий шаг

Завершённые85 tests, build и Codex native canary относятся к00c7b9a; они не доказывают эту новую ZCode delta и не повторяются. Publisher выпустит следующий exact пакет после её focused checks и artifact.

Root24 передал актуальную единственную AutoFind координацию для sess_c1400322-3bfd-4ef3-8789-7a366d039d35, stableID `root-current213-mount-only-20261009-1`. Она **не attempted**. Предыдущий payload о36b7c9a для386 не отправлялся и устарел. Callable существующий native broker пока не найден: текущий registered MCP ещё использует legacy adapter, known protocol client только stdio со spawn; известные runtime metadata и `/proc/net/unix` ZCode broker endpoint не показывают. Root получил exact action-needed для готового endpoint/schema. Новый app-server и foreign stop не запускаются.

Composer UI QA сохраняется отдельно: primary managed Mini browser открыл настоящий public UI, но redirect auth/login; failure screenshot сохранён до cleanup, recoveryowner1f58 получил protected-login handoff. Codex native canary уже прошёл через registered MCP mode=steer/queue=false:1735.41ms receipt приinProgress, один user item и один ответ «Сообщение получено», без инструментов/повторного ввода.
