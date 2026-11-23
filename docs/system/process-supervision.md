# Надзор за процессами и durable jobs

Связанные контракты: [supervised jobs](../supervised-jobs.md), [remote process execution](../remote-process-execution.md), [process leases runtime](../process-leases-runtime.md), [canonical waits and resume](../canonical-waits-and-resume.md), [health recovery](../fast-agent-health-recovery.md).

## Что система делает сейчас

Публичный контур `automation` регистрирует durable process-completion rule с постоянным request key и execution reference. Запрос сначала сохраняется, затем проходит fenced admission; одинаковый ключ и payload читают ту же операцию, иной payload конфликтует. Worker — companion того же release — продлевает связанные claims без участия модели. Завершение сохраняется отдельной receipt до финализации claims; повторная финализация не запускает команду снова.

Локальный запуск принимает argv и абсолютный cwd. Attach существующего PID требует boot ID и start ticks и не даёт родительский wait status. Linux и macOS используют платформенные средства надзора; remote start доступен только через установленный trusted executor. Контроллер остаётся владельцем resource claims, удалённая сторона — источником process identity и terminal evidence. На Linux remote worker ограничен независимым deadline supervisor. Remote lease execution на macOS и lease-bound RemoteAttach в документации явно не поддержаны.

Health/read APIs сообщают process state, renewal и finalization evidence, но диагностические поля не дают полномочий продолжать работу и не превращают UNKNOWN в успех. Handoff продолжает ту же сессию только после native admission и stop-policy gate; потерянный ACK сверяется с исходной intent/receipt, не вызывает новую отправку.

## Проблема

Подтверждённой единой поломки supervision в checkout нет. Архитектурный риск находится на границах наблюдения: контроллер, executor, OS supervisor и native harness могут видеть разные части процесса. PID без birth identity допускает ошибку из-за повторного использования; SSH-клиент не является доказательством окончания удалённого процесса; потерянная native-квитанция не доказывает отсутствие отправки.

Состояние readiness источников, runtime и конкретных установленных процессов в документах приводится исторически и не подтверждает live-статус на момент написания этого атласа.

## Идеальная система

Одна durable execution record связывает request key, immutable handle, controller/executor, resource bindings, дедлайн и receipt. Чистая политика решает admission, повтор, cancel, reconciliation и handoff по snapshot; OS, transport, storage и harness эффекты выполняют через порты. Процессная identity включает платформенно доступную generation identity; отсутствие доказательства завершения сохраняет occupancy.

Remote наблюдение обновляет freshness только в заданном временном окне; терминальное свидетельство может прийти позже, но должно быть привязано к тому же immutable handle. Health remediation предлагает только действие, разрешённое текущим durable состоянием; ни диагностика, ни recovery не создают новый запуск поверх UNKNOWN.

## Идеальный конечный результат

После рестарта можно продолжить наблюдение того же execution без повторной команды; подтверждённый выход имеет достоверную receipt; неоднозначный исход виден как UNKNOWN. Claims финализируются один раз, handoff доставляется той же native-сессии не более одного логического раза, а недоступный health источник не маскируется как healthy или stopped.

## Анализ по ТРИЗ

Причинная цепочка: процесс отделён от вызывающей сессии → локальное ожидание теряется при рестарте или разрыве связи → неизвестно, идёт ли эффект → повторный запуск может продублировать работу. Удалённое исполнение усиливает разрыв: локальный PID/SSH не удостоверяет удалённый process tree.

Противоречие: supervision должен пережить смерть контроллера, но не должен становиться вторым владельцем claims и scheduler. Это техническое противоречие между автономностью наблюдателя и единственностью authority.

Принцип разделения — по функциям и пространству: durable controller владеет request, claims и resume decision; executor наблюдает собственный процесс и deadline, но не открывает вторую resource authority. Ручной attach фиксирует только подтверждаемую identity и не присваивает недоступный wait status. Handoff отделён от завершения процесса и подчинён native admission.

Проверяемая польза: разрыв транспорта после dispatch не вызывает второй spawn; удалённая receipt привязана к handle; PID reuse не меняет объект наблюдения; claim не освобождается без подтверждения конца дерева.

## Ресурсы

- **Вещественные:** worker, локальный subreaper/systemd scope или macOS launchd job, Linux deadline supervisor, pinned transport, OS process handles и native harness.
- **Информационные:** durable rule, idempotency key, execution ref, immutable remote handle, PID + boot ID + start ticks, command/config hashes, deadline, renewal и terminal receipts.
- **Временные:** абсолютный deadline, claim TTL, ограниченное окно свежего remote observation, bounded handback и stop grace.
- **Полезные побочные:** stdout/stderr, source evidence и logs помогают диагностике, но сами по себе не доказывают artifact correctness или deployment.
- **Ограничения:** remote lease execution macOS и lease-bound RemoteAttach не включать без требуемого независимого supervisor и доказательства.

## Спецификация

- **Владелец состояния:** Herder durable authority владеет rule, request key, claims, cancellation tombstone и resume intent. OS/executor владеет наблюдением своего process tree; native harness владеет фактом приёма сообщения.
- **Чистое решение:** по сохранённому snapshot определить admission/reconcile/cancel/finalize/handoff, проверив ключ, fence, deadline, identity, stop state, claim bindings и native receipt. Повторный create не переходит к новому spawn.
- **Эффект через порты:** запись журнала, запуск/наблюдение процесса, remote RPC, получение receipt, release claims и native delivery имеют отдельные порты и устойчивые идентификаторы.
- **Одна проверка на правильной границе:** после потери ACK повторная команда reconcile того же request key и immutable handle проверяется в durable execution authority до любого process start или native send.
- **Наблюдаемый результат:** одна execution record; terminal receipt с executor, observed exit/signal, `tree_complete` и source evidence; либо сохраняющийся UNKNOWN. Handoff имеет отдельную delivery receipt; health read показывает unavailable/incomplete, когда данные неполны.
- **Минимальные сценарии:** локальный exit и crash/restart; PID reuse; attach без wait status; remote ACK loss; короткий и просроченный live observation; поздняя terminal receipt; отмена во время выполнения; потеря claim; native ACK loss; HumanStop перед handoff; executor/config identity mismatch.

## План и приёмка

1. Сохранять один request key и execution handle от admission до terminal reconciliation; при UNKNOWN читать исходную receipt и не выдавать повторную команду.
2. Сопоставлять process identity с host/executor и платформенной birth identity; удалённый PID никогда не трактовать как локальный.
3. Финализировать bindings после durable terminal receipt; неизвестная целостность дерева удерживает occupancy. Отдельно применять существующие native stop/admission правила к handoff.
4. Принимать реализацию на границе durable execution authority: после simulated transport/worker crash повторное reconciliation даёт тот же execution, корректный receipt и ноль новых spawn/send. Для live claims нужны отдельные receipts точного установленного worker и обычного consumer; сборка checkout этого не доказывает.

Delivery и расписания продолжаются через [canonical waits and resume](../canonical-waits-and-resume.md); этот документ задаёт границы процесса и handoff.
