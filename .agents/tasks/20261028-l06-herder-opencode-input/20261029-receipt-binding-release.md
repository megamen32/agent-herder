# Квитанция исправления связи ответа L06

Herder source `94de44af294a98e5f913cd8175520bd2eb6a1608` опубликован в origin/main и установлен на server-100; systemd active, PID 2933183, старт 29.10.2026 08:56:09 МСК, ExecStart указывает на immutable release этого SHA.

При новом OpenCode resume durable Agent Resume ledger сохраняет `input_id` (детерминированный идентификатор из idempotency key) и `native_input_message_id` (native ID из подтверждения, либо JSON null при отсутствии). Ранее принятые записи не изменялись. `human_request_get` показывает `resumeReceipt` через существующий защищённый MCP при наличии точного target, resultRef и idempotencyKey; проверяется совпадение binding при чтении ledger. Если квитанция недоступна, возвращается null.

Изолированный focused test сначала воспроизвёл отсутствие полей, затем прошёл: запись, readback и повтор без второй отправки. Сборка прошла, 14/14 проверок release. Независимая read-only проверка установленного `AgentResumeClient.queryReceipt` на ранее принятой OpenCode записи: accepted, result/key совпадают, оба новых поля null. Старые значения не реконструированы.

Новая реальная квитанция и связь с конкретной карточкой ExManager в этой работе не проверялись. Повтор callback или отправка Telegram не выполнялись. Потребителю нужно проверить новый допустимый ответ по его requestId через `human_request_get` и связать `resumeReceipt.native_input_message_id` с результатом при наличии значения; null означает отсутствие доказательства, а не разрешение на повтор.
