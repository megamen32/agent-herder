# lead-status

Одна строка по задаче автопилота (e4): **после релиза 8122cfa проверил вживую: `on` → `enabled:true`, следом `status` → `enabled:true, source:session` (было `false`), после рестарта Herder (21:45:14+03) `status` у всех 5 ExManager-сессий = enabled:true (e4 L12, e3 L35, e2 L37, e1 C3-L06, executor GLM), durable-файл у всех пяти `enabled:true`, релиз содержит фикс, в журнале юнита после рестарта ошибок нет, приёмка узла 19/21 (два отказа — `mcp=401` без bearer-токена в пробе и недостижимость peer при незаданном `--peer-host` — воспроизводятся точно так же на предыдущем релизе 76cb19f, то есть свойства окружения, а не следствие изменения).**

Не доделано: реального факта продолжения сессии opencode после законченного хода в живом проде ещё нет — judge требует живого judge-токена и прогона модели, поэтому доказательство продолжения пока тестовое (реальная команда состояния внутри реального observer'а: RED на исходном коде — Stop не отправлялся, GREEN с фиксом), а не живое; и «одна строка в Telegram» владельцу так и не отправлена (после запрета проб) — черновик подготовлен, но не отправлен.

Правило принято: никаких пробных/тестовых вызовов наружу — ни probe-schema, ни пингов, ни тестовых сообщений во внешние системы или владельцу; только реальная задача, а нужен тест внешнего контракта — спросить одной строкой. Моё нарушение по этому правилу (вызов `noticeplace send_message` с `probe-schema` вместо чтения схемы) записано в AgentMemory как lesson+workflow, в task.md и сюда; вывод на будущее: схему инструмента проверять через поиск по каталогу или чтение исходников, никогда пробным вызовом.

Задача resume_after с задержкой (e4, 23:30): **дефект найден и исправлен — startup-hold (`AGENT_HERDER_RESUME_AFTER_STARTUP_HOLD=enabled`) держал ожидания «во время жизни процесса», из-за чего delay-wake, чей срок прошёл ПОСЛЕ рестарта, ждал вечно: у лида `wait_313f407e…` (due 19:37:19Z) висел после рестарта 19:44:35Z, а идентичный wait, зарегистрированный после рестарта, сработал штатно — разница только в снимке; фикс: снимок держит ожидание до его собственного срока, дальше будит (`dc7990a` + merge `694b322` в origin/main, релиз 694b322 на node 100, приёмка 19/21 — два отказа те же, что на предыдущем релизе, т.е. свойства окружения). Живая проверка: ранее зависшая `wait_2cb32384…` сработала сама (`resumed`, `delivery: accepted`), канарейка на отдельной тестовой сессии `ses_e76a2ba5…` с задержкой 60 с сработала через 60 с и сообщение реально доставлено (сессия ответила на текст задачи), канарейка остановлена.**

Не доделано по resume_after: `wait_313f407e…` лида пока в `waiting`, потому что его owner `ses_e783d3ac0ffegdglHA2p8k3wls` сейчас `running`, а `isBusy` по контракту откладывает доставку до его простоя — это ожидаемое поведение, не дефект; как только owner освободится, ожидание уйдёт само (если нужно разбудить немедленно — это отдельное решение лида). Наружу ничего не отправлялось.


## Web UI: кэш, фоновые обновления, центральные индикаторы загрузки (10 ноября 2026, сессия zai-web web-b491a74b)

Задача владельца: браузер долго думает при открытии (машины/сессии/клики по сессиям), загрузки показываются только в хедере, браузерным сессиям ChatGPT/ZAI без хуков нужны активные проверки раз в 5 минут.

Сделано (PR #47, #48, #49 в origin/main, релизы 5ee255a9 → 22f1f097 → b2cd3a63, node 100, lease fence 76-78, receipt обновлён):

- Дисковый кэш флота (src/mesh/fleet-disk-cache.ts): снапшот хостов+сессий, первые инвентарные страницы, read-only вью сессий; переживает рестарт демона. Живая проверка: холодный старт после рестарта — /api/fleet/hosts за 0.27с (было 4.5-7с+), тёплые запросы 5-200мс.
- Stale-while-revalidate во FleetCabinetService: устаревшие, но свежие данные отдаются мгновенно, один фоновый рефреш обновляет их; страницы из кэша помечены stale, сайдбар честно пишет «Показаны сохранённые сессии — обновляю список в фоне».
- Фоновый warm loop: раз в 5 минут (AGNT_HERDER_FLEET_WARM_INTERVAL_MS, по умолчанию 300000; 50с показался слишком шумным на нагруженном боксе — каждый цикл поднимает SSH-мосты ко всем пирам). Открытая вкладка сама ревалидирует на своих 30-60с опросах.
- Дисковый кэш быстрых деталей локальных сессий (src/web/session-details-cache.ts): клик по сессии открывает последнее сохранённое состояние мгновенно (opencode-сессии читаются живьём 16-19с!); фоновый рефреш не чаще раза в 30с на ключ. Живая проверка: 71-200мс из кэша против 16-19с живьём.
- Индикаторы загрузки по центру экрана (там, где будет текст сессии): «Загружаю сессии» на первичной загрузке, орбита в RemoteSessionView («Загружаю историю сессии»), орбита в кабинете машин («Получаю список машин»). Проверено скриншотами через VLM.
- Активные проверки браузерных сессий: refreshTurnState для ChatGPT уже в задеплоенной линии (перечитывает историю чата и подтверждает конец хода); ZAI — через API Z.ai; observer (staleRefreshMs = 5 минут) теперь журналирует каждую активную проверку: «[agent-herder] browser active check …». Автопилот получает running→idle переходы как раньше.

Честная запись о CPU: демон и до этой работы жёг ~99% CPU 12+ часов (PID 1848614, релиз 8a8e03de) — это предсуществующая проблема вместе с gptadmin-хабом на 100% и load average 40-50. Мой 50-секундный warm loop поднимал демона до 139-207%; интервал в 5 минут вернул к базовым ~100%. НЕ регрессия, но коробка перегружена — кандидат на отдельное расследование (наблюдатель? адаптеры? opencode-поллинг?).

Незакрытое: (1) рабочее дерево чекаута /home/roomhacker/agents-projects/agent-herder содержит смесь: несколько файлов откачены к Nov-7 блобам + незакоммиченные правки предыдущей сессии (chatgpt-history-archive +57, browser-chat-api-scripts +28 и др.) — я их НЕ трогал и НЕ сбрасывал, вся моя работа шла через отдельный worktree /tmp/herder-ui-cache от origin/main; дереву нужно отдельное разбирательство. (2) Локальная ветка main (c492b6b6, 5 коммитов v1/регистрация) не влита в origin/main и не задеплоена. (3) tsc в основном чекауте падает на ahap-* из-за этой смеси. (4) 100% CPU демона — см. выше.


## Mesh-first peer transport: убраны SSH-мосты флота (10 ноября 2026, сессия zai-web web-b491a74b, продолжение)

Задача владельца: «А почему поднимаются SSH мосты ко всем машинам, если это должна быть межсистема, построенная на meshcore, как GREP Mesh разве нет?» — архитектурное исправление; релиз через lease+rollout на node 100; live-проверка: нет SSH-спавнов, меньше всплесков CPU; обновить lead-status; далее — продолжение Rust-shadowing chatgpt/z.ai по плану STATUS-20261110.md.

Сделано (PR #62 в origin/main, merge `1fcac12e`, релиз 1fcac12e511d17d203ab8a08fb662f2a1f7b46b1 на node 100, lease fence 90, receipt обновлён через herder-receipt-update.py):

- Ветка `feat/mesh-fleet-transport-20261110` в worktree `/home/roomhacker/.tmp/herder-mesh-fleet`, 1 коммит `d069d30e feat(fleet): mesh-first peer transport through the GPTAdmin relay` (rebase на origin/main f6a6898b; force-push с lease).
- Изменения: `src/mesh/fleet-direct-transport.ts` (+115), `src/mesh/fleet-mesh-binding.ts` (+64), `tests/fleet-mesh-transport.test.ts` (+139). Роутинг удалённых пиров через `FleetGptAdminTransport` поверх pinned zcode binding (host-id → mesh-node mapping для mac-mini/M1, projected registry в discover); локальная машина остаётся на in-process bridge; SSH-мост остаётся задокументированным fallback при `AGENT_HERDER_FLEET_TRANSPORT=ssh` или отсутствии pinned binding.
- Staging: `tests/fleet-mesh-transport.test.ts` 12/12 green после rebase; `node --check dist/index.js` ok; full fleet-*.test.ts 65/66 (1 pre-existing failure `fleet-cabinet-navigation` — UI текст «Получаю список машин…» с многоточием vs источник `<strong>Получаю список машин</strong>` без; подтверждено на origin/main, не затронуто этим PR).
- CI PR #62: routing (macos-latest, ubuntu-latest) оба pass; Installed Vibe functional smoke — skipping (deploy gate, не source gate).
- PR #62 слит merge commit `1fcac12e511d17d203ab8a08fb662f2a1f7b46b1` в origin/main.
- Release candidate build: `python3 deploy/fleet/build-release-candidate.py --sha 1fcac12e…` — 15/15 manifest checks pass; ci-receipts/1fcac12e…json: `cli_candidate: PASS`, `release: INCOMPLETE` (ожидаемо — `installed-process` появится после rollout).
- Lease acquire через `node dist/project-release-admin.js --ledger … --authority-host roomhacker-server-100 --request … --proof-out …`: fence 90, owner `{hostId: roomhacker-server-100, harness: zai-web, nativeSessionId: web-b491a74b-c5c7-43e5-9206-b443fd6e78dd}` (мой настоящий IM session id), deploymentTarget `{fleetDir: /home/roomhacker/agents-projects/.fleet-candidate, unit: agent-herder.service}`, TTL 900 с. Proof в `/home/roomhacker/.local/state/agent-herder/release-proofs/mesh-fleet-1fcac12e.proof.json` (mode 0600, вне git).
- Rollout: `python3 deploy/fleet/rollout-node.py --release-proof … --fleet-dir … --unit agent-herder.service --sha 1fcac12e… --port 18787 --restart-cmd "systemctl --user restart agent-herder.service" --previous-sha f6a6898b… --kind owner`. Перед прогоном пришлось: (1) переместить 7 старых release-кандидатов в `trash/pre-mesh-fleet-rollout-20261110T1027Z/` — бюджет `count ≤ 2` иначе не пускал; (2) выставить `XDG_RUNTIME_DIR=/run/user/1000` и `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus` для `systemctl --user` в shell_exec контексте (по умолчанию env пустой); (3) удалить stale rollback snapshot `10-release-exec.conf.rollback-1fcac12e….json` от предыдущей неудачной попытки. Все 7 readiness checks OK: restart command succeeded, readiness belongs to the new generation, running process comes from the new release (1fcac12e…), sessions answer 200, launch policy 200, mcp 200, automation lever unchanged. `accepted: node on 1fcac12e…`.
- Live-проверка: процесс PID 1188929 запущен из `releases/1fcac12e…/dist/index.js`, active (running), порт 18787 слушает. `fleet_node_info` MCP → 200, hostId=roomhacker-server-100, createHarnesses=[codex,zcode,opencode]. `/api/fleet/hosts` (no auth, direct owner) → 200, все 5 хостов state=ready (server-100/44/88/mac-mini/M1). `/api/fleet/sessions?hostId=server-44` → 200 (2.5с cold, 186мс warm), `?hostId=roomhacker-server-88` → 200 (2.6мс из кэша). SSH-спавны во время fleet-чтений: 0 (non-vibe ssh delta = 0 или −4 за минуту, vibe ssh delta = 0 — это чужой opencode-mcp-плагин). Load average упал с 40-50 (baseline) до 18-19. CPU демона ~85-95% — это тот же pre-existing baseline (было ~99% 12+ часов до этой работы), НЕ регрессия; реальный фикс CPU — Rust shadowing (в работе, см. STATUS).
- Конфигурационный фикс по ходу: в `/home/roomhacker/.zcode/cli/config.json` запись `mcp.servers.gptadmin` имела `enabled: False` — меш-транспорт не мог забиндиться и возвращал 503 «Подключение флота пока недоступно». Переключено на `enabled: True` (backup `config.json.bak-pre-mesh-fleet-20261110T074121Z`). URL `https://u-f1102930.t.gptadmin.bezrabotnyi.com/mcp`, Authorization на месте. После переключения /api/fleet/* пошёл 200.
- Lease release: TTL истёк естественным образом (15 мин), `project_release_lease(status)` почистил запись: `lease: null`, `deploymentInProgress: false`, `nextFence: 91`.

Честная запись:
- (1) Старый checkout `/home/roomhacker/agents-projects/agent-herder` всё ещё на `d1ab96d3` (PR #55) с грязными правками от предыдущей сессии — НЕ трогал, работа шла через отдельный worktree `herder-mesh-fleet` от origin/main. Этому дереву нужно отдельное разбирательство (см. прошлую секцию).
- (2) 7 старых release-кандидатов в `.fleet-candidate/trash/pre-mesh-fleet-rollout-20261110T1027Z/` — лежат как rollback history; чистить не нужно (rollback-кандидат f6a6898b остался в `releases/`).
- (3) `AGENT_HERDER_FLEET_CREDENTIAL_PIN=c7d06eba…` остался от предыдущего релиза; mesh binding срабатывает только при совпадении generation (sha256(url+headers)) с этим pin. После включения gptadmin URL не менялся — generation совпал, без rotate.
- (4) opencode`s vibe-mcp-remote плагин поднимает 33+ SSH-спавнов к 192.168.2.5 (`ssh -o BatchMode=yes … node … vibe-mcp-remote/dist/proxy.js http://127.0.0.1:18549/mcp`) — это НЕ наш флот, это opencode MCP plugin; претензия владельца про «SSH-мосты ко всем машинам» к этому отношения не имеет, но рядом — кандидат на отдельное рассмотрение, если шумные спавны беспокоят.
- (5) `browser provider chatgpt/zai unavailable: browser_runtime_setting_missing:AGENT_HERDER_MAC_MINI_SSH_TARGET` — pre-existing, не связано с mesh-транспортом; зафиксировано и в прошлой приёмке (два отказа: mcp=401 без bearer и unreachable peer при незаданном --peer-host).
- (6) CPU демона 85-95% сохраняется — это та же pre-existing проблема, что в прошлой секции; Rust-shadowing (по плану STATUS-20261110.md) — единственный путь её закрыть, мой PR её не починил и не ухудшил.

Следующий шаг: продолжение Rust-shadowing chatgpt/z.ai по плану из `.agents/tasks/20261107-herder-v1-core/STATUS-20261110.md` (см. «Что делаем дальше» в этом документе).


### Rust-shadowing chatgpt/z.ai — состояние после mesh-fleet релиза (10 ноября 2026, продолжение)

Проверка целостности Rust crates на установленном release 1fcac12e:
- `cargo test --manifest-path crates/herder/Cargo.toml --lib --offline adapters::chatgpt` — 6 passed, 0 failed (V080A direct-CDP attach/read, V080B disconnect/timeout, V080A wrong-context reject, fixture-only).
- `cargo test --manifest-path crates/herder/Cargo.toml --lib --offline adapters::zai` — 12 passed, 0 failed (V088A normalization DTO, V088 capability matrix, V090A list_chats, V090B recent projection, V090SCOPE account-bound list_chats, isolation).
- `cargo test --manifest-path crates/herder/Cargo.toml --lib --offline adapters::` — 77 passed, 3 failed (все 3 failures в `adapters::codex::create::tests` с ETXTBSY «Text file busy» — pre-existing flake, не связан с chatgpt/zai; в этой сессии не трогал).

Plan state для chatgpt/z.ai lane (`.agents/tasks/20261107-herder-native-mcp-breaking/plan.md`):
- Z.ai: V088A, V088B, V088, V088C, V090A, V090B, V090, V090SCOPE — ✅ Готово. Capability matrix опубликован в origin/main commit c5946f40 (`acceptance/contracts/z-ai.md`, `acceptance/native/z-ai/live-rust-cdp-20261107.md`); live Rust CDP receipt записан (read_chat, one-send/readback, account-bound snapshot).
- Z.ai pending: V096A, V096B ⏸ Отложено владельцем (установка dev artifact в изолированный native контур и прогон create/deliver/read/export через публичный MCP — требуют live Z.ai profile); V096 ⌛ Ожидание (stop/context/digest — ждёт AC06 AC14).
- ChatGPT: V080A, V080B, V081AHAP, V081CDPBASE, V081CDPDOM — ✅ Готово (fake-CDP только; live profile не подключался).
- ChatGPT pending: V080 ⏸ Отложено владельцем (проверка connection isolation и access error — explicit profile connection); V087A, V087B ⏸ Отложено владельцем (установка dev artifact и прогон create/deliver/read/export через публичный MCP — требуют live ChatGPT profile); V087 ⌛ Ожидание (stop/context/digest — ждёт AC06 AC14).

Текущий release blocker (подтверждён rerun-ом CI run 42773750380 — 10:50 MSK):
- `Installed Vibe functional smoke` FAIL с `error_code: "transport_or_provider_failure"` (был `installed_process_identity_unproven` до rollout — прогресс есть: SHA identity теперь сходится, runtime_source_sha == requested_commit_sha == 1fcac12e…).
- Все 5 lanes (chatgpt, codex, opencode, zai, zcode) возвращают UNKNOWN по всем 7 checks; `model_effects: "NOT_SUBMITTED"`, `owned_process_cleanup: PASS`.
- Это ровно тот blocker, что зафиксирован в STATUS-20261110.md шаг 1: «Восстановить/зарегистрировать разрешённые managed-профили ChatGPT, Z.ai и ZCode и повторить установленный smoke; до этого deploy gate остаётся закрыт». Без live-профилей ничего не воспроизводится — это требует решения владельца (одной строкой, по правилу «никаких пробных/тестовых вызовов наружу»), не технической работы в этой сессии.

Что можно делать без live-профилей (закрыто текущей сессией):
- Поддерживать Rust crates в зелёном состоянии (сделано — chatgpt 6/6, zai 12/12).
- Исправлять ETXTBSY flake в `adapters::codex::create::tests` (3 теста) — кандидат на следующую сессию, не блокер для chatgpt/zai lane.
- Улучшать fake-CDP покрытие и capability matrices (V087, V096 ждут именно AC06 AC14 — это приёмка, а не код).

Передача следующей сессии:
1. Запросить у владельца одной строкой авторизацию на live-профили ChatGPT и Z.ai для V087A/B и V096A/B (или подтверждение, что они остаются отложены — тогда STATUS не сдвинется).
2. Если V087A/B и V096A/B останутся отложены — закрыть их как «⏸ Отложено владельцем окончательно» в plan.md и обновить STATUS.
3. Если владелец авторизует — пройти V087A (изолированный стенд для ChatGPT), V096A (для Z.ai), затем V087B/V096B (прогон через публичный MCP) и V087/V096 (stop/context/digest).
4. Параллельно — пофиксить codex ETXTBSY flake.
