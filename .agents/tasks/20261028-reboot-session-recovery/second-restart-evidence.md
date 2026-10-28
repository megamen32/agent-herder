# Повторный запуск — независимое чтение

29.10.2026, после 01:01 МСК. Никаких ручных resume/send, переустановки или повторной доставки при чтении не выполнялось.

Установленный процесс100: PID7859, start01:01:39MSK, exact release98caf6270a22dc3aee2c37dff0b93858f9310383. Source исправления первого холодного обнаружения17c89a1 уже опубликован.

Первый установленный Herder сам принял четыре продолжения 29.10 в00:04:22–00:04:26MSK. Их native ходы действительно работали: есть новые комментарии и инструменты после принятия. После следующего запуска те же ходы native interrupted, durable admissionPhase=in_progress. Это отдельный повторный обрыв, а не основание повторить старую доставку.

| Сессия | Принятый native ход | acceptedAt UTC | Последний progress readback UTC |
| --- | --- | --- | --- |
| ExManager01a17e2e | 01a18454-0da6-7bd1-9c32-a08d5d33f174 | 21:04:23.540 | 22:02:16.274 |
| Сохранность01a17e87 | 01a18454-0630-7ee0-8e85-eb23cbb9bd1a | 21:04:22.015 | 22:02:48.478 |
| XERJ01a18288 | 01a18454-121b-7ab0-a1fd-c0458ab648ca | 21:04:24.677 | 22:02:48.209 |
| Аккаунты01a183d6 | 01a18454-186d-7ff0-8404-2923a6dddd98 | 21:04:26.287 | 22:02:47.899 |

В точном API readback все4idle/native interrupted, needsPermission=false, humanStopHeld=false. Свежая bounded native проверка final/pending/user identity всё равно обязательна перед любой автоматической доставкой. Само изменение fingerprint после запуска не доказывает исполнение нового хода; прежние commentary после00:04 доказывают лишь первоначальное успешное продолжение.

Оставшийся дефект: ingestColdFailure возвращает существующую запись того же recoveryTurnId; recoverPending безусловно сохраняет accepted_pending/in_progress. Нужен безопасный переход после доказанного нового terminal interruption, с новым input ID и сохранением no-replay для accepted/UNKNOWN без terminal proof.

## Точная native проверка 22:14:56UTC

Установленный adapter98caf вызвал readLatestTurnRecoveryEvidence для каждого из4ID. Это только thread/turns/list с limit1/summary. Все4: available=true, interrupted, userMessageCount=1, assistantFinal=false, pendingQuestion=false, completedAt=null, userInputId=null.

| Сессия | startedAt UTC | Точный userMessageId прерванного принятого хода |
| --- | --- | --- |
| ExManager | 21:04:23 | 01a18454-3265-70c1-a4cd-30361d00ac4f |
| Сохранность | 21:04:21 | 01a18454-2b8a-72a1-b7ea-e9df46fa0565 |
| XERJ | 21:04:24 | 01a18454-2950-7bb2-9886-301d52d6da54 |
| Аккаунты | 21:04:26 | 01a18454-311e-71e2-9f73-cd711138e7fd |

В durable record recoveryTurnId уже содержит принятый прерванный turnId, но recoveryInputId ещё содержит исходное сообщение ДО первого восстановления. Нельзя выдумывать равенство этого старого ID новому native userMessageId. activeTurnId/activeInputId отсутствуют после markPersistedActiveTurnFailed. Новый переход обязан сохранить прежнюю квитанцию, опираться на точный принятый turnId и свежую native границу, получить отдельный dispatch ID. Native startedAt округлён до секунд и потому может быть раньше acceptedAt на долю секунды.

`uptime -s` подтвердил фактическую новую загрузку100: 2026-10-29 01:01:27MSK. Это не только restart Herder.
