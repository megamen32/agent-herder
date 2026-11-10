# CIROUTE10: установленный preflight, 10 ноября 2026

Проверка только чтением; отправки моделей, тестовых уведомлений и звонков не выполнялись. Чужие вкладки и настройки не менялись. Canonical HEAD и работающий TS service: `1fcac12e511d17d203ab8a08fb662f2a1f7b46b1`, PID 1188929 на момент проверки.

## Разные источники профилей

- Shared GPTAdmin child использует `/home/roomhacker/.config/agent-herder/gptadmin-entry.json`, а не `v1-entry.json`. Readback selector: manifest `herder-v1-zai-autopilot-d584fb68`, только `codex-local`, `codex-44`, `opencode-noticeplace-local`. Это объясняет три видимых CLI instance.
- `v1-entry.json` указывает на тот же manifest, но содержит дополнительно `chatgpt-mini-default` и `zai-mini-default`. Наличие профилей в этом selector не означает, что они доступны shared GPTAdmin child. ZCode нет ни в одном из двух проверенных selector. Shared selector и runtime принадлежат Lead: необходимы решение о составе и release/CAS, а затем public readback.
- Защищённый `/etc/agent-herder-ci-smoke/fixture.json` содержит пять smoke lanes: ChatGPT, Z.ai, OpenCode, Codex и ZCode. Это отдельный набор, не доказательство наличия этих instances в shared public core. Пинованные profile и adapter SHA для трёх проблемных lanes совпадают с текущими файлами.

## Read-only native preflight установленного bindings

Через `/opt/agent-herder-ci-smoke/bindings.cjs` и установленный fixture вызваны только `createInstalledSmokeBindings`, `native.<lane>.preflight()` и закрытие собственных transport. Factory READY; OpenCode READY; Codex READY; ChatGPT, Z.ai и ZCode вернули `native_read_or_coverage_failed`; закрытие созданных transport успешно. UI-сценарий и модельные операции не запускались, глобальный inventory остаётся UNVERIFIED.

Для локализации выполнена отдельная проверка installed factory с тем же profile launch context, вывод только безопасного этапа/кода:

- ChatGPT и Z.ai: на `verifyPinnedAccountScope` код `vibe_chrome_operation_outcome_unavailable_do_not_replay`. Точный исход соответствующей browser-операции неизвестен; не повторять её до выяснения исходной квитанции/состояния. Успех `list_pages` другого Vibe маршрута не доказывает работоспособность этого account-bound маршрута.
- ZCode: smoke fixture ссылается на adapter релиза `herder-v1-82b91db9-readfix`; у установленного adapter отсутствуют `getPinnedCreateModel`, `verifyPinnedCreateModel` и export `readZcodeOfficialRunning`, которые требует установленный smoke. В profile также отсутствует ключ `AHAP_ZCODE_CREATE_MODEL`. Следовательно, этот установленный набор несовместим с проверкой даже при исправном сервере. Исходный `src/ahap-zcode-runner.ts` уже содержит проверку модели; его наличие в source не доказывает готовность установленного artifact. Нужен совместимый опубликованный adapter и точный подтверждённый model pin в защищённом profile, с согласованной перепривязкой хешей fixture и install manifest у Lead.

Старый `manual-rust-v1-aa5073` подтверждает identity PASS и `model_effects=NOT_SUBMITTED`, но сохраняет общий `transport_or_provider_failure`; его receipt содержит `undefined`, поэтому не позволяет определить точную причину. Новый full smoke не запускался: после preflight он отправляет модельные запросы, а route и состав profiles ещё не согласованы. Исправления source не вносились: подтверждённый ближайший ZCode blocker находится в установленном artifact/config и требует Lead release/CAS; для browser account проверка исхода обязательна до повторения.
