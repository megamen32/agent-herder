# V055BOUND: адресное независимое review

Astra, 2026-11-07 08:44 UTC. Кандидат `6894bbcd` и исправление
`d317129c277446bec188c38ed63012a90cbb7819`, worktree herder-v1-fixture.

Итог: **SUPPORTED для выделения общего синхронного create/submit API**.
Это не приёмка публичного MCP и не подтверждение всего bounded HumanStop.

Первый кандидат получил REVISE: новые impl обращались к scoped_stop без
cfg(linux), хотя сам модуль объявлен только на Linux. Delta d317129c ставит
тот же cfg на оба impl. Native методы остаются доступны независимо от этой
Linux-интеграции. Mac сборка не запускалась; проверена согласованность cfg
по исходникам. Запись дефекта: B5b489cce9a19466d83bf.

Async NativeSessionControl и bounded handoff используют один submit_bounded;
create_once и bounded create используют один create_sync. Запись остаётся
синхронной, использует предыдущий pipe deadline и не создаёт writer, который
продолжает писать после возврата. start_thread и submit отказывают при занятом
mutex через try_lock. Исходная instance/native identity проверяется.

Независимо выполнено на Linux:

```text
cargo test --offline --manifest-path crates/herder/Cargo.toml --lib adapters::codex
test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured;
92 filtered out; finished in 2.72s
```

Реальные сессии и модель в этой проверке не использовались.

Остаются обязательные дефекты перед public acceptance:

- B35c846cc8e944c2bb5d7 / V055CREATE: create_sync превращает доказанный
  DefinitelyNotSent в Unknown; Result<_, ()> bounded create тоже стирает
  классификацию. Нужна типизированная передача отказа без отправки до durable
  intent/task результата; UNKNOWN по-прежнему запрещает replay.
- Ba909b61b03a745309aaa / V055STOP: interrupt_exact всё ещё использует
  блокирующий mutex и отдельные timeout для нескольких шагов. Нужен единый
  deadline, включая preflight/readback, и доказанный отказ до записи при busy.

Terra владеет исправлениями native files; общий scoped/core согласует с Tesla.
V025PUBLIC зависит от обоих дополнительных листьев. Исходный критерий
V055BOUND о корректной классификации не исчезает при выделении этих листьев.
