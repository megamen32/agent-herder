# Независимая проверка 45f0a716 — 07.11.2026

Verdict: REVISE только для согласованности search_page. Миграция, exact schema и old-writer fence поддержаны в заявленной source/isolated границе. Production caller и live migration не проверялись.

## Подтверждённый дефект

В 45f0a716 search/index.rs:141 coverage, :159 count и :176 hits читаются разными SELECT без общей read transaction. Reviewer Nietzsche воспроизвёл на двух SQLite connections такое расписание: A=other полный, B=hello полный; reader query hello/limit1 получает Complete/count1; updater атомарно меняет A на hello с truncated=true; reader получает A и next_offset=None. Ответ не соответствует ни старому, ни новому снимку и пропускает B. Это адресное SQL-level воспроизведение source-запросов, не запуск Rust-функции.

Минимальная правка: одна DEFERRED read transaction от coverage до полного чтения hits; корректно обработать уже открытую transaction. С такой transaction то же расписание возвращает согласованный старый ответ B/count1/Complete. Terra получила finding и запрос на детерминированный RED/GREEN без sleeps.

## Поддержанные свойства

EXCLUSIVE migration transaction охватывает exact-v3 validation, сверку authority с gate и DB inode, DDL и смену версии. Existing authority/mapping/hold не переписываются. Validator v4 включает FTS/shadow tables и отклоняет отличающиеся/лишние объекты. Штатный updater записывает FTS и guarded state одной transaction; отказ старого writer на state откатывает также FTS. Произвольный direct SQL не входит в эту модель защиты. ACL allowlist применяется до count и pagination; missing allowed state/FTS и truncated дают Partial при согласованном read snapshot.

## Ежечасное пробуждение

wait_1c84ce639ceae5e8029b19b7e73204eb не доставлен в 10:18:49 UTC: delivery_blocked, codex_quota_guard quota_unknown, receipt notSubmitted=true, admitted=false, nonRetryable=true. Повтор этого запроса не выполнялся, политика enabled/reserve20/onUnknown=block не менялась.

В 10:20:46 UTC штатный model_quotas получил официальный Codex reported/allowed=true/limit_reached=false, primary_used=76 (остаток24%). После повторной проверки отсутствия HumanStop и отсутствия waiting self-waits поставлен один следующий часовой контроль: wait_cfbc121fff04d9a86f4e1c89369fcabc, scheduledAt=2026-11-07T11:22:06.011Z (14:22 МСК). Отдельный status подтвердил waiting. Доставка этого будущего вызова пока не доказана.
