# Astra: Tasks review и контроль исполнения — 07.11.2026 10:44 UTC

Независимый reviewer Nietzsche проверил immutable `12f0d3a9 + 6c746784`. Вердикт: SUPPORTED для durable source Tasks projection; REVISE для утверждения о terminal native consumer. Авторские 29 passed + 1 ignored reviewer повторно не запускал.

## Принятая граница

Стандартные rmcp CreateTaskResult/GetTaskResult; Tasks capability проверяется до эффекта. Чтение Task требует доверенную identity, task/intent principal, authority generation и exact Session Read grant даже для terminal результата. HumanStop и adapter refusal имеют разные диагностические категории; UNKNOWN не превращается в доказанный no-send. Terminal status/result сохраняются вместе; confirmed требует точной привязки receipt, повтор request key/payload не отправляет заново.

## Отсутствующий переход

В `application/scoped_stop/mcp_task.rs` admitted всегда Working. tasks/get, repeat deliver и session/messages не вызывают read-only `application/reconcile.rs::reconcile_stored_receipt` и не сохраняют наблюдение. Тест `tests/scoped_stop_gate.rs:3513` в 6c746784 выставляет confirmed прямым SQL. Следовательно принятая доставка может навсегда остаться Working после reopen.

Tesla получил V025TASKRECON: read-only exact receipt reconciliation + fenced persistence; matching → completed → reopen, mismatch не confirmed, повтор delivery submit count=1. Ручной SQL заменить проверяемым application path. Canonical bug B1a5bccfdace749a4ae22 открыт, фикса пока нет.

Create aggregate и recovery в более позднем immutable d1f38cff (a4d57e8d/9d00677a) переданы тому же reviewer отдельно; этот документ не принимает их заранее.

## Исполнение

Каждая из восьми сессий проверена отдельным wait_threads timeoutMs:0. На 10:41UTC работали legacy CI и дополнительный Tesla; Terra/resources/browser/ZCode завершили ходы с остатком, возобновлены конкретными поручениями. Повторный readback подтверждает все четыре active и полезные действия. Исходные translator/Codex/OpenCode имеют явно зафиксированные отказы по intake/approval, повторных сообщений им нет.

Terra делает trusted owner stdio wiring → scoped application/native Reader; default Unknown остаётся. SDK proof отдельно от запрещённого T011, HTTP OAuth не блокирует ограниченную stdio вертикаль. Resources делает reply composition на существующем ledger. ZCode устраняет ноль тестов из-за отсутствующего module export и использует готовый общий feed. Browser переносит V080B evidence из ошибочной копии плана в canonical и передаёт source для main integration. ChatGPT live hold и ZCode V072D UNKNOWN не изменены.

## Пробуждение и остановки

Единственное следующее waiting: wait_cfbc121fff04d9a86f4e1c89369fcabc, 2026-11-07T11:22:06.011Z (14:22 МСК). Полный registry прочитан; дубль не создавался. Предыдущий wait_1c84ce639ceae5e8029b19b7e73204eb terminal delivery_blocked по quota_unknown, не повторялся.

В ~/.local/state/agent-herder/human-stops.json для Astra/Terra/resources/ZCode/browser записей остановки нет. Read mode automation_disarm вернул unauthorized без token, состояние общего выключателя этим вызовом НЕ подтверждено, переключатель не менялся. Native admission guards сохраняются.

Это source/review и контроль исполнения, не доказательство завершённого продукта. Public mirror канонического плана ранее превысил лимит; его синхронизация не заявляется.
