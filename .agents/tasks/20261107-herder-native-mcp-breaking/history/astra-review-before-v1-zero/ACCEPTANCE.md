# Завершение переписи: проверяемая приёмка

Ревизия 5. Это будущие критерии, не отметки PASS. Сам пересмотр принят, когда документы/граф согласованы, исходная ревизия сохранена, все исполнимые листья <=60 минут и implementation не запущен.

## Обязательные результаты продукта

| Результат | Наблюдаемое доказательство |
|---|---|
| Breaking API | На финальном артефакте tools/list имеет только 14 заявленных инструментов. Прямые legacy calls/_async/jobs/old launcher не выполняются; отсутствие только в списке недостаточно. |
| Стандартный MCP | Реальный primary client через реальный gateway выполняет discovery, Task get/update/cancel, reconnect/read и Skill load. Missing capability отказывает до эффекта. Версии клиента/сервера/SDK закреплены. |
| Нет двойного эффекта | Повтор same key, crash вокруг admission и потеря ответа дают один native input либо UNKNOWN без replay. Changed payload conflict. Task expiry не удаляет защиту повторов. |
| Правильный результат | Deliver подтверждён native input/turn/queue readback; accepted, Task terminal, tool isError и ответ модели показаны раздельно. Export readable клиентом и сообщает полноту. |
| Изоляция | Два Codex, два Claude и два browser profiles; одинаковые native IDs в fixture; две ноды. Нет пересечения histories, tokens, models, settings или stop. |
| Автоматический context | A creator B, C sender B, очистка контекста/рестарт, B отвечает C. Model-visible инъекция подтверждена отдельно от server resource read. |
| Roster/worktrees | Проект показывает задачи, scopes, native worktrees и freshness; offline peer не превращается в «работаю один». Claim race один победитель. |
| Без MCP | Заранее установленный manifest/Skill достаточен свежему агенту: проверить authority→owner отсутствует→атомарный claim→test release→receipt. Ни вопросов о свободном владельце, ни доступа к Herder session DB. |
| Реальный release guard | Child переживает parent; delayed old claim rejected; две попытки не исполняются параллельно; UNKNOWN external receipt блокирует следующий конфликтующий effect. |
| Безопасные права | Impersonation/чужой reply_to/Task/resource/subscription/cache denied; секреты не попадают в errors, manifests или evidence. |
| HumanStop | Hold переживает restart/import/rollback и все schedule/autopilot события; interrupt outcome отдельно, модель не выдаёт себе право снять hold. |
| Все adapters | Codex, OpenCode, Claude, ZCode, Qoder, Hermes, Fast Agent, MiniMax Code, ChatGPT, Z AI и конкретный Browser Chat endpoint имеют capability evidence + installed native lane. Unsupported не маскирует обязательный пробел. |
| Все consumers | Web UI, CLI, hooks/Skills, Hub, LHC, Notice Place, UserIO, Board и секретарь используют новый контракт; real consumer receipt связан с artifact/API revision. |
| Миграция и откат | Backup/schema/counts/UNKNOWN/holds сохранены; active old writers выключены; no-send import rehearsal; rollback после новых записей не восстанавливает устаревший ledger. |
| Установка | Четыре платформенных артефакта имеют digest; Linux/macOS обычные consumers работают после штатного restart/reload. Cross-compile не называется native acceptance. |
| Передача | Remote main содержит owned change, release/artifact/runtime/proof связаны; все обязательные дефекты закрыты либо явно отложены человеком; документы install/recovery/rollback доступны локально. |

В каждом receipt: artifact/source revision, client/native version, profile/instance/session/turn/message refs, сценарий, observable result, proof path, limitations. Никогда credentials/cookies/browser access URL. Fixture, SDK self-test, native readback и independent consumer proof отмечаются разными уровнями.

## Разрешённый тестовый контур

Все отправки/вопросы — изолированные тестовые сессии и test contacts. Голос для этой переписи не требуется. Если обнаружится отдельная потребность voice acceptance, только отдельные Matrix bot accounts/test room с заранее проверенным отсутствием телефонного fallback. Реальных звонков или тестовых уведомлений владельцу — ноль. Browser работает через согласованный Vibe route, чужие вкладки/профили сохраняются.

Сейчас никакой runtime приёмки не выполнялось. Ни один пункт этой таблицы не следует считать доказанным ревизией документа.
