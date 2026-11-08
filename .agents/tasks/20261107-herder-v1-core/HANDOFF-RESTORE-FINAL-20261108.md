# Handoff: завершение нового Herder

Состояние сверено 2026-11-08T20:11:32.359154+00:00. Работу остановили для передачи контекста по прямой просьбе владельца. Полный автоматический результат NoticePlace ещё не принят.

## Цель и действующие ограничения

Довести текущий этап: межхостовое управление → автопробуждение родителя → ремонт через NoticePlace. Сохранять функциональное ядро и существующие TypeScript/AHAP adapters, без нового переписывания.

- Старый Herder остаётся выключенным. На100 live check: inactive, PID0.
- Пользователь разрешил самому доверить два hook на headless44. Это уже сделано штатным `/hooks`; повторять не надо.
- Не ротировать/не возвращать токены. Существующие секреты используются по защищённым ссылкам, значения не печатать.
- Старое самописное ежечасное поручение/таймер отменены; не воссоздавать.
- Единственный интегратор/установщик Herder — родитель01a1bb0c-4fd3-75e2-ae2a-2c18a99462de. Чужой WIP и runtime соседних проектов сохранять.
- Реальные уведомления/звонки людям в тестах запрещены. Fixture-инциденты создаются атомарно muted до dispatch.
- Исходы конкретных операций проверять по квитанциям. Принятые/UNKNOWN отправки не переигрывать. Подтверждённый отказ до эффекта допускает исправление причины и новую разрешённую попытку.

## Где продолжать

Канонический план: `/home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-herder-v1-core`; читать последний раздел CONTRACT.md. Старый native-mcp-breaking план не актуален.

Рабочий checkout интегратора: `/home/roomhacker/.codex/worktrees/herder-final-acceptance/agent-herder`.
HEAD4894e09b опубликован в main. Checkout detached и содержит чужие/старые WIP: не reset/stash/clean, не добавлять всё сразу. Публиковать только перечисленные owned paths.

План на диске обновлён: RESTORENOTICE разделён на доказанную базу (done) и NPIDENTITY/NPLIVEFINAL (running). Эти новые canonical leaf files ещё не переносились в интеграционный checkout и не публиковались Git-коммитом. RESTORECORE/RESTORECONTRACTS имеют старые running метаданные: сверить реальные scoped результаты, не считать их свежими заданиями и не объявлять весь план завершённым.

## Уже доказано

1. Межхостовой Codex44: create → два prompt/ответа → archive → restart/readback через общий GPTAdmin. REMOTEFULL done. Evidence: `evidence/finish-20261108/remote44-full-canary-metadata.json`, `remote44-shared-gptadmin-readonly.json`.
2. Автопробуждение: native completion child44 вызвал доверенный hook, родитель ответил ровно один раз, ручных parent sends/reconcile0. Исправлено отсутствие parent_ref в canary mapping. Свои4тестовые сессии архивированы. COREWAKE done. Evidence: `native-wake-final.md`, `native-wake-confirmed.json`. Отдельный wire proof проверяет restart/duplicate/HumanStop.
3. NoticePlace: реальный installed consumer → Rust create → direct MiniMax OpenCode → ремонт owned HTTPfixture → work_finished → независимый SourceVerifier → resolved. Но была ручная коррекция неверного ID сессии, поэтому это НЕ чистый автоматический PASS. Evidence опубликовано в4894e09b: `evidence/finish-20261108/noticeplace-first-live.json`.

## Установлено сейчас

Rust manifest: `/home/roomhacker/herder-artifacts/releases/herder-v1-humanstop-869c764b/manifest.json`.
Manifest SHA256: d4add78186ef6d679915cc823e542329e365221c6e6e8d2db769d61090bcedb7.
Core SHA256: b49261e068bff43edf4dd2c023c69fccdb345723f1df2ff601924354bd5df4ba.
Selector: `~/.config/agent-herder/v1-entry.json`; 3profiles: localcodex, remote44codex, opencode-noticeplace-local. Не подменять весь selector ради NoticePlace HTTP facade.

NoticePlace facade: user unit `agent-herder-v1-noticeplace.service`, active PID2531532 при последней сверке. Release `/home/roomhacker/herder-artifacts/releases/41b4284731f4671c0b9a668165538d1d86861de9`. Port127.0.0.1:18787.
Protected config: `~/.config/agent-herder/v1-noticeplace.json`.
NoticePlace release manifest SHA256:6bd0e37609c6885884bc52f1c340b72e05e7e88eba46602b6d6beb9f0e6a6e84.
Node22 для unit: `/home/roomhacker/herder-artifacts/releases/herder-v1-restore-a3812e2c/fixture/node`; `/usr/bin/node` на100 слишком старый.
Активной release lease нет: предыдущая освобождена.

41b42847 исправляет чтение secret markers: herder.env содержит sha256-маркеры, реальные значения берутся read-only из существующего secrets.json. Секреты/credentials не менялись.

## Готовые, но ещё не установленные изменения

Опубликованный4894e09b:
- `src/automation/v1-noticeplace-runtime.ts`: exact native↔core identity lookup, обработка OpenCode session.idle/session.status, при подтверждённом idle+phase=stop native assistant message ID используется как completion identity; явный turnId сохраняется. Дедуп событий, continuation mode=start вместо неподдерживаемого current, параллельные независимые snapshot reads.
- `src/automation/v1-noticeplace-mcp.ts`: сохраняет structured refusal/effect:none, не превращает его в потерю квитанции.
- Соответствующие runtime/MCP tests и first-live evidence.

Луна01a1bcb6-6913-7310-a8ce-edbd8be96720 закончила и освободила следующие ТРИ пути в этом же checkout; они НЕ закоммичены:
- `src/v1-noticeplace-server.ts` (modified)
- `src/automation/v1-noticeplace-resume.ts` (new)
- `tests/v1-noticeplace-server.test.ts` (modified)

Что сделано Луной: consumer получает настоящий native session_id, core_session_ref остаётся отдельным; details/progress/autopilot/resume переводят ID в core ref; multiline resume; повторный fleet STOP check; deliver→bounded чтение того же compat_task до12сек, без повторного deliver; immediate effect:none/HumanStop/UNKNOWN сохранены.

Runtime wiring родителя УЖЕ есть в4894e09b: identity.toCoreRef/toNativeId и resume:port. sessionRead/autopilot внутри получают core ref.

Проверки: родитель runtime/autopilot/judge31PASS, runtime+MCP16PASS. Первый общий прогон дал68PASS/1timeout из-за теста working-receipt. Луна затем исправила тест и передала27server testsPASS + tsc--noEmitPASS + diff-checkPASS. Финальный объединённый прогон после её последней правки родитель ЕЩЁ НЕ выполнял. `dist` от предыдущего build не считать окончательным.

## Точный следующий порядок

1. Проверить три освобождённых пути Луны и объединённый wiring. Запустить focused suites (server/runtime/MCP/autopilot/judge/session-read) и `tsc` с проверкой exit code тестов. Затем scoped commit трёх путей + push main. Не коммитить чужие untracked файлы.
2. Собрать новый immutable NoticePlace bundle из окончательного SHA. Можно копировать dependency bytes предыдущего immutable41b42847 через cp--reflink=auto, но заменить все изменённые dist modules, добавить новый resume.js и обновить hashes/manifest. Не переписывать старый bundle.
3. Взять release lease штатным Herder либо существующим LHC fallback. Сверить ожидаемый live release41b42847, выполнить CAS unit path, daemon-reload/restart только agent-herder-v1-noticeplace.service. Node22 сохранить. Проверить startup и HTTP policy/disarm. Lease освободить.
4. Выполнить свежий реальный NoticePlace тест ниже. Без ручной замены native binding. Проверить native session ID в NoticePlace, подтверждённое autopilot arming, actual repair, work_finished и независимый source verification. Считать отдельными результатами: repair прошёл; completion/judge действительно сработал; consumer callback принят.
5. Проверить штатный resume на своей тестовой сессии и чтение квитанции; не создавать замену при UNKNOWN. Для полного автоматического PASS не использовать ручной model send вместо пропущенного hook.
6. Выключить autopilot только своего теста, сохранить transcript/receipts, архивировать свой чат и созданные judge chats, остановить свои fixture HTTP процессы. Записать установленный SHA, exact native IDs, источник readback и оставшиеся ограничения в canonical evidence/plan; опубликовать owned документы.

## Свежий тест уже подготовлен, НО НЕ ОТПРАВЛЕН

Root: `/home/roomhacker/agents-projects/agent-herder/.tmp/v1-noticeplace-final-20261108-01a1bb0c`.
`prepared-event.json` содержит готовый event; перед отправкой обновить observed_at после живого GET. SourceID agent-herder-v1-final-01a1bb0c, отдельный от первого теста. Health127.0.0.1:16329/health, сейчас degraded/repairs0. HTTPserver execsession40750. `incident-receipt.json` отсутствует: второй create_event ещё не выполнялся.

Использовать существующий NoticePlace consumer и verifier credential agent-herder из защищённого service env, без печати/создания ключей. В первом тесте применялся installed `notification_center.core.NotificationCenter` с mesh:/run/noticeplace-mesh/sql.sock: outer transaction включала create_event и set_incident_notifications_muted(true) до commit, чтобы избежать уведомлений человеку. После создания сохранить receipt и проверить muted фактически (возвращённый create_event snapshot до mute может ещё содержать false). Не открывать общий QA consumer с Matrix-call политикой.

SourceVerifier: `/opt/noticeplace/notification_center/consumer_lifecycle.py`. Отдельный verifier principal source:agent-herder, exact sourceID/server-100/own state directory. Probe должен читать настоящий fixture HTTP и только по200+healthy+repairs1 возвращать healthy; tick не подменяет ремонт и не закрывает инцидент без реального измерения. Не запускать неизменённый `tests/v1-restored-workflows/noticeplace-native-canary.py`: он использует старой чужой QA grant и устаревшие ожидания API.

## Первый тест / cleanup

Root: `/home/roomhacker/agents-projects/agent-herder/.tmp/v1-noticeplace-20261108-01a1bb0c`.
Incident inc_c2f37bfe20d448369d6a9218283ddcfc — resolved/healthy; source check check_03f6132f51a94b27af76eca3bf3dccc2 принят.
CoreRef session:66ecba3bf525a89f494b9f2c7ebc8421 → native ses_e434b3fc0ffeNkQ5AJ1nuWLYgl.
Autopilot отключён, archive effect=confirmed. Повторять repair/send/archive не нужно.
HTTP127.0.0.1:17141 всё ещё запущен, execsession7876; можно остановить только этот fixture process.
Ноль human deliveries, только две gptadmin.agent delivery: первая failed403 до native admission, вторая sent. Оригинальные receipts сохранены.

Первый worker самостоятельно опубликовал incident skill в существующем NoticePlace workflow; это не acceptance evidence. Второй prepared event явно ограничивает ремонт fixture и запрещает новые публикации/commits. Не присваивать соседний NoticePlace repo в рамках этого handoff.

## Полезные команды и границы

- Все команды Git/build выполнять с явным cwd интеграционного checkout выше.
- Focused check: `node node_modules/vitest/vitest.mjs run tests/v1-noticeplace-server.test.ts tests/v1-noticeplace-runtime.test.ts tests/v1-noticeplace-mcp.test.ts tests/v1-noticeplace-autopilot.test.ts tests/v1-noticeplace-judge.test.ts tests/v1-noticeplace-session-read.test.ts --reporter=dot && node node_modules/typescript/bin/tsc`.
- Логи unit: `journalctl _SYSTEMD_USER_UNIT=agent-herder-v1-noticeplace.service -n 20 -o cat`.
- Release fallback tool: `/home/roomhacker/.codex/plugins/cache/megamen32-plugins/last-human-commit/1.17.2/tools/lhc_worktree.py release-guard acquire|release --repo <checkout> --project agent-herder --session <parent>`; acquire также --candidate <SHA> --ttl900.
- UserIO/browser429 и секреты — не продолжать по инерции. Новых workers/веток/планов для уже выполненных частей не создавать.

Остаток перед handoff оценивался20–30мин при успешном повторном прогоне; это оценка, не новый обещанный дедлайн. Старый срок уже пропущен.
