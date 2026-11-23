---
name: native-recovery
description: Ремонт Rust-автовозобновления Agent Herder, когда существующий чат Codex, OpenCode или браузерного адаптера после сбоя приходится продолжать вручную.
---

# Техническое продолжение чата

Начни с указанного пользователем чата и последнего незавершённого хода. Сохрани статус работающего owner, последний нативный input/turn и уже существующую квитанцию. Для старой задачи сначала прочитай её рабочую ветку и последний результат стенда. Различай native trigger `goal` (источник уже начатого Codex turn) и Goal-state Herder: первый может идентифицировать turn для recovery, второй управляет новой работой в autopilot и не является recovery gate. Повторяй проверку, если изменился код, артефакт, входное событие или найден конкретный дефект в самой проверке.

На один такой дефект ориентир владельца — 30 минут. За первые пять минут локализуй границу, где пропал повтор. Затем воспроизведи один случай на фиктивной модели, исправь эту границу и повтори тот же тест. Оставшееся время используй для сборки, штатного выпуска или проверки конкретного препятствия. По истечении ориентира сообщи достигнутый результат и действие, которое меняет ситуацию.

1. Поток идёт через Rust `SessionRecovery`. Проверяй исходный чат, модель и провайдера, число принятых вводов и квитанцию. Целями и выбором следующей задачи занимается автопилот. Явный HumanStop сохраняется до снятия владельцем. Транспортное прерывание и неизвестная причина технической ошибки означают незавершённую работу. Недоступную квитанцию сверяй по существующей попытке. Резерв допустим после доказанного сбоя повтора при поддержке адаптера, разрешении проекта и доступной квоте.
2. Используй fixture-команды из `.github/workflows/fleet-session.yml`; они требуют Linux, bubblewrap, loopback-only network namespaces, pinned Codex/OpenCode и Rust binaries. Codex:

   ```sh
   python3 -uB tests/native/codex_recovery_stand.py --codex "$codex_bin" --owner "$owner_bin" --same-route-429
   python3 -uB tests/native/codex_recovery_stand.py --codex "$codex_bin" --owner "$owner_bin"
   ```

   OpenCode:

   ```sh
   python3 -uB tests/native/launch.py --ro-bind "$owner_bin" --ro-bind "$PWD/crates/herder/src/store" -- \
     python3 -uB "$PWD/tests/native/opencode_recovery_stand.py" \
     --opencode "$opencode_bin" --core "$owner_bin" --schema-dir "$PWD/crates/herder/src/store"
   ```

   Первый запуск Codex покрывает same-route 429, второй — fallback и restart. `launch.py` создаёт loopback-only network namespace и отдельные bubblewrap sandbox для fake HTTP model и клиента. Сам OpenCode stand внутри клиентского sandbox создаёт project, профиль owner, HTTP fixture и записи сценариев. Не запускай stand напрямую, если нужна CI-эквивалентная изоляция. Оба пути сверяют native IDs/receipts и защищённые чаты. Fake provider не расходует внешнюю квоту.
3. Для Herder extension используй существующий fixture с disposable Chrome:

   ```sh
   python3 -uB tests/native/browser_adapter_smoke.py --bin-dir "$bin_dir" --extension \
     --harness chatgpt --surface mcp --content text --iterations 1 --output "$output_dir/delivery"
   python3 -uB tests/native/browser_adapter_smoke.py --bin-dir "$bin_dir" --extension \
     --recovery success --output "$output_dir/recovery"
   ```

   В CI сценарии `failed-retry`, `lost-receipt`, `lost-ack` и `stale` проверяют число отправок при повторном сбое, потере ответа и новом вводе. Сценарий `zai-refusal` передаёт неподтверждённую пару ID и ожидает ноль кликов. Обычную отправку оба сайта проходят через расширение в изолированном Chrome. Для рабочего профиля укажи отдельную квитанцию установленного процесса.
4. На выпуск возьми один проверенный SHA. Подготовленный план передай команде `herder-recovery-rollout --plan <plan> --host <узел>`. Убедись, что план выбирает этот SHA, держит аренду и сохраняет прежний селектор для отката. При уже начатой операции работай с её квитанциями. При потерянном ACK сопоставь именно эту операцию с запущенным процессом. При отсутствии исторического доказательства назови недостающее поле и продолжи независимую часть работы.
5. В отчёте укажи, где воспроизводится результат. Для выпуска нужны установленный SHA и чтение через штатного потребителя. Для боевого 429 дождись естественного события и сверь исходный ход, один новый ход, прежний чат и маршрут. Ручная отправка «Продолжай» меняет чат и лишает наблюдение доказательной силы.

Спецификации в репозитории Agent Herder находятся в `docs/system/recovery.md`, `docs/system/browser-extension.md` и `docs/system/releases.md`.
