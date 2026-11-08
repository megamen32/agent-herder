# Безопасная диагностика browser send failure

2026-11-08. Scope: `src/ahap-browser-runner.ts`, существующий
`tests/ahap-browser-runner.test.ts`, этот evidence. Без live browser/RPC,
send/archive, core edits, изменений BrowserChatAdapter, commit/push.

## Дефект и изменение

`BrowserChatAdapter.sendMessage` возвращает `ok:false` с причиной в `error`.
AHAP wrapper заменял любую такую причину одинаковым outcome unknown без стадии.
Теперь failure data дополнена только фиксированными `stage` и `reason`.
Классификация использует полное равенство известных adapter literals: никаких
prefix/includes/regex матчей с произвольными suffix и никакого echo raw текста.
Строки длиннее 1024 символов и неизвестные значения дают `send/unknown`.

| Stage | Reason | Пример известного источника |
|---|---|---|
| preclick | draft_changed / send_not_ready | ChatGPT/ZAI rejected/blocked before click, first message not submitted |
| account_check | account_scope_mismatch | pinned browser/ChatGPT account mismatch |
| transport | transport_timeout | Mac mini operation timeout; точные CDP timeout literals |
| native_admission | native_admission_unknown | native route/admission unconfirmed; unique message receipt unavailable |
| readback | read_failed | известные history cooldown/HTTP/auth/unavailable ответы |
| send | unknown | любое неизвестное/расширенное/нестроковое значение |

Поля outcome=unknown, retryable=false и correctiveAction сохранены.
Метка preclick является описанием известной adapter причины, не доказательством
effect=none и не разрешением replay. Legacy notSubmitted флаг не превращён в
no-effect. Retry/send/recovery механизм не добавлялся.

Одинаковая sanitization применяется к returned `ok:false`, thrown Error и
pre-dispatch account guard. Для AhapReadError на send path сохранён исходный
error code, но raw message заменён постоянным публичным текстом. Иные методы
сохраняют прежнее поведение. Успешный send не изменён.

## RED → GREEN

Команда: `node_modules/.bin/vitest run tests/ahap-browser-runner.test.ts --reporter=dot`.

RED до source fix: 33 новых теста упали из-за отсутствующих stage/reason;
31 прежний тест прошёл. После source fix: 64/64 PASS.

Отдельная регрессия AhapReadError: RED командой
`node_modules/.bin/vitest run tests/ahap-browser-runner.test.ts -t 'sanitizes typed errors' --reporter=dot`.
Она показала обход sanitization в специальном catch. Минимальная правка сохраняет
код и UNKNOWN semantics, убирает raw message. Финальный полный runner suite:
65/65 PASS, duration 1.29s.

Проверки выполняют in-memory AHAP JSONL exchanges, без реального browser.
Есть returned и thrown known reasons; raw suffix с fake token/URL/account scope,
длинная строка и prompt/session markers не попадают в error output. Каждый
диагностический ответ ограничен <1000 bytes для test payload; send выполняется
один раз. Известные строки с добавленным секретным suffix получают unknown,
а не частичное совпадение. Account guard вызывает send ноль раз.

`node_modules/.bin/tsc --noEmit --incremental false` и `git diff --check`
прошли. Source/fake adapter proof не является live
candidate/installed acceptance; исторические UNKNOWN операции не повторялись.
