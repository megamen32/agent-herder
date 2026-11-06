# Координация и восстановление контекста — v1, нулевая ревизия

Контракт новой реализации; [архитектура](RUST-DESIGN.md), [файловое владение](RECOVERY-STORAGE.md).

## Хранение и доверие

Node → HarnessInstance → Session. Self определяется проверенной привязкой MCP principal к native session/instance. Общий токен ноды и переданный session_ref недостаточны. Без привязки чтение чужих разрешённых сессий возможно по ACL, но `session(view=context)` возвращает `caller_identity_missing` и точную инструкцию привязки; угадывания по последней активной сессии нет.

`created_by` сохраняется вместе с create intent до native вызова и связывается с фактическим native ID после admission. Отдельно хранятся `native_parent_ref`, provenance, creation_request_ref. Sender не переписывает creator, parent не выдаёт прав. У внешних сессий происхождение может быть unknown. Для cross-node creation source principal подтверждается transport identity/делегированными scope, не текстовым заголовком.

Correspondence: message_ref, verified principal/sender_session_ref, recipient_ref, in_reply_to, request_key, payload/resource ref, native receipt, delivery state. Всё долговечно в SQLite, независимо от model transcript. История мимо Herder имеет явно неполный coverage. Retention текста не удаляет дедупликацию эффекта: tombstone сообщает, что текст удалён. Task TTL и срок receipt — разные величины.

Проект задаётся project_ref + проверенной repository identity; basename и title не идентичность. Worktree имеет node/path, git common-dir identity, branch, scope, task summary, observed_at. На разных нодах одинаковые пути не означают один checkout; общий диск требует одного resource identity. Декларация намерения не доказательство текущих файлов и не lease.

## Вызовы

- `session(view="context")`: кто я; creator и native parent; дети; последние собеседники; проект/соседи/деревья/конфликты; курсоры, coverage/freshness и готовые допустимые следующие вызовы.
- `session(view="messages", direction="inbound", cursor=...)`: журнал; `message_ref` позволяет прочитать конкретное сообщение. Read не означает понимание моделью.
- `deliver(reply_to=message_ref, message=..., request_key=...)`: адресует ответ сервером по исходному отправителю; caller должен быть получателем исходного сообщения. target вместе с reply_to запрещён схемой. Unknown sender даёт отказ до эффекта.
- `sessions(project_ref=...)`: фактический roster со временем наблюдения и недоступными источниками. Offline не значит «никого нет».
- `workspace(action="claim", resource_ref=..., claim_id=...)`: один атомарный победитель; при конфликте адрес владельца по ACL и способ выбрать отдельное worktree.

Обычный `session` возвращает последние user **и** assistant с turn ID/time, truncation и completeness. Не выдавать старый ответ за результат нового input. Context ограничен размером; omitted_count/cursors ведут к ресурсам, а не скрывают участников.

## Автоматическая осведомлённость

При создании, подключении и возобновлении поддерживаемый native hook получает карточку self/creator/project/peers/worktrees и точный вызов context. После компакции новая context generation получает snapshot, даже если fingerprint данных прежний. Где compact hook отсутствует, карточка инъектируется перед следующим поддерживаемым ходом/tool response; механизм и задержка явно отражены в capability. Клиент без точки инъекции получает ручной context, но автоматическое восстановление там не считается принятым.

Подписка доставляет изменения bridge, не напрямую «в память модели». Bridge сверяет актуальный turn, объединяет delta, не запускает новый ход ради heartbeat и не снимает STOP. Observed, injected, native readback и ответ модели — разные доказательства. После disconnect перечитывается snapshot/domain cursor, а не предполагаемый SSE replay.

Workspace claim не создаёт Git worktree и не делает merge. Это задача workflow. В основном checkout работают только при разрешённой политике проекта и claim; при конфликте используют отдельное дерево, сохраняя WIP. Ошибка владельца при отказе MCP разрешается через тот же authority по локальной инструкции; недоступность authority не создаёт второй authority.

## Приёмка

A создаёт B в другом harness; native parent B может отличаться от A. C пишет B. После очистки context и рестарта Herder B восстанавливает отдельно A и C и отвечает C по message_ref. Проверены точные native IDs и один admission ответа; следов чтения ресурса недостаточно для доказательства инъекции.

Два Codex, два OpenCode и два browser profiles изолированы. Совпадающий native ID в fixture не смешивает адреса; реальные профили доказывают независимость соединений. Две ноды сохраняют provenance и ACL, offline peer делает coverage partial. Гонка двух claim даёт одного владельца; rejected caller не читает чужую историю/адреса. UNKNOWN после admission сверяется, а не пересылается.
