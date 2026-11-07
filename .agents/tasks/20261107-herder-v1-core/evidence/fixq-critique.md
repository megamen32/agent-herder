# FIXQ — независимый source review

Вердикт: блокирующих дефектов в проверенном source snapshot не обнаружено. Это source review, не утверждение о runtime/installed acceptance и не повтор CI create.

## Проверенные свойства

- `src/codex-quota-guard.ts:146`: единственное найденное production-конструирование `CodexQuotaBlockedError` находится в отказе quota guard. `src/adapters/codex-app-server.ts:2997`: для `thread/start` guard выполняется до выделения pending request и `writeMessage`. Чтение account/rateLimits возможно, но native thread/start еще не отправлен.
- `src/adapters/codex-app-server.ts:1114`: createSession вызывает один thread/start. После него идут проверки результата, model/list, возможные config/read и thread/name/set; повторного quota guard с operation=thread/start в этом пути нет. Ошибки после native create не превращаются в этот typed quota error. Нового retry в пути не обнаружено.
- `src/ahap-codex-runner.ts:131`: специальный envelope возможен только для фактического createSession, instanceof того же класса, operation=thread/start и пяти allowlisted reasons. Error name/message/duck type не дают такого доказательства. Поля: outcome=not_submitted, admitted=false, notSubmitted=true, retryable=false, code=codex_quota_guard, method=createSession, operation=thread/start, reason из allowlist. Текст произвольного исключения не возвращается.
- `crates/herder/src/adapters/ahap.rs:114,240`: проверяются локальные configured harness=codex и method=createSession; JSON-RPC version/id, result XOR error, ровно три поля envelope/error, восемь полей data, точные типы/значения и allowlist. Лишние/неполные/противоречивые поля не дают DefinitelyNotSent. `ahap_opencode.rs:279`: остальные remote/protocol/uncertain errors остаются OutcomeUnknown. Уже существующая классификация локального BeforeSend не расширяется этим изменением.
- `application/scoped_stop.rs` сохраняет различие mark_create_rejected и mark_create_unknown. `store/lineage.rs:65`: rejected записывается только из dispatching при точном principal/target/key/payload и native_receipt IS NULL; при несовпадении transaction откатывается. Сохраненный UNKNOWN этим путем не переклассифицируется.
- `application/scoped_stop/create_prompt.rs:145`: recovery выполняется первым; Unknown, Pending, DefinitelyNotSent и Conflict возвращаются без повторного native create. Только Missing допускает создание; Existing повторно читает состояние. `create_recovery.rs` читает исходные durable состояния. No replay fence сохранен.
- `application/scoped_stop/create_task.rs:75`: CreateDefinitelyNotSent завершается с create.effect=none, prompt.effect=none, code=create_not_sent. Retry::SafeSameKey в create_prompt относится к отдельной диагностике session grant; он не обходит recovery и не дает права повторять create по сохраненному rejected/UNKNOWN.

## Проверка актуального diff и тестовых исходников

Повторно просмотрен landed core diff commit `561951cc` (включая top-level object.len()==3). Проверены тестовые исходники `tests/ahap-codex-runner.test.ts:161` и `tests/ahap_v1_reuse.rs:593`: пять разрешенных reasons; generic/duck-type/wrong operation; malformed/contradictory receipt, лишние поля, wrong ID, ambiguous result+error, disconnect, фактические wrong harness/method; счетчики исключают лишний create/send.

Тесты в этом независимом review НЕ запускались. Gap: фактический результат targeted test runs и кандидатной интеграции должен приложить владелец реализации/CI. Исходный сохраненный UNKNOWN не изменялся и не воспроизводился. Никаких app-server thread/start, model sends или изменений runtime не выполнялось.

## Snapshot

Checkout: `/home/roomhacker/.codex/worktrees/herder-quota-receipt/agent-herder`

HEAD при финальном чтении: `561951ccd55b17f0e4dd09918037b9e520bc9fd9`

UTC: 2026-11-07T21:18:20.819135+00:00

SHA-256:

- `src/codex-quota-guard.ts` — `47851853cbc3a8e8ff4f9718cffac18cdd28e9c68f0b96c1ed730cddcca02456`
- `src/adapters/codex-app-server.ts` — `2563fcfa781f0d20e9891fac2ea221d00b06159fadd84ebedf14e781438c4024`
- `src/ahap-codex-runner.ts` — `eab10e7e80f0f78aee96e3dfbe9a4d7aaf44551b15ec558958c14eec32198292`
- `crates/herder/src/adapters/ahap.rs` — `842fd1025962bcc72baaab81ba9d2be2b0237d69cea206f60659bb882cbf3bd4`
- `crates/herder/src/adapters/ahap_opencode.rs` — `8b3aa77f55cb7514023da23dca3356a39b25f52c14cb22a967a837e1ec07ae91`
- `crates/herder/src/application/scoped_stop.rs` — `bec7bb392cce6a532ed07bb7928388bfec51a473cf4f86f1f54c0d32b48ae340`
- `crates/herder/src/application/scoped_stop/create_recovery.rs` — `bdc6e7b85c008b0a5c23de600a5088b0461164f5e70bea760ed5536acaed63ce`
- `crates/herder/src/application/scoped_stop/create_prompt.rs` — `6ffd309b15baca1a1b22bf751f5b20efab177bb46ce4b0eb5cd309a0c4088a01`
- `crates/herder/src/application/scoped_stop/create_task.rs` — `193428381e90f6d4ad3307592caea18c6abed5dc96184af46b530a3a73f0b5cd`
- `crates/herder/src/store/lineage.rs` — `fbe081bc3345dde51c6071f489b09bc7d2f5b4e82dcc5c7673e2bf40627fd875`
- `tests/ahap-codex-runner.test.ts` — `9d3a690c78dcb4e938c6776f4ffd86bc7db3c4a36665ec065d8550ae72e5a58c`
- `tests/ahap_v1_reuse.rs` — `90922aad4b25212b16e02c3b55b0c61d130cf13d401164d19ce9fe6793cf52aa`
