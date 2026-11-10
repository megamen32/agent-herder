# Фактический результат 10 ноября

Установлен Rust core Herder с прежними TS/AHAP адаптерами. Отдельные Rust native adapters не являются выбранным путём V1. Два общих входа выбрали один immutable пакет из cebecc13480d0bb4b212dd6fc59f49d99a7e1333: manifest eb62ae35bc083fb3713ac961ca694ef3b1302b6323401278ba356ce75dc63301, Rust 1f85e7b720e159d1553e832c4d84030ed6daa389ec0eae3a6aba5c765d59815c. Установка прошла под fence102; сохранены authority stores, поколения, scopes и remote44 wrapper. Пять экземпляров четырёх сред: codex-local, codex-44, opencode-noticeplace-local, chatgpt-userio-vk-browser, zcode-local. Это ещё не приёмка пяти сред: Z.ai отсутствует.

Обычный MCP SDK подключился за2460мс, обнаружил пять экземпляров и прочитал10/10 ожидаемых native message IDs существующего ChatGPT-разговора. Полнота истории false. Read114284мс: найдено и исправляется медленное чтение квитанций UserIO. Повторная регистрация вернула прежний session:c678f986d231c56992a17b8966dd1397. Новых чатов/сообщений не было. Доказательства: final-lazy14b/installed-read.json, installed-read.log, install-summary.json.

GPTAdmin child штатно перезапущен под fence103, running PID2018166; connected discover подтвердил те же пять экземпляров. Старый restart job28e811d7 завершён EOF и не повторялся до проверки исхода и установки нового artifact. Доступ к старым длинным background receipts остаётся integration gap; caller/profile пока гипотеза.

UserIO0.9.30 опубликован480146dfba5847c213fb98af00f316ece6aac6c7 и установлен на сервере и Chrome Mac Mini Default/Carevio. Backend31/31source hashes совпали,19аккаунтов и frontend/voice сохранены. ZIP c21b8909771650f4fa0f00cb86078303d962d864d885071fd0fecdccce466e16.

ChatGPT lifecycle реализован и опубликован. Реальный Rust → bundled AHAP → extension dispatcher/reducer с fakeDOM/provider прошёл firstsend,secondsend,restart/read,exactarchive,scope refusal и UNKNOWN original receipt recovery без resend. Это fixture; новый живой ChatGPT lifecycle ещё не принимался. Vibe/CDP experimental/unmaintained; default UserIO.

Z.ai live выявил ложную identity: Carevio показывает страницу входа, metadata scope оказался гостевым и изменился при адресном чтении. Provider writes0; пробная привязка снята. Исполнитель исправляет nativeauth и exactarchive receipt, готовит0.9.31. Нужен настоящий вход либо другой уже авторизованный профиль; guest scope не закрепляется. Evidence mac-zai-auth-read.log и zai-live14/list-bound-reconciled.json.

Найден источник задержек UserIO: read_results разбирает весь JSONL369MiB каждыйpoll; HTTP limit1=11319мс при status273мс. Исправление читает хвост того же журнала без второго store/cache. Source и установка отдельно в receipt-tail14.

Ручной send belowreserve2388 установлен: human поручение с server timestamp обходит только localreserve; автоматический origin закрыт, provider refusal/HumanStop действуют. Native steer NoticePlace admitted=true;56focused+tsc и installed automatic0writes PASS. TS service затем обновлена другим владельцем до bba8b81, её не откатывали.

SESSIONREPLIES13 в очереди: ранний фактический текст+поздний итог, expect_reply=false отключает оба и напоминания; существующий hook напоминает при отсутствии финала с подсказкой ответа. Реализация ещё не начата.

Полный V1 не принят: остаются реальный новый ChatGPT lifecycle, подтверждённый Z.ai аккаунт/consumer, общая приёмка пяти сред. ChromeExtensionMCP в отдельной сессии01a1c600; её fixture не доказывает ordinaryprofile/GPTAdmin installation. Общий ETA не используется.
