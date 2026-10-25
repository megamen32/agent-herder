# Проверки восстановления квот — 22.10.2026

Прямое согласование владельца передано основной сессией: реализация, scoped main publication, build/restart Herder и собственные benign native OpenCode/ZCode consumer canaries разрешены. Рабочий OmniRoute сохраняется ради общего logging/context. Никаких core forks, платного fallback или скрытой смены provider.

Канонический checkout: `/home/roomhacker/agents-projects/agent-herder`; runtime: user systemd `agent-herder.service`, существующий immutable release path из ExecStart. GET управления: `http://127.0.0.1:18787`; native OpenCode endpoint из существующей конфигурации сервиса. Защищённый env reference: `~/.config/agent-herder/herder.env`; значения не выводить/не копировать в артефакты.

Fixture owner: `/root/herder_core`, отдельные session/input IDs и собственный `.tmp/` путь. Исторические cohort receipts, accepted/pending/unknown/held и HumanStop не возобновлять и не повторять. Перед каждым canary readback exact native identity и receipt. UI browser: собственные короткие session/namespace, auto-connect=false, headed=false; screenshot при ошибке до retry; close только своего browser.

Тесты Vitest используют `tests/vitest-isolation.setup.ts`, который до import изолирует durable state-dir и singleton ledgers. Проверка источника не означает публикацию/installed/consumer acceptance. Реальное восстановление GLM pending до внешнего quota reset; fake PASS запрещён.

## Permission control fixtures — 25.10.2026

For this cycle, Lead authorized at most one isolated native fixture per
harness. Fixtures use only a benign local marker read, no production project,
credential, external network, provider turn, or external action. OpenCode was
checked through its supported local session API, with exact-session mode and
scope readback; cleanup removed only the task-owned fixture session, process,
and temporary state. Codex mode readback showed the requested mode was not
supported; no provider turn ran. Fixture identities and timestamps are kept in
private task receipts, not this repository.

## Existing ZCode sessions — 25.10.2026

Lead separately read five existing ZCode sessions on host 100. All five
reported native YOLO mode and no pending permission requests. Four previously
authorized requests were answered once and read back; the fifth already had no
pending request and was not modified. No prompts, commands, calls, session
creation, model changes, or repeated approvals are authorized by this record.
The private receipt retains exact identities and timestamps.


<!-- owner-rule:no-personal-phone-tests:2026-10-23:begin -->
## СТРОГОЕ ПРАВИЛО ВЛАДЕЛЬЦА: тестовые звонки только Matrix
Решение владельца от 23.10.2026 02:36 UTC. Действует постоянно, в любое время суток, для всех агентов, дочерних сессий, проверок, демонстраций, канареек и приёмки. Это более позднее ограничение заменяет прежние общие разрешения на голосовые тесты.

1. Запрещено звонить на реальный телефон владельца или любого человека ради разработки, проверки, отладки, демонстрации, приёмки или проверки эскалации. Нельзя использовать PSTN/GSM/SIM/внешний SIP, Android dialer, телефонный fallback или перенаправление для такого теста. Нельзя будить владельца звонком, сигналом вызова либо уведомлением о тесте.
2. Голосовые тесты проводятся только между отдельными тестовыми бот-аккаунтами Matrix/MatrixRTC в изолированной тестовой комнате: агент звонит тестовому агенту/самому себе. Личный аккаунт Matrix владельца, его рабочая комната и его мобильный клиент не являются тестовым собеседником. Перед вызовом подтвердить тестовые account_ref, target и room_id и отсутствие телефонного маршрута/fallback. Если изоляция неизвестна, вызов не выполнять.
3. Немедленно прекратить уже идущий тестовый вызов человеку и отменить относящиеся к нему ожидающие/повторные вызовы. UNKNOWN/accepted вызов не повторять; читать квитанцию и состояние. Не делать новый звонок для проверки этого запрета.
4. Общие фразы «протестируй», «проверь end-to-end», «разрешаю тесты», старые QA-разрешения и наличие контакта/токена не дают разрешения звонить человеку. Исключение возможно только по НОВОМУ явному указанию владельца на конкретный реальный адресат и конкретный звонок. Не запрашивать его ради продолжения обычных тестов: использовать Matrix.
5. Не маркировать тест как боевой инцидент для обхода правила. Тестовые события должны идти в тестовые контакты/комнаты без эскалации на телефон. Настоящие нетестовые инциденты и явно заказанные владельцем реальные звонки сохраняют отдельную действующую политику; не отключать всю связь или чужие вызовы.
6. Руководитель передаёт это правило каждому уже назначенному голосовому/уведомительному исполнителю и включает его в существующий TEST_ACCESS/план приёмки. Доказательство приёмки: тестовые Matrix-участники и квитанция; реальных телефонных наборов/уведомлений владельцу ноль.
<!-- owner-rule:no-personal-phone-tests:2026-10-23:end -->

## Общий SSO для browser QA — 26.10.2026

Для разрешённых проверок используйте существующую тестовую учётку `testlogin`
(active, nonlegacy, `is_admin=1`, та же политика SSO-доступа, что у админа).
Защищённая ссылка на пароль: SSS `sso.qa.admin-equivalent`; значение не читать
в контекст, аргументы, environment, файлы и логи. Точный безопасный маршрут:
[каноническая инструкция SSO](/home/roomhacker/simple-cookie-auth/docs/SSO-QA-ACCESS.md)
и локальный навык `sso-test-access`. Потребитель:
`/home/roomhacker/simple-cookie-auth/scripts/sso-qa-fill.py`, запускаемый через
`sss-run sso.qa.admin-equivalent -- … --session <own> --namespace <own>`.
Он только заполняет форму, затем одно явное нажатие входа и readback страницы.
26.10.2026 реальный вход открыл защищённую страницу Agent Herder; сообщений,
задач, звонков и изменений продукта не выполнялось. Повторное создание
учётки/роли, правка htpasswd и перезапуск SSO для QA-входа не нужны.
