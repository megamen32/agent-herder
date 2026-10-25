# Проверенные исходные возможности — 25.10.2026

Это исследование исходников и протоколов; ни одна строка не означает установленную приёмку нового цикла. Секреты и содержимое чужих запросов сюда не копируются.

| Среда | Режим в текущем Herder | Native ответ на разрешение в Herder | Подтверждённый маршрут / следующий решающий шаг |
|---|---|---|---|
| ZCode | `setPermissions` возвращает unsupported. При создании уже используется native `setMode(yolo)` с readback. | `task.respondPermission` для exact request, once/always/deny. Предыдущий ремонт уже доказал настоящий pending. | Добавить смену существующего режима через штатный `setMode` с identity/readback, отделить mode change от ответа текущему запросу. Исходник пока занят первоначальным интегратором. |
| OpenCode | Адаптер делегирует клиенту. V2 PATCH session permissions; legacy PATCH `/config?directory=...` меняет directory scope. Произвольный неизвестный mode сейчас попадает в allow в V2: подтверждённый дефект, принадлежит этому циклу. | V2 reply exact session/request и legacy permissions endpoint. | Проверить фактическую установленную версию и scope; исправить allow-by-default, не выдавать directory-wide изменение за session-only. Исходник содержит чужой WIP. |
| Codex | Адаптер отвечает, что режим задаётся только при thread start. | `respondPermission` не реализован; `handleServerRequest` только обновляет metadata, не сохраняет request для ответа. | Официальный app-server описывает server-initiated JSON-RPC request и ответ на том же ID; `threadId/turnId/itemId` обязательны для привязки. Проверить локальный 0.162.1 schema и transport ownership. Нельзя обещать доступ к pending, полученному другим RPC connection. |
| MiniMax Code | `setPermissions` возвращает управление через product surface. | `respondPermission` явно отказывает из-за отсутствия request identity. | В установленном official package generated DesktopService найдены GET/PUT `/permission/mode`, GET `/permission/requests` и POST `/agent/:name/permission/:request_id/reply`. Mode route не принимает sessionId: scope не доказан как session-only. Нужен read-only capability probe живого controller и сопоставление pending с native session. |

Источники кода: `src/adapters/{zcode,opencode,codex-app-server,minimax-code,minimax-code-control}.ts`, `packages/agent-resume/src/harness/opencode/client.ts`; MiniMax official package `@minimax-ai/code`, generated DesktopService bindings и README, а не изменение runtime.

Официальная документация Codex: [App Server, approvals](https://learn.chatgpt.com/docs/app-server#approvals). Поддержаны server requests для command/file approvals с решениями accept/decline и подтверждением resolved; permissions requests требуют возвращать только запрошенное подмножество. Документация не доказывает установленную версию или возможность перехватить запрос чужого клиента.

## Общая интеграция

Существующий `deliverNoticeQuestion` уже использует `POST /v1/human-requests` и dedup key. Но существующий registry описывает continuation=`resume`: ответ превращается в продолжение агента. Для native permission нужен отдельный typed dispatch в exact native request; обычное сообщение агенту не является заменой решения разрешения.

Контекст карточки: только последняя релевантная команда, предыдущий видимый текст assistant и последний видимый user. Thinking/reasoning не копировать. При недоступной истории указать отсутствие, не брать unrelated session. Секреты очищать до передачи Notice Place.

## Точные препятствия до записи исходников

1. Предыдущий интегратор ещё владеет `src/adapters/zcode.ts`, `src/web-ui/main.tsx`, `src/web-ui/active-activity.ts` до своего финального installed proof. Новый цикл не меняет эти пути.
2. Основной checkout содержит чужой WIP в Codex/OpenCode, `src/index.ts`, `src/web/server.ts`, `src/human-request/notice-question.ts` и отстаёт от опубликованного main. Созданные файлы нового плана не меняют эти байты. Вопрос пользователю ограничен разрешением одного exact worktree; до его ответа дерево/ветка не создаются.
3. Не установлены четыре отдельные разрешённые native тестовые identity. Рабочие Broker/AFC/TGC сессии не являются fixture. Тестовые карточки направляются в существующий test recipient/channel, без уведомления владельца ради smoke и без телефонной эскалации.

Следующее действие без зависимости от разрешения: read-only probe MiniMax mode/listPending и проверка локальной Codex protocol schema. После согласования source ownership/worktree — минимальный исполняемый путь одного permission roundtrip, затем остальные адаптеры по общему контракту.

## Дополнительная проверка 14:44 МСК

Официальный установленный Codex `0.162.1` успешно сгенерировал experimental TypeScript schema в собственный `.tmp/permission-control-codex-schema-20261025` без запуска агента. `ThreadResumeParams` поддерживает overrides и rejoin running thread, `ThreadResumeResponse` возвращает approvalPolicy/sandbox/activePermissionProfile; это возможный штатный маршрут смены режима, который ещё требует действующего контроллера и safe fixture. `CommandExecutionRequestApprovalResponse` возвращает decision на исходный RPC request. В отдельной attach-сессии не надо автоматически отвечать на approval другого connection.

Default `MinimaxCodeControl.manifest()` на server-100 вернул absent: GET mode/requests не выполнялись, runtime не запускался. Это отсутствие именно default desktop transport, а не доказательство отсутствия MiniMax: live Herder discovery видит активные MiniMax native lease на server-100 и отдельный native controller на Mac. Discovery частичная; безопасные test identity и writable mode scope пока неизвестны. Существующим рабочим агентам ничего не отправлялось.
