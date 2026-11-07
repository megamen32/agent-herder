# Delta-review HumanStop: SUPPORTED для scoped candidate

Проверяющий: Astra. 07.11.2026. Delta `5c491e4c..ef7d145b`.
Проверенный чистый HEAD: `ef7d145bd81e62699a251700329a5c1f01333163`.
Это заменяет REVISE предыдущего review только в отношении двух найденных
дефектов и допуска исходников к интеграции. V025/E001 production PASS не дан.

## Durable rejection

`DefinitelyNotSent` имеет отдельный результат. Одна IMMEDIATE transaction
сохраняет rejected intent, finished handoff и причину в task result. Проверка
числа изменённых строк требует ровно одну запись каждого вида; при несовпадении
происходит rollback, а не частичный успех. До commit продолжает удерживаться
gate. Сбой записи не превращается в разрешение повторного submit.

Регрессия читает сохранённый результат через отдельное соединение: rejected
и причина присутствуют. Повтор старого ключа не вызывает второй handoff;
новый независимый ключ допускается. Прежние UNKNOWN/no-replay тесты продолжают
проходить. Для обычного клиента чтение этой диагностики проверяется отдельно
при подключении MCP/Task handlers.

## Явный unlock

Guard владеет независимо открытым File и освобождает flock при Drop.
Дубликат дескриптора может пережить guard, поэтому одного close недостаточно:
lock относится к общему open-file-description. Новый тест детерминированно
удерживает duplicate, уничтожает guard и проверяет успешное независимое
приобретение. Проверка выполнялась вместе с межпроцессными handoff/stop
барьерами; исключение mutual exclusion не внесено.

Условия корректности сохраняются: guard удерживается до окончания bounded
handoff; из handoff не выходит продолжающий писать дочерний процесс или
отложенная операция. Владение этим gate нельзя передавать дочернему writer
по аналогии с resource lease, удерживаемым дочерним процессом. Это временная
блокировка конкретной критической секции. Проверка production port обязана
сохранить этот контракт. Нельзя заменять его только запуском async future.

## Независимая проверка

В исходном чистом worktree Tesla без изменений исходников выполнено:

```sh
cargo test --offline --manifest-path crates/herder/Cargo.toml \
  --test scoped_stop_gate --test humanstop_schema_v3 \
  --test humanstop_gate_pinned --test target_port
```

Результат exit 0: pinned 2 PASS, schema 2 PASS, scoped 18 PASS/1 ignored,
target_port 1 PASS. Итого 23 PASS, 1 ignored. Native live тест намеренно не
запускался, новых native отправок и interrupt не было. Сообщённые исполнителем
20 последовательных прогонов не выдаются за собственные 20 прогонов Astra.

## Следующий шаг

Terra интегрирует проверенную серию на актуальный main с сохранением чужих
изменений и проверяет объединённый код. Затем отдельно production bounded
port/launcher и публичный create/deliver/read/stop. Старые authority, aliases
и ancestors при cutover, release path и платформы вне scoped Linux candidate
по-прежнему требуют своих доказательств. Эти ограничения не повод заново
разрабатывать или откладывать уже проверенный scoped gate.
