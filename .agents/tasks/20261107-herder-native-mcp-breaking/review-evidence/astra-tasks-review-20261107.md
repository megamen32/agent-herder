# Astra: Tasks review и контроль исполнения — 07.11.2026 10:44 UTC

Независимый reviewer Nietzsche проверил immutable `12f0d3a9 + 6c746784`. Вердикт: SUPPORTED для durable source Tasks projection; REVISE для утверждения о terminal native consumer. Авторские 29 passed + 1 ignored reviewer повторно не запускал.

## Принятая граница

Стандартные rmcp CreateTaskResult/GetTaskResult; Tasks capability проверяется до эффекта. Чтение Task требует доверенную identity, task/intent principal, authority generation и exact Session Read grant даже для terminal результата. HumanStop и adapter refusal имеют разные диагностические категории; UNKNOWN не превращается в доказанный no-send. Terminal status/result сохраняются вместе; confirmed требует точной привязки receipt, повтор request key/payload не отправляет заново.

## Отсутствующий переход

В `application/scoped_stop/mcp_task.rs` admitted всегда Working. tasks/get, repeat deliver и session/messages не вызывают read-only `application/reconcile.rs::reconcile_stored_receipt` и не сохраняют наблюдение. Тест `tests/scoped_stop_gate.rs:3513` в 6c746784 выставляет confirmed прямым SQL. Следовательно принятая доставка может навсегда остаться Working после reopen.

Tesla получил V025TASKRECON: read-only exact receipt reconciliation + fenced persistence; matching → completed → reopen, mismatch не confirmed, повтор delivery submit count=1. Ручной SQL заменить проверяемым application path. Canonical bug B1a5bccfdace749a4ae22 открыт, фикса пока нет.

Create aggregate и recovery в более позднем immutable d1f38cff (a4d57e8d/9d00677a) переданы тому же reviewer отдельно; этот документ не принимает их заранее.

## Исполнение

Каждая из восьми сессий проверена отдельным wait_threads timeoutMs:0. На 10:41UTC работали legacy CI и дополнительный Tesla; Terra/resources/browser/ZCode завершили ходы с остатком, возобновлены конкретными поручениями. Повторный readback подтверждает все четыре active и полезные действия. Исходные translator/Codex/OpenCode имеют явно зафиксированные отказы по intake/approval, повторных сообщений им нет.

Terra делает trusted owner stdio wiring → scoped application/native Reader; default Unknown остаётся. SDK proof отдельно от запрещённого T011, HTTP OAuth не блокирует ограниченную stdio вертикаль. Resources делает reply composition на существующем ledger. ZCode устраняет ноль тестов из-за отсутствующего module export и использует готовый общий feed. Browser переносит V080B evidence из ошибочной копии плана в canonical и передаёт source для main integration. ChatGPT live hold и ZCode V072D UNKNOWN не изменены.

## Пробуждение и остановки

Единственное следующее waiting: wait_cfbc121fff04d9a86f4e1c89369fcabc, 2026-11-07T11:22:06.011Z (14:22 МСК). Полный registry прочитан; дубль не создавался. Предыдущий wait_1c84ce639ceae5e8029b19b7e73204eb terminal delivery_blocked по quota_unknown, не повторялся.

В ~/.local/state/agent-herder/human-stops.json для Astra/Terra/resources/ZCode/browser записей остановки нет. Read mode automation_disarm вернул unauthorized без token, состояние общего выключателя этим вызовом НЕ подтверждено, переключатель не менялся. Native admission guards сохраняются.

Это source/review и контроль исполнения, не доказательство завершённого продукта. Public mirror канонического плана ранее превысил лимит; его синхронизация не заявляется.

## Delta-review d1f38cff — 10:50 UTC

Nietzsche: REVISE по двум независимым source дефектам. `create_task.rs:205` возвращает cached terminal child result после instance Write, до current exact Session Read/policy. После завершения aggregate и отзыва Read сохраняется выдача prompt result/native_turn_id; direct child Task отказал бы. Проверять exact Read также до cached terminal, без изменения durable результата при отказе; regression revoke и reopen. Собственный create/no-send session_ref сам по себе не блокер.

`create_prompt.rs:258–277`: repeat existing rejected delivery попадает в DeliveryUnknownOrBlocked; первый adapter_refused либо human_stop_active с effect=none превращается в UNKNOWN. Replay нет. Восстанавливать доказанный no-send из связанного task diagnostic (включая projected terminal CallToolResult); одного rejected недостаточно. Regression first→repeat→новый aggregate сохраняет session/code/effect=none и counters.

Оба findings переданы Tesla; исправления ещё не приняты.

Owner-only policy без новой grants таблицы — SUPPORTED как предпосылка: existing create intent/receipt/mapping/scoped generation атомарны и достаточны для membership. Нужен verifier по exact session с согласованным snapshot и pinned authority. Успешный create хранится admitted, поэтому literal confirmed не обязателен и не означает завершённый prompt. Explicit trusted config выдаёт permission, lineage alone не выдаёт. Unknown/imported/чужая generation/principal или отсутствие policy — deny. Нельзя повторно брать gate из policy при уже удерживаемом guard. Terra получила уточнения; фактическая реализация ещё требует proof.

## Принятые source дельты — 11:08 UTC

`ccfd813b`: cached aggregate exact Session Read-revoke исправлен, policy вынесена из gate; восстановление raw/projected no-send корректно. Review выявил дополнительный global hold: existing create вызывался до recovery. `ddc17d40` закрывает это: Created используется прямо, только Missing допускается в create_fresh_root, Pending/Unknown не повторяются. Regression session/global hold через claim→stop→handoff проверяет оба повтора до/после task projection, create1/submit0. Nietzsche SUPPORTED immutable source; WIP не использовался и author tests независимо не повторялись. Direct Task current grants и terminal reconciliation ещё открыты у Tesla.

`d6cb17b4` NativeReader — independent source SUPPORTED: exact profile/thread/единственный turn, read-only, pending/unknown не превращаются в confirmed. Confirmed означает receipt, не бизнес-успех.

`a3517774` trusted owner stdio wiring — independent SUPPORTED в explicit protected local profile boundary без hostile same-UID. Owner config обязателен, default launcher Unknown, self=None, единственный exact create receipt + current generation/mapping/scopes, no second grants store; policy читает один snapshot и проверяет pinned DB/gate inode без nested gate. Reviewer независимо выполнил2 owner-policy и2 launcher tests включая fake create→read→reopen/import deny. Live/native proof ещё не выполнен.

`f5f27200` ZCode — independent SUPPORTED source/synthetic: partial без доказательства полноты, content/info.content различаются; local pages одного immutable payload собираются до одного общего feed. Reviewer5 targeted transcript tests PASS. Actual connection.rs компилируется, transport seam fake; это не captured/live protocol. V072D UNKNOWN не затронут.

`365c1fdf` (после rebase32bc8099) Resources — Astra source review принят: чистая prepare_reply возвращает exact stored sender/in_reply_to, проверяет verified self и exact grants; новый ReplyDispatch удалён. Автор3tests+SQLite reopen. Native delivery/replay proof остаётся V027; отправка только через общий fenced deliver. Исполнитель получил готовый независимый V017A/B resources source, shared transport/lib owner Terra.

## Native Task path — source delta принято 11:18 UTC

`dfe5f79a` independent Nietzsche SUPPORTED. task_grants разрешает текущий exact Read только после task/intent principal, mapping/current generation/scopes lookup; policy вне gate. task_reconcile использует сохранённую bound receipt, освобождает gate/SQLite перед native read и подтверждает только matching observation с повторным условным UPDATE по exact binding/неизменным receipt bytes. Submit-порт отсутствует. Aggregate направляет reconciliation в сохранённый child с самостоятельной проверкой доступа.

Два independent immutable tests PASS: task_reconciliation_checks_exact_receipt_without_holding_gate_or_transaction; direct_delivery_task_uses_current_exact_policy_after_reopen. Они подтверждают mismatch→working/match→terminal+reopen, submit1, dynamic policy и revoke denial. Aggregate wire test прошёл, но reviewer не засчитал его как immutable proof из-за concurrent WIP; committed вариант просмотрен source. Автор combined48PASS+1ignored.

Terra получила verdict и продолжает previously authorized isolated real-Codex SDK consumer с явно подключённым reconciler (owner wiring45b99e04). На момент записи live result ещё не получен. Исполнитель Tesla продолжает bounded V025CREATEINPUT; он не блокирует уже принятый runtime integration.


## Реальный consumer UNKNOWN и исправление стенда — 11:35 UTC

На immutable496483e5 реальный изолированный Codex SDK consumer создал session:abb1994536b31f3025658d23b7032c79; prompt остался UNKNOWN, task create-operation:efe91c25ee89063a168ece5517cce3e4. Исходная операция не повторялась и не переименована в no-send. Доказательства в canonical review-evidence/V025PUBLIC/owner-sdk-496483e5-run.log и owner-sdk-496483e5-attempt.txt. Fixture Drop и disposable bwrap home удалили runtime DB/profile; исходное чтение восстановить нельзя.

Nietzsche сверил official Codex0.167: foreign app-server fresh unpersisted thread/read возвращает not loaded независимо includeTurns. У owning Legacy thread includeTurns:true до первого сообщения отдельно запрещён; Paginated использует другой путь с persist. Create и send уже используют один Arc Control; отдельным был pre-send NativeReader. Конкретные RPCerror/historyMode прежнего запуска не сохранены, поэтому точная причина UNKNOWN не доказана.

Terra candidate5bd4e8ac: metadata snapshot через owning control с includeTurns:false, exact ID и только explicit idle; reconciliation отдельно. Retained host-root bind для сохранения actual DB/gate inode после failure/UNKNOWN. Author fake RED/GREEN, launcher12PASS/1ignored и Python26PASS; independent Nietzsche review запрошен, результат ещё не принят. Следующий новый isolated regression case допустим после source verdict; он не разрешает replay прежнего UNKNOWN.

## Диагностика create — принято source 11:35 UTC

3fe988fa+18270c63: Astra source SUPPORTED. Авторизация проверяется до диагностики. Instance mismatch, unsupported project, empty prompt, bad request key содержат field/expected/correction/effect=none без echo значений. На чистом worker HEAD18270c63 independently run create_wire_reports_actionable_input_errors_without_effect_or_echo:1PASS, zero create/submit/intents, unauthorized generic. V025CREATEINPUT done source; native V025PUBLIC отдельно.

## Исполнители и единственное пробуждение — 11:35 UTC

Все восемь сессий повторно проверены индивидуальными wait_threads timeoutMs:0. Terra, resources и legacy CI работают. Browser после завершения0bbfbb28 получил independent source review ZCodef51058ef; ZCode получил готовый V076B. Оба active подтверждены следующими полезными действиями. Tesla после принятого create diagnostic получил independent source review browser0bbfbb28. Это распределение проверок не добавляет Тере прямых исполнителей. Translator/Codex/OpenCode с зафиксированными intake/approval refusals не возобновлялись. ChatGPT live hold и ZCodeV072D сохранены.

Старое wait_cfbc121fff04d9a86f4e1c89369fcabc terminal delivery_blocked: quota below_reserve19%, notSubmitted/admitted=false; не повторялось. Единственный следующий wait_737cb5865a2a8bd12fb3b9bd31173c22, request astra-herder-hourly-20261107T1124Z, 2026-11-07T12:24:29.091Z (15:24 МСК), readback waiting. Это новый будущий слот с неизменным guard, не обход отказа; дубли не созданы. Реестр sessions human-stops на11:34 не содержит Astra/Terra/resources/ZCode/browser; упоминание Astra в generatedInputs не является active stop. Общий disarm без token ранее не удалось прочитать; состояние не менялось.
