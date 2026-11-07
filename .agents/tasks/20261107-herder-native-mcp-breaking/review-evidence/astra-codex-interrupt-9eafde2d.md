# V055STOP delta-review: SUPPORTED

Astra, 2026-11-07. Проверен `9eafde2d9dded79613e4441a2adefcda64c941b8`
в herder-v1-fixture. Изменение ограничено codex/control.rs.

Busy/poisoned mutex теперь даёт DefinitelyNotSent через try_lock до native
запроса. Единый Instant deadline передаётся в read_turn_status; каждая страница
получает только остаток времени. Preflight error не выдаётся за отправленный
interrupt. До turn/interrupt остаток проверяется снова.

Половина оставшегося времени выделена запросу interrupt, вторая доступна
для точного read-only подтверждения при потерянном ответе. Это не новый timeout
и не повторный interrupt. После потенциальной отправки неподтверждённый статус
остаётся OutcomeUnknown. Readback проверяет ту же пару thread/turn;
другой активный turn не выбирается. У connection нет фонового writer после
возврата; общий pipe deadline из f18149d3 сохранён.

Независимая Linux fixture-проверка:

```text
cargo test --offline --manifest-path crates/herder/Cargo.toml --lib adapters::codex
test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured;
92 filtered out; finished in 1.81s
```

Проверены новые busy и multi-page deadline cases, существующие exact-turn,
uncertain-send/readback и no-replay cases. Native пользовательские сессии,
реальная модель и Mac build не использовались. Это source acceptance
ограниченного interrupt; production MCP/launcher и create classification
остаются отдельными обязательными шагами. Bug Ba909b61b03a745309aaa можно
закрывать только со связанной сохранённой RED/GREEN парой автора.
