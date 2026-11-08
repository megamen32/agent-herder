# Tasks working: ограниченный Rust triage и исправление consumer evidence

Дата: 2026-11-08. Исследован source aa1111019d77503eabd05b8ac8bb1b826148c774
в `/home/roomhacker/.codex/worktrees/herder-final-acceptance/agent-herder`.
Live create/send/read/archive HTTP, browser runtime, profiles и чужие процессы
не изменялись. Rust source не менялся: подтверждённого Rust codebug нет.

## Сохранённые доказательства

Исходный receipt:
`/home/roomhacker/herder-artifacts/ci-runs/multi-chatgpt-aa111101-1803/receipt.json`.
Обе owner SQLite прочитаны только через `file:...?mode=ro`.

| Состояние | Account0 | Account1 |
|---|---|---|
| Public task | `create-operation:086ce0735c08f829f01a4bcf61ee5642` | `create-operation:f37fa8ad03afc9bf42e9713ad33407b0` |
| Session ref | `session:425e505dae7cf460d6050b44273c00b0` | `session:f4f66b20c1dee87e05fbe2bc02543bef` |
| Native binding | `chatgpt::draft%3Af913afa5-0fe6-49eb-883d-ab7d3e0ed4f8` | `chatgpt::draft%3A61f46d41-cf91-4f14-9a40-0673a51bac20` |
| Receipt message ID | `180f55b3-134e-4367-8a2e-5d09136095a8` | `34509429-60df-47df-885b-df39d4ad5f9f` |
| Public task created, UTC | 15:06:27 | 15:12:10 |
| Public task observed | working; child admitted | completed 15:13:45; child confirmed |

Account1 подтверждён через 95 секунд после выдачи task. У обоих create/child
intent timestamps предшествуют public task (account0 15:03:53, account1
15:09:29): это начало составной операции, не момент native admission.
Нельзя приписывать всё это время одному RPC.

Сохранённый `/tmp/herder-multi-browser-readback.json` показывает account0
на `/c/6af08fbd-7128-83e9-953e-911afbb106b4` с его marker,
generating=false и draft=false. Этот readback не содержит native user message ID
и не заменяет точное подтверждение квитанции. `/tmp/herder-multi-aa111101.log`
пуст; исходный receipt не содержит промежуточных Tasks poll durations/responses.

## Подтверждённый путь и предел вывода

`owner_multi.rs::get_task` выбирает единственного owner через `has_task`;
lookup не вызывает native adapter. Затем
`mcp_task_server.rs::get_task` ожидает `spawn_blocking` reconcile.
`task_reconcile.rs` разрешает aggregate в его exact child task, получает текущий
session read grant и проверяет сохранённую квитанцию вне gate/DB transaction.
Aggregate завершается только после подтверждения child receipt.

`crates/herder/src/adapters/ahap_opencode.rs::reconcile` для message receipt
вызывает `messages(target, 200)` и требует единственное сообщение с точным ID
и role=user. В immutable aa111101 browser runner при `limit > 100` ChatGPT
использует `getRawConversation`, а не обычный `getMessages`. Для draft этот путь
включает `getChat`, refresh turn state, account проверки и полный chunk transfer.
Admission использует `getMessages`, с допустимым DOM receipt fallback. Поэтому
подтверждённая отправка и видимый ответ не гарантируют успешность последующего
более длинного пути чтения. Этот route передан владельцу TS separation.

Где именно затрачены исходные 150 секунд, сохранённые данные не устанавливают.
AHAP browser RPC имеет 120s deadline; старый consumer проверял 150s только между
polls и не передавал оставшийся бюджет внутрь RPC. Это объясняет возможность
превышения общего ожидания, но не доказывает timeout конкретного AHAP вызова.
Повышение timeout и Rust fix без RED доказательства не выполнялись.

## Выполненные изолированные Rust проверки

Все команды использовали `cargo test --manifest-path crates/herder/Cargo.toml`:

- `--test scoped_stop_gate scoped_create_application_wire_preserves_session_and_deduplicates_prompt -- --exact --nocapture`: PASS, 1 test.
- `--test scoped_stop_gate task_reconciliation_checks_exact_receipt_without_holding_gate_or_transaction -- --exact`: PASS, 1 test.
- `--test scoped_stop_gate direct_delivery_task_uses_current_exact_policy_after_reopen -- --exact`: PASS, 1 test.
- `--test launcher_scoped_profile one_core_routes_two_chatgpt_accounts_and_restores_tasks_after_restart -- --exact --nocapture`: PASS, 1 test; локальные Python AHAP fixtures, отдельные stores, без browser/model.

## Подтверждённый consumer defect и RED → GREEN

`tests/native/v1_multi_browser_stand.py` присваивал `session_ref` только после
успешного `wait_task`. Timeout принятой create-operation оставлял созданный chat
без cleanup identity, а helper терял промежуточные Tasks ответы и длительности.

RED: `python3 tests/native/test-v1-multi-browser-stand.py -v` на прежнем stand:
две ошибки проверки потерянного session_ref и отсутствие stage parameter.
Fake RPC возвращал working task при уже записанных create aggregate/session
binding в локальной SQLite. Никакие реальные RPC/process/browser не запускались.

Исправление только в stand:

- Все `tasks/get` сохраняются до/после вызова: task ID, UTC start, оставшийся
  timeout, duration_ms, полный result response либо error; RPC ограничен остатком
  150s бюджета, а не собственным 300s default.
- До ожидания task сохраняется session_ref из exact create-operation в
  profile SQLite `mode=ro`, с principal, instance и session binding проверками.
  Недоступное чтение записывает ошибку; bounded recovery повторяется перед cleanup.
- RPC timeout прекращает дальнейшие запросы на старом JSONL stream. Собственный
  core можно reopen с теми же profiles только для существующего cleanup; create
  и deliver не повторяются. Неизвестный исход archive не повторяется.
- `--stage candidate|installed` обязателен; Python `run(..., stage=...)` также
  требует явное значение. Запускается core только из переданного проверенного
  manifest; receipt хранит manifest hash и фактически построенный argv.
  Имя stage само по себе не доказывает установленный production consumer.

GREEN: та же команда, 6 tests PASS. Проверены working timeout, RPC timeout,
сохранность polls на диске до cleanup, exact cleanup session, отсутствие повторной
mutation, новый stream после RPC timeout, explicit installed stage, invalid stage,
terminal result и отказ recovery при чужом principal/instance. `git diff --check`
пройден. Это source/fakeRPC proof; исходная операция не переигрывалась, новая
candidate/installed live приёмка этим отчётом не заявляется.

Commit/push не выполнялись. Интегратору переданы три пути: stand, его локальный
unittest и этот evidence report. Иные source paths не изменены.
