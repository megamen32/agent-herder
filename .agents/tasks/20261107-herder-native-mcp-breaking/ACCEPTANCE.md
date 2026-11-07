# Завершение переписи: проверяемая приёмка

v1, ревизия шагов до 15 минут. Это будущие критерии, не отметки PASS. Пересмотр принят, когда документы/граф согласованы, исходная ревизия сохранена, новые шаги <=15 минут; текущие назначения и доказательства реализации сохранены.

## Обязательные результаты продукта

| Результат | Наблюдаемое доказательство |
|---|---|
| Breaking API | На native endpoint финального артефакта tools/list имеет только 14 заявленных инструментов. Compatibility endpoint отдельно имеет временные compat helpers, перечисленные в COMPATIBILITY.md. Прямые legacy calls/_async/jobs/old launcher не выполняются; отсутствие только в списке недостаточно. |
| Стандартный MCP | Новый клиент работает напрямую; неизменённый legacy Codex через translator выполняет обычные calls, которые upstream отображаются в стандартные Task get/update/cancel, Skills read и subscriptions/resync. Unsupported direct capability отказывает до эффекта. Версии обоих плеч закреплены; read Skill не означает activation. |
| Удаляемый translator | Core не зависит от compatibility crate. После удаления translator native сборка и direct read/create/deliver работают; один durable Task store, identity/ACL/UNKNOWN сохранены. |
| Нет двойного эффекта | Повтор same key, crash вокруг admission и потеря ответа дают один native input либо UNKNOWN без replay. Changed payload conflict. Task expiry не удаляет защиту повторов. |
| Правильный результат | Deliver подтверждён native input/turn/queue readback; accepted, Task terminal, tool isError и ответ модели показаны раздельно. Export readable клиентом и сообщает полноту. |
| Изоляция | Два Codex, два OpenCode и два browser profiles; одинаковые native IDs в fixture; две ноды. Нет пересечения histories, tokens, models, settings или stop. |
| Автоматический context | A creator B, C sender B, очистка контекста/рестарт, B отвечает C. Model-visible инъекция подтверждена отдельно от server resource read. |
| Roster/worktrees | Проект показывает задачи, scopes, native worktrees и freshness; offline peer не превращается в «работаю один». Claim race один победитель. |
| Общие ресурсы | Global/project/node scope независимы от attachment и authority; перенос телефона сохраняет ID/owner. Resource claim одинаков в MCP и CLI; два телефона независимы. Device entrypoint и LHC writer проверяют владение; содержимое плана остаётся у LHC. |
| Без MCP | Заранее установленный manifest/Skill достаточен свежему агенту: проверить authority→owner отсутствует→атомарный claim→test release→receipt. Ни вопросов о свободном владельце, ни доступа к Herder session DB. |
| Реальный release guard | Child переживает parent; delayed old claim rejected; две попытки не исполняются параллельно; UNKNOWN external receipt блокирует следующий конфликтующий effect. |
| Безопасные права | Impersonation/чужой reply_to/Task/resource/subscription/cache denied; секреты не попадают в errors, manifests или evidence. |
| HumanStop | Hold переживает restart/import/rollback и все schedule/autopilot события; interrupt outcome отдельно, модель не выдаёт себе право снять hold. |
| Пять adapters v1 | Codex, OpenCode, ZCode, ChatGPT и Z.ai имеют capability evidence + installed native lane. Unsupported не маскирует обязательный пробел. |
| Все consumers | Web UI, CLI, hooks/Skills, Hub, LHC, Notice Place, UserIO, Board и секретарь используют новый контракт; real consumer receipt связан с artifact/API revision. |
| Миграция и откат | Backup/schema/counts/UNKNOWN/holds сохранены; active old writers выключены; no-send import rehearsal; rollback после новых записей не восстанавливает устаревший ledger. |
| Установка | Четыре платформенных артефакта имеют digest; Linux/macOS обычные consumers работают после штатного restart/reload. Cross-compile не называется native acceptance. |
| Передача | Remote main содержит owned change, release/artifact/runtime/proof связаны; все обязательные дефекты закрыты либо явно отложены человеком; документы install/recovery/rollback доступны локально. |

В каждом receipt: artifact/source revision, client/native version, profile/instance/session/turn/message refs, сценарий, observable result, proof path, limitations. Никогда credentials/cookies/browser access URL. Fixture, SDK self-test, native readback и independent consumer proof отмечаются разными уровнями.

## Разрешённый тестовый контур

Все отправки/вопросы — изолированные тестовые сессии и test contacts. Голос для этой переписи не требуется. Если обнаружится отдельная потребность voice acceptance, только отдельные Matrix bot accounts/test room с заранее проверенным отсутствием телефонного fallback. Реальных звонков или тестовых уведомлений владельцу — ноль. Browser работает через согласованный Vibe route, чужие вкладки/профили сохраняются.

Фактическая приёмка отмечается только в result конкретного листа и связанных доказательствах. Ревизия документа сама по себе ничего из этой таблицы не доказывает.
