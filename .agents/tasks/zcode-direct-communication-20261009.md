# Прямая доставка и очередь ZCode

Исполнитель: Codex01a11b43. Интеграция, публикация и выпуск: Codex01a11b54.
Границы: `src/adapters/zcode.ts`, новый `tests/zcode-communication-delivery.test.ts`, этот журнал. Чужие Codex adapters/handlers/receipts и AutoFind не меняются.

## Подтверждённая ошибка и настоящий маршрут

После выпуска Herder00c7b9a зарегистрированный `send_message(mode=steer)` активному ZCode вернул `A prompt is already running for this session`. Старый адаптер не использует `options.steer`, вызывает legacy `sendPrompt`, а `queue` складывает в RAM и при flush создаёт новый inputId.

Установленный `/home/roomhacker/.zcode/server/zcode-server.cjs`, SHA256 `f7a537a644611ba03099f4e06c395f0b064dde9b1ceb232bd5652637b03c8550`, действительно экспортирует через `zcode-agent` метод `sendConversationCommandV4`. Его `sendText` принимает `requestedDelivery=guide|queue`; envelope содержит стабильные commandId/clientId/sessionId/issuedAt. ACK различает accepted/duplicate/rejected и native `inputAccepted` с inputId/delivery. Legacy `buildSessionSendParams` эти режимы не передаёт. Это проверка установленного native протокола, без нового app-server.

## Проверки и изменение

До изменения source реальные8 focused regressions получили8 FAIL на запрещённом legacy sendPrompt. Штатный bounded helper: lease `.tmp/herder-steer-idle-ack-20261009/run-temp/bounded-q_am93ou`, exit1, native peak171520000B, swap0/OOM0. Старые логи сохранены.

Новая source delta переводит explicit steer/queue на V4 admission без старой RAM очереди, stop/cancel, повторного sendPrompt и ожидания completion. Стабильный caller inputId используется как commandId; automation получает существующий `agent-herder:auto:` prefix. Неверный/потерянный ACK остаётся unknown/nonRetryable. Guide fallback в queue — явная ошибка уже принятого сообщения, повторять запрещено.

Native inputId может отличаться от commandId. Сверка использует persisted sourceCommandId и две стадии корреляции IDs из turn.steerQueued/turn.steerDrained/drainedInputs и пользовательской native истории. Exact native turn.failed имеет приоритет. Независимый read-only reviewer business_supervisor обнаружил эти два случая; regressions добавлены. Всего15 новых случаев. После независимого SOURCE_ACCEPTED штатный focused case получил15 PASS и tsc --noEmit exit0 (lease bounded-qm5_iids,22.305s,payload exit0,native peak499466240B,swap/OOM0). Outer helper exit75 на cleanup population race; own scope/PID/cgroup и controlfiles уже отсутствуют, но capacity book ещё держит cleanup reservation. Infra2c получил exact generation; повтор payload запрещён, следующая backend сборка ждёт штатной сверки/освобождения резерва.

Пересоздание адаптера в focused fixture проверяет сохранение стабильного commandId и сверку из native facts. Оно **не доказывает** переживание перезапуска CLI. Installed commandAckSchema прямо ограничивает accepted состоянием native runtime; результат после рестарта определяется persisted input facts. Нельзя обещать бессрочную RAM очередь или replay неизвестной команды.

## Runtime и следующий шаг

Завершённые85 tests, build и Codex native canary относятся к00c7b9a; они не доказывают эту новую ZCode delta и не повторяются. Publisher выпустит следующий exact пакет после её focused checks и artifact.

Root24 передал актуальную единственную AutoFind координацию для sess_c1400322-3bfd-4ef3-8789-7a366d039d35, stableID `root-current213-mount-only-20261009-1`. Она **не attempted**. Предыдущий payload о36b7c9a для386 не отправлялся и устарел. Callable существующий native broker пока не найден: текущий registered MCP ещё использует legacy adapter, known protocol client только stdio со spawn; известные runtime metadata и `/proc/net/unix` ZCode broker endpoint не показывают. Root получил exact action-needed для готового endpoint/schema. Новый app-server и foreign stop не запускаются.

Composer UI QA сохраняется отдельно: primary managed Mini browser открыл настоящий public UI, но redirect auth/login; failure screenshot сохранён до cleanup, recoveryowner1f58 получил protected-login handoff. Codex native canary уже прошёл через registered MCP mode=steer/queue=false:1735.41ms receipt приinProgress, один user item и один ответ «Сообщение получено», без инструментов/повторного ввода.

## Actual backend artifact FINISH

Publisher опубликовал3 owned paths в ce4d862a2a97a3f94e7d60c5ccf117792daf99f1; source1a78faf9/test0c637887 совпали с actual15. Infra освободил request7091 только по exact native generation/free OFD/collected unit; preserved recovery receipt,15/tsc не повторялись.

Одна backend-only tsc сборка через registered build100 завершилась0 за21.933s, native peak512425984B,swap/OOM0; unitrun-u14615.scope/invocation22a69075626b42f28a4327c6f076123e/inode50787674. Own PID/CG gone, controls absent, capacity book own0/foreign0. Exact141 pinned inputs unchanged. Vite/85/15/Fast11 и native Codex canary не повторялись.

Immutable artifact: `.tmp/herder-steer-idle-ack-20261009/run-temp/bounded-u99k8oqh/backend` + `web-static`,212 files, build-manifest SHA256 f29e4f669f6132354bc28ddbbc30bcd035f5f58c93f6cb87867c6b09e60fa3d8. Только compiled adapters/zcode.js и zcode.d.ts отличаются от accepted e35 artifact; все4 frontend assets byte-identical. FINISH передан sole publisher54 через direct native steer, source review/actual component acceptance/runtime activation различаются. Promotion/restart здесь не выполнялись.

Следующий шаг: дождаться фактической deployed identity, затем один зарегистрированный native V4 guide input текущему c140 со stableID root-current213-mount-only-20261009-1. Старый386 payload устарел и не отправлялся. Actual composer browser acceptance всё ещё требует protected login; не объявлять её пройденной.

## Actual native V4 result после выпуска

Publisher выпустил ce4d862 с manifestf29e4f, PID1604235/invocationb3263a4a02364821b44577c507a6dc3e;208 deployed hashes независимо проверены, frontend4 прежние. После этого fresh registered agent_info c140 в09:45:39Z показал stopped/completed, CWD TelegramAuto, last native completed turn09:17:23Z; source tasks-index, не loaded proof.

Ровно один registered MCP send_message mode=steer с current stableID дал явный native reject `proto.sessionNotFound` за1484.77ms. Admission=false. Receipt/preSendObservation сохранены в `.tmp/zcode-direct-communication-20261009/native-current-input.json`; phase native_rejected. Автоматических повторов, нового ID, legacy sendPrompt fallback, cancel/stop не было. Handler передаёт отказ текстом без isError, поэтому успех определяется содержимым native receipt, а не одним флагом MCP. Native consumer acceptance **не пройдена**; source/tests/build/deploy не подменяют её.

Root24/publisher54 получили actionable RED. Следующее исследование — поддерживаемый same-ID cold load через существующий SDK session/resume до первого input, с доказательством loaded identity и без вмешательства в чужой активный ход. Срочный runtime owner target должен соответствовать текущей owner identity; старые target/payload не replay. UI login остаётся независимой открытой приёмкой.

## Same-ID cold load и единственный принятый ввод

Root24 подтвердил действующего c140 owner и разрешил исправить доказанный pre-admission отказ с ТЕМ ЖЕ stableID, не replay accepted/unknown. Fresh GET coordination/context показал explicit humanStopHeld=false. Один штатный registered resume_agent без message/humanRequested успешно загрузил существующую сессию за15.521s; postLoad agent_info вернул настоящий native snapshot без tasks-index discoverySource: exact c140 ID, CWD TelegramAuto, model account:zai-individual-coding-plan/GLM-5.3, pendingRequests[]. Никакого Continue/prompt в load, нового appserver или foreign cancel. Старое blanket предположение об отсутствии readSession у всех headless sessions не описывает loaded cold runtime: после SAME-ID load snapshot читается.

Один повтор ранее отклонённой до admission команды с тем же root-current213-mount-only-20261009-1 получил Message sent за22.394s. Полный packet теперь phase native_admitted/admitted=true/currentResult; первоначальный proto.sessionNotFound сохранён только в preAdmissionRejectedAttempt. Неполный MCP ответ не объявлялся достаточным proof.

Независимый read-only native SQLite session_input подтвердил РОВНО ОДНУ canonical row: queue_agent-herder:auto:root-current213-mount-only-20261009-1; delivery=startNow (после cold idle load), status=promoted, payload.intent.sourceCommandId exact, admitted_sequence25, promoted_sequence23, promoted_message_id msg_mv0sjds3_913a9a03-64df-40a9-9c39-923c4a1f6da9. Actual HTTP native history показывает этот один текущий213 user input. Это не active guide canary: loaded idle input стал startNow. Native active guide и CLI-restart survival не выдумывать. Runtime mount outcome/следующий шаг от c140 отдельно ожидаются.

Обнаружен узкий registered receipt formatting gap: handlers.ts выдаёт native ACK только при result.turnId; V4 ACK законно имеет inputId/delivery без turnId. Native admission подтверждена direct native facts, но MCP скрывает admitted/inputId. Это собственный путь publisher54; передан source hunk + запрос focused regression, без редактирования его source или нового consumer input. Consumer FINISH с current attribution отправлен Root24/publisher54; ввод больше не повторяется. UI protected login остаётся открытым независимым gate.

## Native ACK formatting release candidate

Publisher исправил свой handlers.ts receipt predicate: admitted && (turnId || inputId), optional turnId, ACK также у pending queue. Его source b8ab5c40/test76f170e6 проверены отдельным штатным case: только TWO selected tests «MCP native admission acknowledgement»,2 PASS/exit0, lease bounded-1m1948bm, native peak175415296B,swap/OOM0, cleanup complete.

Одна разрешённая backend-only сборка для этой новой delta: exit0/21.007s, lease bounded-m8z9kv2r, native peak518115328B,swap/OOM0, ownCG/PID/controls gone/book0. Immutable manifest b53c56f91f2efaf0b53c9a72d122541fbedf077075061b431d96815b44521907,212files. От livece4/f29 меняется ТОЛЬКО backend/mcp-tools/handlers.js (SHA777de652); все4 frontend assets прежние/e35. FINISH .tmp/zcode-direct-communication-20261009/native-ack-artifact-finish.json передан sole publisher для scoped commit/push/activation. Старые15/85/Fast11/build/native input не повторялись.

Native c140 runtime report сообщает выполненный текущий213 RO DIRECTORY mount, healthy30s, registry145/146/204 effective, get_user_sessions0 и auto_startfalse; покупки/TG не делались. Его независимую runtime/business проверку ведёт назначенный reviewer1b2a, этот report не подменяет наш native attribution и не требует нового сообщения. GUI остаётся pending protected login: реальный ingress auth.bez→cookie-auth18991 используетAPR1; существующий legacyGPTAdmin ADMIN_PASSWORD не совпадает (offline check, без network password guesses). Existing protected credential/login state нужен отauthowner, не новый ключ и не личный браузер.

## Final own delivery/UI boundary 09.10 21:02 МСК

Formatter958cfb8 source/runtime и one c140 native input закрыты, никаких repetitions. Последующая Root b187/cbd восстановленная backend190 сверена после frontend ONLYStop release: unchanged backend, no restart, JSON/outbox/compiledweb-ui preserved. Current UI Stop proof PASS, own source Stophunk+composer tracker отдельно у Root01a12170. This tracker doc delta не требует backend/Vite/tests/native canary. ManagedMini resource watchdog остановил Chrome после PASS; R38 supported cleanup остаётся отдельной инфраструктурной границей, не смерть native Herder. Исторический proto.sessionNotFound только preAdmissionRejectedAttempt, accepted actual c140 guide/sourceCommandId never replay.
