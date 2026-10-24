# Восстановить Codex → Mavis C2 через существующий Herder

Режим quickfix: точный существующий маршрут. До: свежий C2 виден в inventory, но direct/read/route дают разные identity/errors. После: тот же точный nativeID читается через Herder; одна новая разрешённая содержательная директива имеет native receipt и ответ/readback. Старый UNKNOWN input не повторяется.

## Plan
Цель: исправить существующий Codex → Mavis C2 маршрут и проверить уже существующий общий межагентный чат.
Бизнес-результат: точная доставка новой директивы единственному владельцу C2 без replay старого UNKNOWN, без параллельного deploy/sync.
Декомпозиция: 3 листа · 1 параллельно · 3 волны · слотов: 1

✅ (Воспроизвести identity failure и найти существующий чат) завершена: exact native C2 current turn Running; Herder legacy scan timeout; existing system chat same-file hash verified from Mac
  Приёмка: exact nativeID/owner/route read-only, чат прочитан штатным lhc_chat; предыдущий UNKNOWN сохранён.
✅ (Исправить точный Herder маршрут и установить owned delta) завершена: source RED/GREEN, installed M1 cbc4cc2 / server100 1deb355, independent exact route readback
  Приёмка: обязательный быстрый RED→fix→GREEN, затем installed affected read/capability proof.
✅ (Передать одну новую директиву и получить реальный readback) завершена: ONE native admission, exact new user anchor, собственный ответ C2, два успешных чтения ресурсов и следующий шаг
  Приёмка: Root получил read-only checkpoint, новый stable inputId принят native interface и найден реальный ответ; queue ACK не PASS.

## Границы
Native C2 mvs_f70ce650bbf94d789e4e4a2669f6743a, runtime MacBook-Pro-User.local, code100/exmanager. Старый exmanager-c2-native-deploy-handoff-20261024-r1 UNKNOWN не replay. Source canonical main, чужой WIP/index/jobs сохранены; новых worktree/веток/сессий нет. ExManager/Airlock/LHC source/deploy/credentials/accounts и GUI не меняются. Людям сообщений/звонков нет.

## Подтверждённый итог

Все 3 листа завершены. Исправлены live exact read, обязательный quick-details prerequisite на M1, независимая native identity проверка, steer активного turn и targeted bootstrap существующего remote peer. Source/main опубликован; runtime100 1deb355, M1 cbc4cc2. Единственная новая директива принята в текущий turn; C2 прочитал handoff и существующий общий канал и назвал следующий шаг. Старый UNKNOWN и три прежних queued item сохранены; новых чатов/сессий нет. Подробные IDs/SHA и границы доказательств: result.md и independent-review.md.

## Продолжение: связь и readback / уточнение defaultsteer

Current connection/readback завершён отдельно от прежней доставки: route доступен без ремонта, nativecurrentstate2/newturn8cddb, три20s health reads и independent exact host-scoped consumer PASS. Astra input `exmanager-c2-astra-narrow-release-20261024-r1` остаётся UNKNOWN в проверенном native-visible scope; native sends/replay0. См. continuation-connection-brief.md и верх result.md.

По последующему прямому поручению schema/legacy defaultsend_message изменён sync→steer, descriptions поясняют explicitsteer и intentional deferred queue/hours. Sourceb8f8470/18focusedGREEN/tscGREEN; installed100/M1b8f8470 и freshMCPtools/listdefaultsteerPASS. Explicitqueue/sync и inactive/HumanStop/humanRequested guards сохранены. Новой отправки нет. Старые proof/план не мигрировались и не потеряны.
