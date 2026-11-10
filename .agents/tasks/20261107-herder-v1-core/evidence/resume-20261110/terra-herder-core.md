# BROWSER10 Herder UserIO core

## Реализовано

В owned source slice добавлен maintained UserIO путь для ChatGPT browser adapter:

- `AHAP_BROWSER_TRANSPORT` по умолчанию выбирает `userio`, если окружение не задало другой transport. UserIO принимает `AHAP_USERIO_ACCESS_TOKEN_FILE` и Rust-compatible alias `AHAP_USERIO_TOKEN_FILE`; конфликт alias или частичная конфигурация завершаются ошибкой. Vibe и direct CDP не являются implicit fallback.
- Broker result обязан содержать фактические `agent_id`, action и `agent_instance_id`; отсутствие native instance identity не превращается в PASS даже при `result.ok=true`. Проверка совпадения с исходным command receipt выполняется до использования backend response.
- `gpt_read` проверяет `chat_ref` и account scope, использует полный native `messages` при наличии и сохраняет latest pair как совместимый fallback. Добавлен raw transcript с `snapshot_epoch`, `revision`, `coverage`, `complete` и `limitations`; pair-only response честно помечается incomplete.
- Account scope helper вычисляет SHA-256 от `{provider,user_id,account_id}`; профильная миграция остаётся Lead-controlled.
- Документация описывает UserIO extension channel как maintained core и явно помечает Vibe/direct CDP experimental/unmaintained.

## RED -> fix -> GREEN

Первый targeted test run был RED: полный `gpt_read.messages` игнорировался, raw transcript отсутствовал, default transport требовал явного значения; результат 3 failed. После исправления и добавления native identity checks targeted suite стала GREEN: `tests/chatgpt-userio-driver.test.ts` и `tests/ahap-browser-runner.test.ts` — **76 тестов PASS**. `tsc --noEmit` — PASS.

## Stage для Lead

Компилированный output подготовлен в `/home/roomhacker/herder-artifacts/ci-runs/resume-browser-20261110-01a1c551/compiled`; это source-derived staging, shared runtime и selectors не менялись. SHA manifest: `/home/roomhacker/herder-artifacts/ci-runs/resume-browser-20261110-01a1c551/source-hashes.json`, SHA256 `9f19bd30054fed98e9ee4981a9e007ec3794ff81f3d34322f10e88c434ae9328`.

Lead должен перед install CAS повторно собрать/проверить Rust/TS alignment и обновить pinned profiles: старые user-only account scopes не принимаются как новая identity. Финальный installed smoke должен использовать Herder extension path; Vibe/account gates из старого smoke не являются acceptance для этой slice.

Существующий backend `universal-userio/src/universal_userio/agent_channel.py` сейчас сохраняет `agent_id` и action, но не добавляет `agent_instance_id` в серверный result record. Поэтому source adapter теперь fail-closed на текущем backend до отдельного extension/backend изменения и не заявляет consumer acceptance.
