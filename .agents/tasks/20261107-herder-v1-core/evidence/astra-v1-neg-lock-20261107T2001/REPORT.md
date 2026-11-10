# Изоляция release receipt test

Attempt: astra-v1-neg-lock-20261107T2001. Executor: Archimedes. Lead: Astra.

## RED

Отдельный тест проходил. В штатном параллельном запуске библиотечного test binary воспроизведён ровно исходный отказ: release_receipt.rs:493, contender.try_lock().unwrap(), WouldBlock. Лог: default-high-before-04.log; итог 177 PASS / 1 FAIL.

## Изменение

Только блок #[cfg(test)] в crates/herder/src/ownership/release_receipt.rs, +24 строки. Внешний тест запускает этот exact test в отдельном процессе текущего test binary с --test-threads=1. Environment marker задаётся только дочернему процессу через Command::env; глобальный environment не меняется. Исходные проверки durable/idempotent receipt, changed payload, inherited lock и immediate release не ослаблены, retry не добавлен.

Fixture использует уникальный каталог PID+nanoseconds. Его immediate lock-release assertion конфликтует с общей descriptor table параллельного test runner: соседний fork способен временно сохранить копию open file description до exec даже при CLOEXEC. Отдельный процесс исключает это вмешательство. Конкретный чужой PID/FD в момент исходного отказа не захвачен; доказаны parallel-only RED и отсутствие повторения после process isolation.

## GREEN

Isolated exact test PASS. После правки целевой тест PASS во всех 8 прогонах полной библиотеки: 6 со штатной параллельностью, 2 с --test-threads=32. Из них 4 полных прогона 178/178; остальные имеют отдельные Codex fixture failures и не считаются global GREEN. Все summaries и имена failures сохранены в result.json и parallel-after-*.log.

Отдельные наблюдённые дефекты вне scope: Codex control/create ExecutableFileBusy (ETXTBSY), последующий PoisonError; Codex connection stalled_pipe_obeys_request_deadline_and_is_not_reused. Они не исправлялись и требуют владельца соответствующих тестов.

Production section перед #[cfg(test)] побайтно совпадает с HEAD. git diff --check passed. Lease policy/runtime/catalog/credentials не менялись. Нет stage/commit/push. Для повторения: cargo test --manifest-path crates/herder/Cargo.toml --lib ownership::release_receipt::tests::admission_receipt_is_durable_idempotent_and_rejects_changed_payload -- --exact --nocapture. Полные серии запускали собранный cargo test binary напрямую.

Source SHA256: 75ae535edb6e275472ab5559819519b3382a7c6dd606ec4aba7663f1e8364468
