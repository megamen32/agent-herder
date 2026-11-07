# Независимый review HumanStop: REVISE

Проверяющий: Astra. 07.11.2026. Диапазон `740ac97f..5c491e4c`.
Исходный checkout Tesla при начале проверки чистый, HEAD
`5c491e4c4eacca8d1719b86a3713ef0d9bc4f0e4`.
Продуктовые исходники не менялись. Native ignored test не запускался;
новых отправок и interruption не было.

## Исправить до принятия

1. **B2516eb97e1884dec8a50 — ложный UNKNOWN.**
   `ScopedAuthority::handoff` сохраняет квитанцию только из `Ok(Admission)`;
   `Err(SubmitError::DefinitelyNotSent { reason })` попадает в ту же ветку,
   что неопределённый исход. Она пишет `intents.state=unknown`.
   `scope_unsettled` затем запрещает любой новый intent для этой сессии.
   Но контракт `DefinitelyNotSent` доказывает отсутствие native submission;
   CodexControl действительно возвращает такую ошибку при preflight-отказах.
   Нужны отдельный durable rejected/effect=none результат с диагностикой и
   завершённая запись handoff. Старый ключ автоматически не исполнять повторно.
   Минимальная проверка: fake bounded control возвращает DefinitelyNotSent;
   после reopen состояние не unknown, старый ключ не вызывает второй submit,
   новый независимый запрос не блокируется ложным unsettled состоянием.
   Настоящий OutcomeUnknown остаётся fenced и не повторяется.

2. **B6e745bbdeb2d473899e9 — непостоянный отказ положительного пути.**
   Обычный объединённый прогон ниже завершился exit 101: pinned 1 PASS,
   schema 2 PASS; scoped 16 PASS, 1 FAIL, 1 ignored. Упал
   `delivery_requires_authority_exact_instance_and_snapshot_before_fake_submit`
   в `tests/scoped_stop_gate.rs:1571`, ожидание `Admitted`.
   Assertion через `matches!` не показывает полученную ошибку.
   Отдельный exact rerun прошёл; второй объединённый прогон прошёл
   (scoped 17 PASS, 1 ignored; target_port 1 PASS).
   Это оставляет необъяснённую нестабильность, а не отменяет первый отказ.
   Минимальный следующий шаг: показать фактический result в assertion,
   найти источник отказа при параллельных тестах и сохранить воспроизведение.
   Не ослаблять ACL/authority и не скрывать проблему одним зелёным rerun.

Команда независимой проверки:

```sh
cargo test --offline --manifest-path crates/herder/Cargo.toml \
  --test scoped_stop_gate --test humanstop_schema_v3 \
  --test humanstop_gate_pinned --test target_port
```

## Что подтверждено в ограниченном candidate

- Одна authority использует общий pinned gate для create/claim/handoff/stop;
  handoff повторно проверяет immutable mapping, authority/scope generation и
  holds. Короткая SQLite transaction завершается до native вызова; OS gate
  удерживается через bounded admission, не через модельный ответ.
- Стоп до handoff не вызывает submit; если handoff выиграл, stop хранит hold
  и сообщает необходимость interrupt/reconcile. Отдельный OS process в тестах
  входит в тот же application path через управляемые барьеры.
- Схема v2->v3 применяется явно. Старый writer fenced, существующие mapping
  остаются читаемыми новым writer; удаление обязательного trigger отклоняется.
- Native address уникален в session_bindings; replace/update/delete mapping
  запрещены. Authority и запечатанный scope set неизменяемы. Смена pinned
  inode, symlink/hardlink и общедоступный каталог отвергаются.
- Прежние три positive/restart/UNKNOWN теста не просто удалены: перенесены в
  scoped_stop_gate под прежними именами. В них сохранены receipt после reopen,
  отсутствие повторного submit и crash после possible handoff.
- Импортированные и родительские сессии не получают новую authority по
  предположению; поддержан только явный изолированный fresh root с global и
  собственным session scope. Полной поддержки ancestor/alias/cutover это не
  доказывает.

## Граница заключения

Описанный live Codex результат — evidence исполнителя; Astra его повторно не
воспроизводила. Тестовый one-poll wrapper явно не production bounded port.
Обычный MCP launcher не строит ScopedAuthority, а unscoped dispatch остаётся
закрыт. Общий V025/E001, production authority, legacy cutover, Mac native gate
и реальные входы stop/release не приняты этой проверкой. После двух исправлений
нужен delta-review; после подключения production port — отдельная приёмка
реального публичного create/deliver/read/stop пути.
