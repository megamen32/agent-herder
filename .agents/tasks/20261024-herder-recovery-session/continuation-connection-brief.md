# Продолжение 24 октября: connection/readback ONLY

После принятой доставки owner-directive поступил новый UNKNOWN input `exmanager-c2-astra-narrow-release-20261024-r1`: SSH255/banner timeout, native receipt отсутствует. Ни его, ни прежний owner-directive не повторять. Новых сообщений нет.

План quickfix, 3 последовательных листа:
1. Диагностировать существующий reverse SSH/listener/bootstrap/native health и exact host identity.
2. Восстановить существующий маршрут только при воспроизводимом дефекте; source defect требует RED→fix→GREEN. Никаких новых services, SDK, GUI, портов, моделей или сессий.
3. Первым native действием прочитать exact C2/current controller/очередь и существующий UNKNOWN input. Затем проверить исправленный существующий Herder read/send capability без отправки и опубликовать пределы readback.

Исходный архив и предыдущие proof сохраняются. Foreign WIP/index/jobs/queues не меняются. Source/installed/consumer claims отдельные. Live первый SSH probe уже exit0: MacBook-Pro-User.local / MacBook-Pro-User / MacBookPro18,2 / arm64; это доступность сейчас, не доказательство старой доставки и не объяснение прошлого timeout.

## Подтверждённое завершение

1. Existing reverseSSH с первого probe доступен; identity/current controller и три snapshots20s подтверждены. Историческая причина255 неизвестна.
2. Восстановительных мутаций/sourcefix не потребовалось. Remoteagent_info и ownerM1fleet_session_view работают; независимый reviewer подтвердил current route.
3. Exact Astra input mapping/content marker проверен, bounded40-message window пересекает attempt и queue не содержат exactID. Исходный outcome остаётся UNKNOWN, повтор запрещён. Новых C2send0.

Отдельное последующее поручение пользователя: schema defaultsend_message sync→steer и descriptions. Sourceb8f8470,18tests/tscGREEN, actualtools/list100/M1steerdefaultPASS; только Herder restarts и owned3-module payload, без native sends/SDK/GUI/ExManager изменений. Полные актуальные результаты — result.md/progress.json. Прежний dashboard сохранён как архив предыдущего принятого этапа; несвязанная миграция старого плана не выполнялась.
