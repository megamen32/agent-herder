# V055CREATE delta-review: SUPPORTED

Astra, 2026-11-07. Проверен чистый HEAD
`309fd82190e04070747cc87c9745a2a5efce85f1` в herder-v1-fixture.

Оба native порта используют create_address. Доказанный отказ до отправки
передаётся typed вариантом DefinitelyNotSent и через async NativeCreateOutcome,
и через bounded SubmitError. Возможная отправка с непригодной квитанцией
остаётся Unknown. Ошибка не превращается в разрешение повторить запрос.

Оба application пути вызывают один mark_create_rejected. BEGIN IMMEDIATE
охватывает переход точного dispatching intent без receipt в rejected и запись
диагностики связанной Task. UPDATE проверяет intent, principal, target,
request key, payload hash и число изменённых строк. Любая ошибка/несовпадение
откатывает транзакцию. Уникальная связь intents.task_id исключает обновление
нескольких Task. Недоказанный внешний эффект по-прежнему сохраняется unknown.

Независимые проверки:

```text
cargo test --offline --manifest-path crates/herder/Cargo.toml \
  --test create_mapping --test scoped_stop_gate --test target_port
create_mapping: 5 passed
scoped_stop_gate: 19 passed, 1 ignored
target_port: 1 passed

cargo test --offline --manifest-path crates/herder/Cargo.toml \
  --lib adapters::codex::create
3 passed, 0 failed
```

Итого 28 passed, 1 ignored. Проверены persisted reason после reopen,
тот же ключ без второго create, возможность независимого нового ключа,
совпадение двух native портов и отсутствие thread/start при invalid key.
Существующие uncertain-create и persist-failure проверки также прошли.
Ignored native сценарий не запускался; production MCP не проверен.

Граница: записана диагностика в Task.result_json. Это не доказательство
терминального статуса MCP Task; tasks.status в этом helper не обновляется.
Публичная Task lifecycle композиция должна показать реальный итог consumer.
Внешняя диагностика должна пояснять конкретное поле/ожидаемое значение,
а не отдавать только внутреннее "invalid create request key".
