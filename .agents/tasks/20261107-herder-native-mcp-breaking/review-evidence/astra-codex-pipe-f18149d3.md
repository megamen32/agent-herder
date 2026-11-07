# V055PIPE delta-review: SUPPORTED для request pipe fix

Astra, 07.11.2026. Чистый проверенный HEAD
`f18149d33632e1927a61ab8912e4f4716fb4477d` в herder-v1-fixture.
Изменён только `adapters/codex/connection.rs`.

- Deadline вычисляется до кодирования и записи; ожидание ответа использует
  оставшееся время того же deadline.
- Unix pipe переведена в O_NONBLOCK; poll ограничен остатком времени.
  EINTR/EAGAIN ведут к повторной проверке deadline, не к новому RPC.
- На любой write error stdin закрывается. Частичный JSON record не смешивается
  со следующим запросом; следующий request возвращает NotRunning.
- Выполнение записи синхронное в вызывающем потоке, production writer thread
  не создаётся. После возврата helper не продолжает писать.
- Исходные fd status flags сохраняются и восстанавливаются. Если восстановление
  не удалось после успешной записи, результат остаётся неопределённым и поток
  закрывается, что не разрешает replay.
- ChildStdin не использует пользовательский буфер, поэтому отдельный flush не
  нужен. Его fd принадлежит connection; API требует &mut self, а control
  сериализует доступ через mutex. Reader thread использует другой stdout fd.
- POLLERR/HUP не трактуются как успех: последующая неблокирующая write возвращает
  ошибку, после чего поток закрывается.

Независимая проверка без реальной модели или native пользовательских сессий:

```sh
cargo test --offline --manifest-path crates/herder/Cargo.toml --lib adapters::codex
```

Граница: это устранение блокирующей request write, а не общий bounded handoff.
`control.state.lock()` пока блокирующий; штатный sync API и общий deadline
на уровень control остаются V055BOUND. Notify/инициализация и открытие процесса
не объявлены bounded этим изменением. Существующий map_rpc_error сохраняет
write error как UNKNOWN; другой ключ не обходит core uncertainty fence.
Полная production create/deliver/read/stop приёмка не выполнена этим review.
