# Восстановление после повторной перезагрузки

## Подтверждено на100

Source139d877ef6ce353fc9e2b2305a4f65336f49e702 опубликован в main; установленный процесс564651 стартовал29.10.2026в01:28:49MSK из immutable release того же SHA. Compiler inputs clean; shared checkout содержит сохранённые посторонние документы. Build,14/14release checks,3targeted recovery scenarios и TypeScript прошли. Предыдущее исправление cold discovery17c89a12c19654d5e8483b0c1152b1cc18808647 также включено.

Единственный Herder сам продолжил4сессии после второго реального reboot100(01:01:27MSK). Root не вызывал resume/send ни для одной сессии: ручных продолжений0. Свежие native ходы имеют новые сообщения ассистентов о продолжении сохранённой работы, а не только HTTP200.

| Сессия | Время auto admission MSK | Новый native turn |
| --- | --- | --- |
| Установить XERJ01a18288 | 01:32:17.066 | 01a184a4-84c1-7570-bd32-069e8f8119aa |
| ExManager01a17e2e | 01:32:18.315 | 01a184a4-8a01-7031-abe9-b6cda61125a6 |
| Сохранность данных01a17e87 | 01:32:18.696 | 01a184a4-8ab2-7ec3-a0b2-b65c953489f4 |
| Подключение аккаунтов01a183d6 | 01:32:21.186 | 01a184a4-954c-7831-9ebf-4ca16d7f9896 |

После нового допуска durable record сохраняет предыдущий acceptedAt внутри rebootRecovery.priorAcceptedAt, отдельный стабильный herder-reboot input ID и phase=dispatching. Новые activeTurnId совпали с API. На01:34MSK все4имеют lastNativeProgressAt после нового admission, lastError=null. Это доказательство восстановления исполнения, не утверждение о завершении целей ExManager/XERJ/аккаунтов.

До/после установки точно равны SHA файлов indexing-settings, session-autostart, automation-disarm и human-stops. Native Codex PIDs26565/47482 сохранены. Индексация остаётся на паузе.

## Защиты и исключения

Повторный обрыв определяется свежей native summary последнего interrupted turn: точные turn/user IDs, отсутствие final/pending question/нового активного хода. Persisted accepted_pending/UNKNOWN без доказанного нового terminal interruption не воспроизводится. CAS dispatching предшествует send; ready можно продолжить после падения до отправки. Следующие перезагрузки получают новые границы, bounded history сохраняет8предыдущих маркеров. STOP и ожидающие разрешения остаются блокирующими.

Airlock01a182ff-be14-7171-9b7d-a4965f7363cd с финальным ответом и ожидающим вопросом не возобновлялся. Две сессии с уже новым работающим ходом не повторялись. Автоматическое продолжение AutoGram отдельным исполнителем не приписывается этому выпуску. Завершённые native ходы не переоткрывались для активности.

Вопросы/разрешения находятся в отдельной человечески назначенной сессии01a18444-4ce2-70d2-a7f0-65e9fe1cbbef. Их Telegram E2E этим отчётом не заявляется.

## Узлы

44/88:139d877 установлен,1811/1811payload SHA и fingerprint подтверждены, настройки/STOP/pause/nativePIDs сохранены. Квитанция linux-second-install.json.

Mini:139d877 установлен через исправленный deployment helper09686d9. NodePID45874, current/config/process указывают на139d877;1811/1811payload SHA и package resolution подтверждены. Sessions/policy/MCP200 с существующим canonical bearer, без credential issue. Native PID/starttimes, модели, pause/STOP и state hashes сохранены. Root независимо прочитал exact process/current и sessions200. Итоговая квитанция mac-installed-139.json.

Ранее неуспешные mac-second-install.json/mac-final-install.json сохранены как история. В установщике исправлены два доказанных дефекта: readiness не может принять старый listener вместо новой generation; Darwin exact owned LaunchAgent останавливается ДО изменения releases, чтобы не вызвать release_generation_changed у работающего watchdog. Владение, конфигурация и отсутствие нового owner проверяются перед switch; при сбое восстанавливается только прежний доказанный runtime. Watchdog не ослаблен. Helper commitsf572760/09686d9 меняют Python deployment path и не являются новым Node runtime: compiled source по-прежнему139d877. Повторная сборка или restart100/44/88 ради номера helper не требуется.

M1: исправлены два устаревших config pin с backups/CAS. Остался dangling canonical socket; текущий alias inode и target не совпадают с последней sealed ready ownership proof. Удаление/захват не выполнялись, native start blocked. Точные inode/config hashes и диагностика в mac-install.json. Нет утверждения, что M1 принял новый runtime или автоматически продолжил свои сессии.

Финальный read-only M1 подтверждает hostnameMacBook-Pro-User.local, canonical pointer symlink UID501/inode177527201, target_exists=false. Это тот же неустранённый blocker, а не устаревшая заметка. Последующие действия требуют установить владельца этой pointer generation или отдельный поддержанный owner-authorized reset; неизвестный native writer не захватывался.
