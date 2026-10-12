# Два обрыва ZCode: восстановление в прежнем ID

Владелец source/consumer: Codex 01a112ee-5d49-7c31-8e3d-221a13a7a4d0.
Владелец единственной установки Herder100: Codex 01a12740-96aa-7b93-9bef-679dcae60d84.

## Подтверждённая причина пропуска

- `sess_4b3ea36a-7064-4191-8e6a-a7acab1194ff` и `sess_c1400322-3bfd-4ef3-8789-7a366d039d35`, cwd TelegramAuto.
- Старые embedded turns отменены 01:27:08 UTC сразу после Herder100 activation 01:27:06; assistant error exact `ZCode Protocol runtime stopping`, code `model_request_failed`, attribution.source `runtime`, turnResult `cancelled`. Native `cancelled_by_user=1` не доказывает ручной STOP.
- Cold recovery прежде распознавало такой cancelled transport только для remote SSH с task_status=running. Локальные rows completed пропускались.
- turn_usage хранит терминальные ходы. Более новые desktop continuation inputs были promoted до этой отмены; реальные assistant/tool writes после неё не означают новый terminal turn_usage.
- Native hidden todo/system reminders ошибочно считались новым пользовательским ходом.

## Исправление

Только адаптер ZCode и две группы focused tests. Exact current runtime shutdown становится transport loss для существующего no-LLM same-ID launcher. Обычная cancellation, старый runtime error, pending admitted input, новая работа, malformed message и durable human holds не дают replay. Recent ongoing assistant progress при историческом completed index учитывается до более нового lifecycle boundary. История, models, auth, очереди и native SIDs не изменяются.

Launcher production не менялся: существующий cold ingestion/accepted receipt путь достаточен после исправления native evidence.

## Проверки

- Дискриминирующий SQLite RED: cancelled local shutdown пропущен; отдельный RED для synthetic reminder masking нового assistant progress.
- Setup timeout 5s устранён transaction batching SQLite fixture; отдельная fixture ошибка missing rm import исправлена. Эти FAIL не являются consumer GREEN.
- Adapter + launcher 107/107 PASS, полный tsc --noEmit PASS; основной combined 22.18s, peak554404KiB, CPU2/RAM2GiB/tasks128/swap0.
- Последний SQL safety delta: те же107/107 PASS 7.03s; malformed newer message сохраняет unknown вместо пропуска назад к старому error.
- Последний fixture delta: 1 PASS 2.47s; retryable=false runtime shutdown и более свежий end lifecycle. Все ordinary runs данной коррекции укладываются в180s с сохранёнными прежними результатами.
- Evidence: `.tmp/two-death-release/`; screenshot `trash/logs/two-death-c140-working.png` просмотрен в owned authenticated public browser.

## Реальный результат двух чатов / граница

До установки fix обе desktop sessions уже продолжили работу в своих исходных ID без наших новых prompts. 4b: новый Bash completed01:37UTC, следующий tool poll идёт с01:37:12 (bounded sleep580s); исходный benchmark ещё не завершён. c140:37 tests PASS, commit6a5917c, новый image built, агент продолжает штатный production rollout; actual tool calls до01:44UTC. Public browser показывает этот ход и ответы. Это доказательство продолжения работы, НЕ доказательство завершения исходных бизнес-задач и НЕ атрибуция нашего automatic recovery старых ходов.

Pending: Root reviewed source installation; затем consumer readback того же API/browser и обоих native IDs. Не повторять accepted/queued input. UI additions из нового поручения идут после narrow fix; S21 lease/API принадлежит R38, текущую телефонную работу не трогать.
