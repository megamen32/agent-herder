# Видимая активность Codex — приёмка 28.10.2026

Последнее прямое уточнение владельца: размышления и инструменты видимы по умолчанию, детали свёрнуты как в Codex. Явное сохранённое выключение сохраняется.

## Установлено

- Source main c1e920a8c0572e21e7a80b516c5a5e6274eeeafe; bundle f4b39b6c1f01862ca615853bfd4cb26084d3626ee13dfe97b35d851978f321b6, 14/14 release checks PASS, production build PASS, выбранные 15 regression tests PASS.
- Сервер100: PID4005682, единственный restart 21:38:21 MSK; exact immutable release в ExecStart, active/NRestarts0.
- Public frontend: authenticated GET / header X-Herder-UI-Source=c1e920a8c0572e21e7a80b516c5a5e6274eeeafe; nginx source main4762c559 опубликован. Предыдущий каталог сохранён для rollback.
- Сервер44/88: см. linux-rollout.json. Состояния моделей/STOP/автопродолжения и native PID сохранены.
- Background indexing100 enabled=false после установки, сохранённый индекс не удалён.

## Реальный браузер

Собственный QA browser act28, штатный SSO testlogin; обычный публичный адрес сессии AutoGramXAirlock: codex:01a182fe-39b5-7730-a84b-7c484e8fc412. Пользовательские сообщения не отправлялись, native сессия не останавливалась/не перезапускалась.

1. Удалены только старые display preference keys собственного QA браузера. Default: 27 tool rows и17 thinking rows, открытых details0. Меню подтверждает оба checked=true.
2. Реальный click summary инструмента: один раскрытый details, внутри Вход и Результат. Click размышления: событие раскрывается, честно сообщает отсутствие сохранённой публичной сводки. Зашифрованное/скрытое рассуждение не выдаётся за доступный текст.
3. Checkbox Инструменты выключен: rows0, storage=false. Reload сохраняет rows0. Повторное включение возвращает строки.
4. Mobile390×844: body.scrollWidth390, инструменты30/размышления16, открытых details0. Новые события той же работающей сессии появились без нового пользовательского ввода.
5. Authenticated quick details12: HTTP200, parts tool_call9/tool_result8/thinking3. До исправления тот же endpoint возвращал только text/image.

Скриншоты в .tmp/activity-desktop.png и .tmp/activity-mobile.png осмотрены. Собственный браузер очищается после проверки. При возобновлении браузер истёк до about:blank; screenshot зафиксирован до повторного открытия. Ошибка синтаксиса первого CSS selector также снята до исправления; повторная точная ссылка на существующий summary успешно раскрыла событие.

Ограничение: полное визуальное совпадение со всеми экранами закрытого Codex не заявляется. Подтверждены требуемые видимые свёрнутые строки, раскрытие ввода/результата, события агентов и сохранение пользовательских настроек. На Mac M1 остаётся ранее зафиксированный отдельный runtime blocker; его native socket не изменялся.
