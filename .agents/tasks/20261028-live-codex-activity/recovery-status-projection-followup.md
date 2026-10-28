# Остаток проекции статуса, обнаруженный при reboot acceptance

29.10.2026,01:32–01:34MSK. Herder139d877 сам продолжил4сессии после повторного reboot100. Native API подтверждает новые turn IDs, status=inProgress и новые commentary после принятия. При этом `/api/sessions/codex/<id>/details?limit=3&quick=1` возвращает session.status=idle при session.meta.nativeLastTurn.status=inProgress. Пример ExManager01a17e2e, новый ход01a184a4-8a01-7031-abe9-b6cda61125a6.

Это не отказ реального восстановления; это отдельная несовместимость верхнего статуса с native-ходом. Число работающих сессий/Widget нельзя принимать по этому ответу. Минимальный следующий шаг в прежнем UI/status scope: сопоставить свежую native active-turn identity с toSession/getSession и list snapshot, показать работающий ход без присвоения running завершённому/устаревшему turn. После source fix проверить тот же exact native ID через обычную страницу и счётчик. Не создавать/не возобновлять сессию ради этой проверки.

Исходники проекции не изменены в reboot delivery, чтобы не расширять текущий выпуск. Этот конкретный остаток сохраняется вместе с ранее не принятой пользователем визуальной parity-задачей; её завершение не заявляется.
