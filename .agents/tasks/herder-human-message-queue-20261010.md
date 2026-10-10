# Очередь человеческих сообщений Herder — независимый аудит 2026-10-10

Владелец исправления и runtime: root55. Аудитор: consumer_inventory; только чтение и эта запись. Основная Mesh delivery не изменяется.

## Подтверждённый результат

- Приватный pre-restart snapshot содержит27 завершённых результатов с явным отказом: receipt storage full, no delivery attempted. Это доказанный отказ до нативной отправки, а не UNKNOWN и не accepted.
- Из100 записей этого snapshot одна ещё waiting: job с префиксом3a35a10468. Её owner совпадает с отдельным owner-state evidence: status running, nativeLastTurn inProgress, humanStopHeld false. Само waiting при активном owner соответствует текущей логике «после ответа» и не доказывает зависшую очередь.
- Изначальные три waiting и последующее сокращение до одного предоставлены root; сохранённый исследованный snapshot подтверждает только поздний один waiting. Диалоги, тексты сообщений и credentials не прочитаны для анализа и не перенесены сюда.

## Причина и затронутый путь

UserMessageDelivery.submit/run → ожидание getSession running/needs_input → SessionSupervisor.sendMessage(origin human) → CodexAppServerAdapter.sendMessage → CodexDeliveryReceipts.once → native turn/start либо turn/steer.

Подтверждённый дефект: ранее общий конечный receipt store исчерпал2048 permanent entries и отклонял новые input IDs до выполнения operation. Сохранение accepted/UNKNOWN evidence необходимо; eviction или replay недопустимы.

Текущий source CodexDeliveryReceipts уже сохраняет legacy evidence без изменений и размещает новые receipts в hash buckets с пределами2048records/file,1MiB/file,16MiBtotal. Поэтому legacy FULL нельзя выдавать за доказательство нынешнего deployed поведения без проверки установленного artifact. Deployment fix принадлежит root55.

Неподтверждённые гипотезы: stale running status, потеря turn/completed event, невозможность drain после idle, сохранность waiting jobs после restart. Snapshot не отличает эти ошибки от нормального активного native turn. Новый restart разрешён человеком и выполняется root55; аудит его не повторяет.

## Самая дешёвая различающая проверка

Fast unit, ожидаемо<1с, максимум5с: заполнить legacy fixture2048 valid permanent receipts; новый unrelated thread/input должен выполнить operation ровно один раз в новом bucket, старые accepted/UNKNOWN IDs должны вернуть старый receipt без operation и без изменения legacy bytes. Это local anti-replay/capacity proof, не доставка человеку.

Focused integration, ожидаемо<5с, максимум15с: owner running→idle transition должен допустить ровно одну native submission того же input ID; UNKNOWN/admitted/cancelled states не переигрываются. Использовать имеющийся тестовый seam; реальные человеческие payloads не воспроизводить. Аудитор тесты не запускал.

Следующий runtime шаг root55: после своего единственного разрешённого restart подтвердить installed receipt implementation и наблюдать существующий job/owner до idle/terminal receipt. Нового сообщения, steer, replay, stop или второй restart аудит не создаёт. Доставку считать доказанной только по фактическому native admission/completion, а не state completed с result.ok=false.

Приватные evidence pointers (содержимое не публикуется): .tmp/herder-fleet-20261010/runtime-100/human-queue-before-authorized-restart.json; .tmp/herder-fleet-20261010/http-singleton/held-human-jobs-owner-state.json.

## Фактический restart receipt

Установлен source1b3ed178, servicePID1193389; shared native master и бюджеты сохранены. Две прежние записи completed с result.ok=false, последняя interrupted после явно разрешённого человеком restart; их payload не переигрывался. Новый необходимый source-handoff исполнителю121d1 получил настоящий native admission01a12598: это проверка нового bucket storage, не доказательство доставки старых сообщений. Разрешённый restart завершён; отдельное исследование after-answer drain остаётся открытым и не блокирует Mesh.
