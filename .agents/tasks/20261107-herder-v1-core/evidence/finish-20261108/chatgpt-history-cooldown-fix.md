# ChatGPT foreground history: cooldown и повторный трафик

2026-11-08, bounded source fix по Terra
`chatgpt-request-source-audit.md`. Изменён только ChatGPT driver и existing
driver/rate tests. BrowserChatAdapter/Z.ai, runner, profile/archive механизмы,
global polling settings не менялись. Live browser, новые страницы, отправки,
install, commit/push не выполнялись.

## Доказанный defect

Foreground `getMessages` не проверял существующий Bayesian history cooldown
перед page discovery, account scope HTTP и history HTTP. Получив page-local
read_cooldown, он продолжал поиск другой вкладки того же аккаунта. После
history error выполнял ещё одну account HTTP проверку, хотя данные не возвращал.
Одновременные identical reads отдельно повторяли этот путь.

Это доказанный источник лишних запросов. Ни статический аудит, ни offline
regression не устанавливают первопричину provider/server429, фактическую
частоту live трафика или долю Herder в общей нагрузке сайта.

## Изменение

- `getMessages` проверяет cooldown до draft recovery, tabs и auth. Native full
  export тоже не начинает read при уже известном history cooldown.
- Bayesian history target уточнён verified/pinned account scope; account deadline
  разделяется driver instances одного процесса. Старый global Bayesian history
  verdict также уважается для совместимости существующих consumers.
- Server Retry-After хранится как lower bound отдельно от capped adaptive
  estimator: длинное server значение не сокращается до32мин. Чужой account
  не блокируется account-specific429. Состояние не сохраняется между процессами;
  межпроцессный controller не добавлялся.
- Перед auth для выбранной страницы проверяется её уже существующий cooldown
  чистым DOM/global read без HTTP. При active deadline он переносится на account.
  Race read_cooldown от history script также переносится; без timestamp применяется
  существующий60s fallback. Другую вкладку ради обхода не пробуем.
- HTTP trace записывается один раз сразу после read. Failure без данных не делает
  лишний post-read auth; successful data по-прежнему требуют pre/post account
  guards. Mismatch не возвращает сообщения.
- Identical concurrent reads одного driver/account/chat используют существующий
  promise-map pattern BrowserChatHistoryCache. Map очищается и при success, и при
  error. Это не response cache: следующий read получает fresh provider result.
  Между разными driver instances coalescing не вводился; cooldown разделяется.

AHAP wrapper имеет собственные account guards вокруг RPC. Этот slice их не
отключает и не обещает ноль auth HTTP во всём end-to-end runner path: zero-call
proof относится к заблокированному driver getMessages/getRawConversation.

## RED → GREEN и измеримый предел

RED: `node_modules/.bin/vitest run tests/browser-chat-read-cooldown.test.ts --reporter=dot --silent`
на старом driver:3failed,5passed. Existing Bayesian cooldown не блокировал read;
history429 и page cooldown выполняли лишний post-read auth.

GREEN: final affected suite
`node_modules/.bin/vitest run tests/browser-chat-read-cooldown.test.ts tests/chatgpt-mac-cdp-driver.test.ts tests/chatgpt-request-trace.test.ts tests/chatgpt-full-backoff.test.ts --reporter=dot --silent`
—82/82PASS,4files,0.868s.

Новые проверки используют fake Chrome tools и in-memory provider responses:

- Bayesian cooldown: ноль calls до tabs/auth; full read также отклонён.
- Known page-local cooldown: ноль auth/history fetch scripts; новый driver того
  же account отклонён ещё до tabs.
- history429: одна pre-read scope проверка, zero post-read scope; следующий
  same-account driver не делает calls даже после adaptive cap, пока действует
  Retry-After9999s. После server deadline fresh read разрешён.
- Другой account возвращает fresh result с двумя scope guards.
- Concurrent identical calls: один history execution и две scope проверки;
  следующий последовательный read получает новый message ID, не stale response.
- Account mismatch до/после history не возвращает данные; rejected in-flight
  promise не отравляет следующий read.
- Existing test, ранее требовавший fallback48→49 при cooldown, обновлён:
  теперь только48, затем явный read_cooldown. Это требуемое изменение политики.
  У test отдельный fake account, чтобы shared cooldown не загрязнял другие cases.

Эти counts относятся к fake driver tool calls, не live HTTP benchmark. Уменьшение
повторных driver запросов доказано; устранение server429/полная live приёмка — нет.
`node_modules/.bin/tsc --noEmit --incremental false` и `git diff --check`
прошли. Чужой WIP и принятые/UNKNOWN операции сохранены.
