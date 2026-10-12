# Сохранение принятого, но не исполненного ввода ZCode

Это отдельный явный maintenance-маршрут в существующих `HerderJobRegistry` и
`UserMessageDelivery`. Он не запускает planner, не отменяет работу и не является
разрешением остановить native runtime. Root владеет первой остановкой/установкой
и проверяет свежую активность всех реальных SDK clients, включая четвёртый
GPTAdmin canary client. Уже promoted-вводы 0cce исключены из capture/retry.

Сохраняется только явно выбранный exact SID/input/cwd: native `clientId` должен
быть `agent-herder`, source command и queue ID должны совпадать, ввод должен быть
`sendText/queue/admitted`, без promoted sequence/message и без ссылок на него в
полных native transcript/tool rows. Automation prefix проверяется вместе с этим
происхождением, а не используется как самостоятельное доказательство владельца.
Оператор обязан выбрать документированную собственную admission; неизвестных
акторов и очередь другого клиента этот маршрут не усыновляет.

Полный исходный native payload, logical ID, origin, текст, attachment refs и
content SHA/размер сохраняются отдельным `zcodeInput.capture` в **том же** jobs
файле. Fingerprint покрывает весь capture. `durableOnce` защищает его от trim;
`restore()` может изменить результат interrupted job, но не envelope/lineage.
Обычные get/list/cancel не возвращают защищённый envelope. Ошибка строгой записи
не разрешает отправку. Новый store, registry или контроллер не создаётся.

## Первая установка поверх старого daemon

Нельзя импортировать новый `herder-jobs.js` в live parent или создавать другой
registry над живым jobs-файлом: singleton/restore и второй writer могут изменить
чужую историю. Подготовка ниже импортирует только статeless native reader;
сохранение выполняется **на единственном существующем live registry**.

После reviewed source build Root запускает preparation utility с абсолютными
путями и свежими `/proc` generation pins:

```text
node scripts/checkpoint-zcode-undelivered-input.mjs
  --compiled-root <reviewed candidate dist>
  --native-db <existing native db.sqlite>
  --session-id <exact original SID>
  --input-id <exact own never-promoted command ID>
  --cwd <exact original cwd>
  --controller-pid <current Herder PID> --controller-tick <start tick>
  --sdk-pid <current owned SDK PID> --sdk-tick <start tick>
  --cli-pid <current owned workspace CLI PID> --cli-tick <start tick>
  --jobs-path <actual live registry persistence path>
  --output <private 0600 prepared callback JSON>
```

Utility не пишет jobs и не запускает CLI/native input/provider. Он читает
исходные rows и создаёт приватный artifact с source-pinned compiled retain body.
Raw envelope содержится в artifact: его нельзя печатать в чат или общие логи.
Root сверяет compiledJobsSHA256 с reviewed build manifest и выбирает unique
owned live registry через свой existing official Node diagnostic. Полученный
`functionDeclaration` исполняется bound к этому объекту в одном callback.

Callback проверяет parent/SDK/CLI PID+start ticks и отношения, cwd, exact current
native row, complete no-execution evidence, последнего пользователя и attachment
bytes. Затем **до retain** устанавливает self-contained redacting wrappers на
старые dynamic `get/list/cancel`, сохраняя их null/limit/cancel semantics.
`start()` и persistence не заменяются. Только после этого self-contained retain
method вызывает старый `this.persist(true)` и проверяет точный field в сохранённом
jobs-файле. Возвращается metadata receipt, `stopAuthorized:false`.

Bridge покрывает этот объект, а не другой OLD writer или ранее сохранённую
function reference. Root предварительно проверил динамический вызов readers;
при неизвестной instance/writer/exposure границе callback запускать нельзя.
Неисполнение original input не доказывает отсутствие другой native работы.
После checkpoint Root повторяет actual runtime inventory и сохраняет чужую
работу/accepted queues. Source readiness или этот receipt не заменяют эту границу.

## После установки

На новом уже готовом SDK Root выполняет только supported prompt-free same-ID
load нужной сессии. `retryZcodeInput()` самостоятельно её не загружает и transport
не запускает. Native cold load должен авторитетно записать для **исходного** ввода
`discarded/session_resumed` с promoted message/sequence null. Это единственная
допустимая причина retry; missing row/schema/UNKNOWN, cancelled или original
user/assistant/tool progress запрещают его.

Public entrypoints существующего owned `UserMessageDelivery`:

```text
checkpointZcodeInput(sessionId, originalInputId, cwd) -> {jobId, fingerprint}
retryZcodeInput(jobId) -> receipt for original logical ID
reconcileZcodeInput(jobId) -> receipt only, never send
```

Для first upgrade используется callback выше, поскольку старый экземпляр ещё
не имеет новых методов. После установки методы вызываются на **существующем**
delivery instance; не создаётся второй jobs registry. Обычный human submit не
используется: он releases Stop и добавляет context. Retention route явно обходит
supervisor injection/deferred wrappers, сохраняя automation origin и native
identity/permission/Stop/work guards.

Один native attempt ID детерминированно производен от original logical ID:
`<original>:delivery-attempt:1`. Он **строго сохраняется до dispatch**. Если попытка
уже reserved, accepted или UNKNOWN, повторный вызов выполняет только receipt
reconciliation. Ошибка записи result после dispatch оставляет durable reservation
и не разрешает resend. Даже pre-dispatch refusal сохраняет эту единственную
reservation: автоматический второй шанс не предоставляется.

Поддерживаются обычные `build/edit/yolo` input с `planEnabled:false` и известной
model selection, включая `options.reasoningLevel`. Остальные execution options,
Plan/Goal commands, shared/ambient imports и неподдержанные attachments отклоняются.
Сравниваются текущие native model/options и mode; последняя synchronous SQLite
fence дополнительно проверяет существующие `runtime/model_selection` и
`runtime/execution_state`, включая независимый planEnabled. Original supported
fields передаются неизменными, Goal/config/grants не восстанавливаются отдельно.

Свежие existing-only reads проверяют exact native runtime generation, SID/cwd,
idle/pending requests, затем durable Stop после всех awaits. Полная native DB
fence стоит последней перед ready public `sendText(requestedDelivery:queue)`.
При конкурентной новой работе native queue path не preempts её; это не idle CAS
и не обещание атомарного отказа при новом вводе после fence. Public SDK может
добавить свою штатную browser context metadata; оригинальный текст/attachments и
execution selection этот маршрут не переписывает.

Native dedup проверяет ID, а не actor/text. Поэтому даже accepted/duplicate ACK
требует exact persisted attempt text/files/model/mode/plan/client/intent, а promoted
receipt — ещё и exact user anchor. Collision/missing receipt остаётся UNKNOWN;
`sendQueuedNow`, clearing Goal, повтор old Bash/tool или новое задание запрещены.

## Проверка

Fast unit проверяет полные SQLite nonexecution rows, schema unknown, promoted и
foreign actors, configuration fence, attachment bytes и collision receipt.
Focused integration проверяет reservation-before-send, IO отказ, restart с
interrupted result, query-only повтор, Stop/Desktop/identity races, три positive
messageLimit reads и old first-boundary redaction на том же fixture registry.
Обычный combined tests+tsc run ограничен 180s и isolated state/bounded profile.
Handler/fixture GREEN отдельно от actual consumer: живые capture, cold load,
retry, 4b recovery и compare+DELETE исходных c140/0cce switches выполняются только
после Root actual activation; они пока не подтверждены.
