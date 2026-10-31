# MacBook: проверка связности Agent Herder, 24.10.2026

Исполнитель: codex `01a16e01-ab5d-7b81-aaba-caf28886507c`, server-100.
Область: диагностика Mac Forwarder, один официальный транспортный тест; без изменения shared Herder runtime.

## Результат и предел доказательства

Текущая связность server-100 → MacBook → server-100 подтверждена: ровно одна отправка через официальный Herder `mesh_route`, native admission, независимое чтение native-истории и содержательный ACK Mac. Исходный connection refused сейчас не воспроизводится. Я не производил ремонтных изменений или перезапусков: служба уже работала к началу проверки. Устранение причины повторных watchdog-остановок НЕ доказано.

## Что означает Agent Forwarder

Найдена сохранённая запись прямого уточнения владельца от 23.10: «Agent Forwarder», «agent forward», «there» в контексте менеджера агентов означают Agent Herder, это ошибка транскрипции. Источник: `/home/roomhacker/.codex/memories/extensions/ad_hoc/notes/20261023T003000Z-agent-herder-transcription.md:1`.

Живые launchd/process, имена приложений и профильные инфраструктурные документы не показали отдельного Agent Forwarder. Herder fleet-node и SSH tunnel — разные компоненты одной схемы доступа, а не две реализации доставки. GrepMesh search `job-28f36535f989dfdea6b321dd1d24a5e21827b8378df43e55` завершён с `partial=true`, `truncated=true`: server-100 ok, server-88 `remote response was partial`. Это ограниченный поиск, не полная инвентаризация флота.

## Живые службы и маршруты

- Штатный SSH: `ssh -o BatchMode=yes -o ConnectTimeout=5 -p 2222 user@127.0.0.1`; проверены hostname `MacBook-Pro-User.local`, LocalHostName `MacBook-Pro-User`, arm64.
- Mac `com.bezrabotnyi.agent-herder-fleet-node`: watchdog PID23657, node PID23752; запущены 24.10 в 15:48:23/25 МСК. Listener `*:18789`, `lsof -nP -iTCP:18789 -sTCP:LISTEN`. Процесс: `/Users/user/.hermes/node/bin/node /Users/user/.local/share/agent-herder/fleet/releases/b8f8470a69aa46bc0f848b813a17a2b91ee35c18/dist/index.js`.
- Mac source SHA `b8f8470a69aa46bc0f848b813a17a2b91ee35c18`; launcherSourceSha `6e58a90f7531ead8165558677addab89908fa943`; watchdog SHA256 `1dfa7c46a4c6f2d4991af9b3463e78e9ed2b6c964c22cf4c0504b148fb8a08fa` из node-config, без раскрытия секретов.
- `com.bezrabotnyi.herder-tunnel`, SSH PID75076, поддерживает на Mac `-L 18787:127.0.0.1:18787` к server-100 через существующий ingress. Он не является Mac fleet-node18789.
- На server-100 listener18787 PID1934201: `/home/roomhacker/agents-projects/.fleet-candidate-l14/releases/59f7bb90172adcb95c755e0824538054b4416e37/dist/index.js`. Это наблюдённый путь установленного runtime; checkout SHA отдельно `d9c622ce905f9ad3816845d104c688453abfdc84`.
- На server-100 `127.0.0.1:21701` — существующий SSH-forward к Mac fleet-node; получен HTTP200. Mac `/health` вернул404, что доказывает HTTP-ответ, но не наличие health endpoint.
- Official direct fleet mapping в `src/mesh/fleet-direct-transport.ts`: `MacBook-Pro-User.local`, SSH `127.0.0.1:2222`, nativeUser=user, port18789. Чтения этой проверки шли штатным SSH; единственная отправка — MCP `mesh_route`.

## Обнаруженный механизм остановки

`/Users/user/.local/state/agent-herder/fleet-node/last-run.json`, mtime24.10 15:47:52 МСК, описывает предыдущий node89398:

```json
{"reason":"cleanup_unverified","sourceSha":"b8f8470a69aa46bc0f848b813a17a2b91ee35c18","hostId":"MacBook-Pro-User.local","nodePid":89398,"elapsedSeconds":864.4,"sample":{"rss_kib":256928,"processes":1},"violations":["storage_observation_limit {\"rootClass\":\"state\",\"kind\":\"deadline\",\"attempt\":1,\"count\":0,\"elapsedSeconds\":3.556}"],"childExitCode":-9,"enforcement":"darwin_watchdog"}
```

Это конкретная запись остановки fleet-node при превышении срока наблюдения state-каталога. Нельзя утверждать, что именно она вызвала каждый прежний connection refused: у прежних проверок нет сопоставленных timestamps. Первопричина превышения срока не установлена.

`watchdog.log` содержит `native_observation_failed` и `release_budget_exceeded`, но его mtime23.10 19:57:33 МСК: эти записи исторические, не доказательство текущего отказа. Исходник установленного watchdog поднимает `native_observation_failed` при неуспешной команде наблюдения/слишком большом stdout; `release_budget_exceeded` — при более чем трёх release directories. Сейчас виден один release directory. `tunnel.err` содержит старые `channel ... Connection refused` без времён, поэтому не использован как актуальная причина.

## Единственный тест и независимый readback

- Перед отправкой `agent_info` exact target: `minimax-code / MacBook-Pro-User.local / mvs_f70ce650bbf94d789e4e4a2669f6743a`.
- Native evidence в13:05:32.724Z: `running`, `activityEvidence=native_active_turn`, `nativeContinuationState=2`, expires13:05:47.734Z, `humanStopHeld=false`.
- Sender: `codex / roomhacker-server-100 / 01a16e01-ab5d-7b81-aaba-caf28886507c`.
- MCP `mesh_route`, inputId `mac-forwarder-20261024-1305-benign-01`.
- Receipt: `{"state":"admitted","inputId":"mac-forwarder-20261024-1305-benign-01","turnId":"turn_b7c08b50-4458-4576-91d2-c31e4a54312e","retryable":false}`.
- Readback штатного Herder owner API на Mac: `GET http://127.0.0.1:18789/api/sessions/minimax-code/mvs_f70ce650bbf94d789e4e4a2669f6743a/details?limit=12&quick=1` через reverse SSH. `history.source=acp-load`, `complete=false`. Точная user-message `msg-user-v1-vAKyeYaT5f07BnjaK2M-93JwyVgrx2PxfQeTeGGtJ64`, timestamp13:05:54.358Z, тот же turnId, содержит отправленный marker и текст теста. Неполнота истории не мешает доказательству этой точной записи.
- Native assistant message `e3572fb9-3ca2-4f2c-b37d-c16b65aa088c`,13:08:05.237Z, тот же turnId: «Это транспортный тест — отвечаю через официальный Herder с фактическим хостом, ничего не перезапускаю».
- В текущую сессию пришёл содержательный обратный ACK с точным marker, host `MacBook-Pro-User.local`, user `user`, подтверждением получения в текущем активном native ходе и продолжения прежней задачи. Приём не подменён одной квитанцией admission.
- Replay, пробуждений idle, создания сессий, звонков и Telegram-действий — ноль. Hooks не включались. Квоты, права, source/dist/config/release artifacts не изменялись.

## Граница и следующий шаг

Интегратор codex `01a16b66-caa8-7b92-84fa-352c21395153` прямо сохранил за собой shared Herder source/runtime/release и запретил этой ремонтной сессии их менять или перезапускать. Проверенный last-run передан ему одним сообщением `mac-forwarder-boundary-evidence-20261024-1308`, native admission turn `01a16e03-3555-78d3-beb7-665998fc67b8`.

Точный блокер устойчивого исправления: watchdog относится к Herder runtime, отдельного собственного Forwarder нет; его изменение или restart выходят за согласованную область. Минимальный следующий шаг владельца runtime: проверить причину state-observation deadline по сохранённому last-run и выполнить разрешённый ремонт, сохраняя защиту и активные сессии. Повтор тестового сообщения не нужен. Текущий транспортный путь проверен; устойчивый ремонт watchdog остаётся незакрытым.

## Текст для передачи владельцам

«MacBook сейчас доступен: официальный Herder передал единственный тест в существующий активный MiniMax native ход; сообщение независимо прочитано в native-истории, содержательный ACK вернулся на server-100. Agent Forwarder здесь — транскрипция названия Agent Herder. Ремонтных изменений не потребовалось и не выполнялось. Найдена последняя watchdog-остановка node89398: state storage observation deadline3.556s, child exit-9,24.10 15:47:52 МСК; новый node23752 работает с15:48. Причина этого deadline и устойчивое исправление остаются у единственного интегратора Herder runtime; защита, hooks и активные AI-сессии не затронуты».
