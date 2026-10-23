# Доступ к Mavis через Herder
Исполнитель: repair-mavis-access-20261023. Режим quickfix.
Цель: штатное обнаружение, чтение, одно нейтральное обращение и чтение ответа.
Проверено: mesh_discover сообщает native_discovery_failed; основной GUI работает на host :77/API :18792, контейнер отдельный sandbox. Локальный адаптер читает 12 сессий за 1.184s. Общий deadline snapshot 2s разделён очередью трёх workers; проверяется starvation позднего провайдера.
Чужой WIP сохранён. Голос/телефоны вне scope. UNKNOWN отправки не повторяются.
Следующий шаг: RED regression, минимальный fix, GREEN, scoped публикация и installed consumer canary.

## Исходный fix
RED: tests/harness-mesh-local.test.ts late MiniMax; первые три провайдера зависают, поздний MiniMax пропущен. GREEN: параллельный finite inventory. Deadline reason отделён от adapter exception.
Timeout user correction: default30s, env100..300000ms; direct/HTTP snapshot +5s, per-read aggregator +10s, весь discover +20s. Максимум12 peers параллельно, partial сохраняет готовые результаты.
Store5124 sessions > enumeration4096: newest Oct23 выпадал. RED newest enumeration test, fix reverse dated traversal в adapter+observer. Старые активные сессии ранжируются внутри bounded window; полного обхода не добавлено.
Проверки:116/116 восьми файлов+tsc; затем whole-discover дополнительный test15/15 gptadmin+tsc.
Историческая очередь появилась18fbd252; MiniMax добавлен4674688b. Доказанного нового regression commit нет.

## Доставка и реальная проверка 23.10.2026
Published: f48be6d5a399f215468f98aa25f1c7378f2796ff; followup exact-read 0e646fc78572d5b095574c7a818c7bda4dbfb6d7.
Installed: .fleet-candidate/releases/0e646fc78572d5b095574c7a818c7bda4dbfb6d7, base e791a934 + точечные JS/d.ts patches; честный build-manifest.json внутри релиза. Никакой чужой WIP не включён. Release-local agent-resume import проверен. Runtime PID2975924 при приёмке, protected herder.env/node-config SHA256 неизменны; settings-before.json содержит только хеши.
MCP discovery: minimax-code discovery/delivery available; real ID mvs_ea2ffd00f63a456cb6df96c7619e9573.
MCP exact fleet_session_view: первоначально read_deadline9s; RED supervisor regression показал hydration всех500; fix exact quick read; independent tester после доставки5.443s, historyUnavailable:false. Старое «Да» относится к предыдущему тесту, НЕ к новой отправке.
Одна новая отправка: inputId mavis-access-20261023-neutral-ack-1, native admitted queue_88a6a013-fe56-4f94-9462-2b1e1377ac4b. До native admission был policy refusal unknown project; реальные workspace_dir из native API подтверждены и временно declared600s, затем declaration released. Принятый ввод не повторялся.
Native terminal error: LocalModelResolver: managed OAuth bearer is not synced for provider minimax. Queue empty. Нового ACK нет.
Auth safe seam researched: same-identity window.electronAPI.syncDaemonAuth, без core patch. Preconditions не выполнены: inspected DISPLAY:77 screenshot /tmp/mavis-before-auth-20261023.png показывает Sign in / Create account or log in. Не нажимал Sign in и не запускал watchdog/login. Следующий шаг: пользователь входит в существующий GUI, затем native safe sync/readback и новый unique neutral canary после подтверждённого terminal old failure. Это отдельный auth blocker, не отсутствие доступа Herder.
Rollback: сохранённые service drop-in before-mavis и before-mavis-history; base и f48 релизы сохранены. Без изменения automation settings.

## Native FTS reader leaf
Published f3bed6f + cbd3e51: только src/session-search-sources.ts и tests/session-search-sources.test.ts. Шесть persisted sources без adapter caps: Codex, MiniMax, OpenCode, ZCode, Hermes, Claude. Проверки6/6, независимый combined20/20 до fairness followup. DB read-only; native/core settings не менялись. Для SQLite per-session content digest, cooperative yield128 rows; price: полный native content read при refresh, пропускаются лишь FTS rewrite неизменённых generation. Missing content оставляет title и contentUnavailable; core владелец сохраняет прежние chunks. Lazy source failures отмечают partial, core изолирует session failure.
Codex catalog7332, exact rollout1038, alternative archive/basename0, missing6294. История отсутствующих файлов не выдумывается; исходная DB не редактировалась. FTS deployment/consumer проверка — отдельная ответственность core исполнителя.
