# Agent Herder: доставка и экономная координация

Владелец/root: Codex01a12170. Прямое поручение пользователя09.10.2026.
Изолированный Git worktree: codex/herder-coordination-20261009. Canonical чужой WIP сохранён.

| Задача | Исполнитель | Подтверждённый результат | Осталось |
| --- | --- | --- | --- |
| Быстрая discovery и native delivery | Codex worker 01a12176, интеграция Root | Исправления опубликованы; exact native receipts и 18 affected checks прошли | Не повторять принятые inputs |
| Экономный контекст, текущий cwd, ограничения обмена | Root | Контекст изменений до 4000 символов, preview только явно, 6 сообщений/пара и 12/получатель в минуту; actual cwd проверен через реального агента | Удержать исправленный runtime |
| Независимый совет и review | Два reviewers, ZCode c140, Fast Agent MiniMax | Findings исправлены; советы получены; runtime/tool проблемы отделены от admission | Финальный ZCode ответ после устранения rollback |
| Зарегистрированный MCP | Root, GPTAdmin owner | Child AgentHerder переведён с частного контроллера на singleton HTTP; реальный ответ native Codex дошёл | Конфликт чужой публикации runtime |
| Выпуск | Root | Backend восстановлен после передачи владельцем stop mavis; native Codex и ZCode ответы получены, новый JSON/outbox и ONLYStop frontend сохранены; source main опубликован | UI owner завершает только browser cleanup после stock recovery; mesh ведёт отдельный чат |


Завершение: опубликованный main, реальные list/discovery и ZCode→Codex/обратно с тем же stableID и одним native input, bounded context/rate limit/current project. Accepted/unknown mutation не replay. AutoSell/покупки не изменяются.

## Проверки перед выпуском

Native worker завершил repairs; независимые reviewers/c140/FastAgent дали проверяемые findings. Все repairs закрыты пропорциональными checks: финальный общий прогон155PASS/1path-aliasfailure+однаsyntaxошибка; после исправления affected18PASS5.72s, receipt43PASS7.11s, context21PASS1.62s, hooksHTTP5PASS3.18s. Неповреждённые результаты не повторялись. Путь экспорта сохранён, assertions не ослаблены. Обычный финальный набор сsetup и backendbuild укладывается180s. Red/failed evidence сохранено отдельно.

Final backend tsc artifact: .tmp/coordination-repair-20261009/run-temp/bounded-pns4fqy9/backend. Native buildpeak549183488B/swap0/OOM0/cleanup complete. Frontend byte-identical livecopy. Source/runtime/nativeconsumer ещё различаются; rollout и canary следующие.

C140 подтвердил safe nativeclient handoff: внешнихunfinished действий нет, всеacceptedreceiptsсохранены; доrestartновыхне начинает. Root scopedrelease толькоHerder.

Внешняя зависимость: GPTAdmin schema childjob8d2755058c7191a3833477ab7a2bdcdc осталсяqueued после~40мин. Предыдущий owner01a11755 уже имелpublished dispatchfix; ровноодинnative continuation емуadmitted19:52MSK сэтимjobбезповторногоschema. Он отвечаетза actualGPTAdmin rollout/consumer; rootmainHerder не ждёт sourceисследованияи продолжаетсвойrelease.

## Первый фактический live результат

main91a2c69 опубликован; exact210-file backend активирован PID1116238. Consumer: Codex list20/maxAge7200=1042ms, all=1179ms; именованный deliver(create=never)=985ms, native admitted true/turnId01a121a4/inputIdstable. Реальные18Codex/23total обнаружены; incomplete/limited явно сохранены.

Same-ID GPTAdmin queued job completed, readback через тотжеjob ID подтвердилresponse: owner55 rollout завершил. Полная GPTAdminмиграция не заявляется и не повторяется.

Новая ZCode postrestart RED доadmission: exact installed runtime existing-only возвращает codeZCODE_AGENT_RUNTIME_UNAVAILABLE / runtime is not running. Native V4 input НЕ attempted. Добавлена безопасная same-ID prompt-free load классификация и удаление provenpre-admissionfailure изprocessbudget cache;25affectedPASS. Retry толькооригинальногоstableIDпослеэтогосourcefix, никакогоaccepted/unknown replay.

## Проверенный consumer и текущий конфликт

09.10, около 20:47 МСК: Root восстановил backend из bounded-ak63tm3i. В нём отдельно проверены compact provenance и настоящий compiled web/server с inbox-ack. Исправлена ошибка собственной упаковки: статические файлы копируются только как web/index.html и web/assets, без перезаписи серверных JS. Новые чужие JSON assets и compiled web-ui сохранены byte-identical. Manifest: .tmp/coordination-repair-20261009/final-promotion.json, 212 файлов. Новый build: peak 540409856 B, swap/OOM 0, cleanup complete.

Реальный зарегистрированный маршрут дал native admitted:true, inputId herder-final-native-route-20261009-01a12170, turnId 01a121c6-29b3-7581-93c1-1d91dd067d09. Ответ herder-final-native-reply-20261009-01a12170 получен Root один раз с коротким заголовком. Через тот же MCP list_agents(folder=canonical) показывает worker cwd=canonical, meta.launchCwd=worktree; Root cwd=canonical, launchCwd=agents-projects. List Codex 1483 ms/all 1048 ms; lastMessageCount=0. Неполный охват явно complete=false/limited=true.

Зарегистрированный GPTAdmin child до repair запускал private dist/index.js и отвечал Root session not found. Через supported mcp_manage config сохраняли, заменили только launcher на dist/http-mcp-stdio.js + AGENT_HERDER_HTTP_URL loopback18787/mcp. Real tools readback выполнен. Source .mcp.json/mcp.json теперь также используют shim; тест RED и 2 GREEN, 0.3s/peak88MB. Disabled глобальный Codex MCP не включали; ZCode URL уже корректен. Подтверждённые inputs не повторяли.

ZCode c140 исходный canary input принят и promoted в native DB; ответ не отправлен: вложенный Agent не имел нужного MCP tool, 0 tool calls/30k tokens. Это не native input timeout. Root подготовил один exact SDK callTool reply с прежним неотправленным ID; корректирующий steer до admission отклонён после очередного чужого runtime restart. Accepted исходный input не replay. Финальная проверка ZCode→Codex остаётся незавершённой.

Независимый reviewer установил external publisher: Mac M1 MiniMax Code mavis, session mvs_03faeb0f1aa74d1093d6b2088b16a421, модель MiniMax-M3.1-Flash-Preview. В 20:32 и снова 20:50 он заменил всю dist артефактом на старой базе 958cfb8, исключив текущий main и откатив исправления. Native ledger и .tmp/promote-json-20261009T173245Z/json-rendering-promotion-receipt.json подтверждают команды. CLI minimax/mavis сломан (symlinks на отсутствующий cli.js); Connector session tools отсутствуют, Herder harness не поддерживает эту среду. Внутренний undocumented RPC/foreign stop не применяли.

Тот же publisher пишет composer-delivery.ts, outbox-cancel.test.ts, main.tsx, styles.css, codex-theme.css; freeze не подтверждён. Чужие файлы не редактировались. Активному Codex UI owner 01a11b43 переданы точный writer и граница frontend-only; working note опубликована. Человеку задан один необходимый вопрос о прекращении повторных old-backend выкладок. Следующий шаг: после подтверждённой остановки restore собственных backend модулей поверх последних frontend bytes, повторить только недоказанный ZCode consumer и сверить live manifest. Source/task не называются завершёнными.

## Завершение текущей линии и передача новой цели

Владелец передал mavis запрет полной dist/restart; исправленный backend восстановлен поверх последних чужих JSON/outbox assets. Final manifest: .tmp/coordination-repair-20261009/final-promotion-after-owner-stop.json, 214 файлов; PID1559007, NRestarts0. После ONLYStop frontend promotion все190 backend файлов сверены неизменными. Registered discovery/native receipt/cwd результаты выше относятся к реально выпущенной исправленной версии; source опубликован в main.

ZCode c140 выполнил ровно один SDK callTool(send_message) через настоящий singleton MCP; receipt .tmp/coordination-repair-20261009/c140-final-reply-receipt.json: 2711ms, admitted:true, inputId herder-live-zcode-reply-20261009-01a12170, turnId01a12172-6f72-7182-a7ba-55f441ecf59f. Root получил «ZCode → Codex: связь Agent Herder проверена». Sender lookup имеет2s bound и сообщил непроверенную атрибуцию; native actor и input receipt отдельно подтверждены. Исходный принятый input не повторяли, повторили только доказанно отклонённую коррекцию после восстановления source.

UI owner 01a11b43 проверил ONLYStop в реальном browser: idle+первый sending/второй ready, Stop виден; click отменяет второй callback. Controlled first disconnect => first unknown без replay, second ready/не отправлено; nativeinputs0, heldHTTP1. Native inputs и business действия не дублировались. Source ONLY one predicate + 2 owner trackers опубликованы main0a7ab63; cached blob равен HEAD с заменой ровно одного предиката, чужой main.tsx SHA worktree до/после одинаков. GUI proof .tmp/composer-delivery/actual-stop-green-20261009.json. Финальную надёжность browser не заявляем: после PASS Mini watchdog остановил Chrome по RAM; preview/localStorage/POST-route cleanup остаётся у UI owner и R38 в его исходном tracker.

Новая отдельная пользовательская цель запущена в native Codex01a121d1-1aaf-71b2-8d0e-fbba3d8866ca, чат «Сеть харнесов через GPTAdmin — отдельный worktree», настоящий worktree .worktrees/agent-herder-harness-mesh-20261009 / ветка codex/herder-harness-mesh-20261009. Native start admitted:true/turn01a121d2-3430-7231-ba91-336a58de78c6. Его actual progress подтверждён wait_threads: исследует существующий GPTAdmin, Mac/88 identity и remote capability. Scope новые src/mesh/* + tests/docs/tracker, remote supported MCP configuration на host; Root owns только будущий registerHarnessMeshTools seam в src/index.ts. UI/старые adapters/canonicaldist ему не переданы. Mac18787 оказался forward100, это явно не Mac native peer; такая identity подмена в новом протоколе запрещена. Mesh цель начата, завершённой не называется.

Engineering artifacts перенесены из завершённого worktree в .tmp/coordination-repair-20261009/engineering (25MiB). Старые абсолютные пути в receipts сохраняются как исторические source identities; относительный хвост run-temp/… расположен под engineering. Worker01a12176 archived после завершённого turn и включения всех commits в published main; удалены только task-created branch/worktree и два собственных symlinks. Новый mesh worktree продолжает работать.

## Root integration mesh — 09.10, 21:45 МСК

После независимого review включены только owned новые modules/tests/docs/tracker: worker18fbd25 → maina6bd017, reviewed shared-authority delta9e09a6c → fdd3cad, explicitpartialfixaa6ab83 →30325c9. Root добавляет только импорт registerHarnessMeshTools и его вызов с текущими singleton adapters в src/index.ts. Старые UI/adapters WIP сохранены.

Настоящая MCPfactory-проверка, SDK InMemoryTransport: tools/list содержит mesh_snapshot/deliver; первый emptyadapter snapshot ошибочно complete:true (RED сохранён bounded-s4olzsj2). После ownerfix тот же consumer GREEN, partialfalse явно отражает отсутствие adapters. Full TypeScript по immutablemain buildinputs плюс ONLYownindex GREEN. Конечный bounded69amz8lg, case7caca60d, helper0, peak531955712B/swap0/OOM0, ownedcleanup complete. Не повторялись неизменные старые suites.

Это source integration, не live mesh приёмка. Shared runtime/dist не перезапускались/не заменялись. Worker готовит отдельный thin singleton MCPpeer100 через существующие HTTP list_agents/send_message и metadata peer88; после reviewedcommit он самостоятельно регистрирует childMCP100/88. Existing nativeOpenCode88 authenticated GPTAdmin consumer подтверждён owner55; actual88→100 source/caller proof и native receipt ещё следующие. Full mutual mesh и unavailable88control не называются завершёнными.
