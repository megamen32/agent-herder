# Ownership и установка

Сессия вопросов: 01a18444-4ce2-70d2-a7f0-65e9fe1cbbef. Исходная сессия reboot: 01a1754f-0228-7553-bea6-cc89e40b5187.

Подхвачен frozen questions-handoff. Новые изменения adapter только в отдельных native-input типах/полях/методах/event/disconnect hooks. readLatestTurnRecoveryEvidence и его tests не затрагиваются. Только исходная сессия выполняет ближайший runtime restart100. Этот срез нельзя включать в её установку до подтверждения сборки и приёмки.

Сессия вопросов владеет src/human-request/native-user-input-*.ts, соответствующими новыми tests, frozen notice-question.ts/notice-bridge.ts и wiring index.ts/session-supervisor.ts/web/server.ts/mcp/human-request-tools.ts. scoped commit adapter возможен только после публикации чужого reboot helper либо с отдельным индексом из собственных hunk.

Текущий blocker холодной части: ClientRequest не предоставляет pending RPC replay/list; historical agentMessage.questions не содержит requestId/questionId. Нельзя подменять неизвестный native request обычным resume. Исследуется существующий native control transport, без attach/resume пользовательских сессий.
