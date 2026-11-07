# Herder V1: reuse прежних адаптеров

Решение владельца 07.11.2026 21:38 МСК. Общий срок: до **08.11.2026 00:38 МСК**, включая интеграцию. Новый продуктовый владелец: `../20261107-herder-v1-core`. CI исправляет прежние адаптеры; продуктовая сторона владеет ядром и тонким подключением. Новые адаптеры и test-only API запрещены.

Source inspection: published main `7c7434f58449ce13dbd6ba0cdf3a3d3450090fcc`. Это карта исходников и сохранённых receipts, не новый live PASS.

## Точные entrypoints

| Приоритет / среда | Прежний adapter entrypoint | Штатная конфигурация / существующий thin entrypoint |
|---|---|---|
| 1 ChatGPT | `src/adapters/browser-chat-loader.ts::loadBrowserChatProviderAdapter("chatgpt")` → `browser-chat.ts::BrowserChatAdapter` → `chatgpt-mac-cdp-driver.ts::createBrowserChatDriver` / `ChatGptMacCdpDriver` | Existing builtin `builtin:chatgpt-mac-cdp` в `AGENT_HERDER_BROWSER_CHAT_PROVIDERS`. Уже опубликованный `src/ahap-browser-runner.ts::serveBrowserChatAhap` / `makeConfiguredAdapter`: AHAP_VERSION=0.1, AHAP_HARNESS=chatgpt, explicit transport/page/account scope. MacMiniChromeTransport, gateway page namespace, без подмены CDP target. |
| 1 Z.ai | `loadBrowserChatProviderAdapter("zai")` → `BrowserChatAdapter` → `zai-cdp-driver.ts::createBrowserChatDriver` / `ZaiCdpDriver` | Existing builtin `builtin:zai-cdp`; тот же `serveBrowserChatAhap`, AHAP_HARNESS=zai, exact page/account. Factory4489c69b уже есть, заново не создавать. |
| 2 OpenCode | `src/adapters/opencode.ts::OpenCodeAdapter` | `src/index.ts::configureAdapterRegistry`: OPENCODE_URL / OPENCODE_SERVER_PASSWORD. `src/ahap-opencode-runner.ts::serveOpenCodeAhap` / `makeConfiguredAdapter`: AHAP_OPENCODE_BASE_URL / AHAP_OPENCODE_PASSWORD; native protocol v2/v22 определяется существующим probe. |
| 3 Codex | `src/adapters/codex-app-server.ts::CodexAppServerAdapter` | Existing constructor: codexBin, args (default app-server), cwd, socketPath, codexDir, projectRuntimePolicy. `src/index.ts::configureAdapterRegistry`: CODEX_BIN/CODEX_CWD. Не заменять на отдельный переписанный Rust adapter; конкретный thin bridge определяет ядро. |
| 3 ZCode | `src/adapters/zcode.ts::ZcodeAdapter` | Existing constructor `{command,args:[entry],cwd}`; registry ZCODE_SERVER_NODE/ZCODE_SERVER_ENTRY/ZCODE_CWD. Existing `src/ahap-zcode-runner.ts::serveZcodeAhap`, AHAP_ZCODE_SERVER_NODE/ENTRY/CWD. |

Исполняемый compiled path и digest брать из опубликованного manifest, а не предполагать наличие файла по имени TypeScript source. Consumer V1 после решения кворума должен вызывать эти реализации, не внутренний тестовый dispatcher.

## Возможности и минимальные пробелы

| Среда | Что уже есть в legacy source | Минимальное действие / граница доказательства |
|---|---|---|
| ChatGPT | BrowserChatAdapter: listSessions, createSession, getSession, getSessionMessages, sendMessage, getRawTranscript, listProjects. Driver объявляет projects/nativeConversationIds/chatCreation/queueAfterGeneration. Полная пагинация: `src/chatgpt-transcript-reader.ts::createChatgptTranscriptReader`. | Сохранённый L101: read_cooldown не завершился после видимого ожидания; observer running при idle. Воспроизвести exact page7 и локализовать рассогласование, прежде чем менять backoff/observer; это наблюдаемый симптом, root cause не доказана. AHAP сейчас не экспортирует getRawTranscript/listProjects — задача thin hookup. |
| Z.ai | Те же общие методы; driver listProjects; getRawTranscript и `src/zai-transcript-reader.ts::createZaiTranscriptReader`. Driver nativeConversationIds=false и accountArchiveViaCdp=false — не объявлять обратное. | Исторический полный transcript 30 events/3pages; редкий timeout не доказывает новый root cause. Существующий challenge reload сохранять; новый challenge не провоцировать. Exact-account proof при пустом chat list отсутствует в текущем AHAP driver: явная ограниченная capability, не guessed account. Raw export/projects не выведены в AHAP. |
| OpenCode | listSessions, createSession, sendMessage, getSession, getSessionMessages, getRawTranscript. Поддержаны прежние native API families. | Исправление malformed JSON/protocol probe уже опубликовано1d89d04d; не повторять его. Saved real initial-send/read/reopen есть. Standalone deliver и full public contract проверить отдельно. AHAP METHODS сейчас не включает listSessions/getRawTranscript/projects; отсутствие public export — core/hookup gap, не отсутствие legacy transcript. |
| Codex | listSessions, createSession, sendMessage, getSession, getSessionMessages, getRawTranscript; existing socket/process configuration. | Исторический process-wide provider mismatch остаётся точной задачей выбора поддержанного runtime instance/config. Не менять рабочий provider и не создавать test-only route. Loaded-thread list fix70d2ead8 уже сделан. Нужен reuse существующего класса в thin hookup, а не новые native protocol handlers. |
| ZCode | listSessions, createSession, sendMessage, getSession, getSessionMessages, getSessionMessagesPage, getRawTranscript, listProjects. | Legacy candidate real server3.17.2 уже прошёл. AHAP METHODS включает только init/create/send/get/messages; список, raw transcript, projects требуют подключения. Привязка runner к server44 — дефект CI configuration, не native adapter. Native receipt input/turn IDs не подменять. |

Search не является универсальным методом этих adapter classes: прежний пользовательский search обслуживается индексом/общим слоем Herder (`tests/native/herder_search.mjs` проверяет обычный MCP). Ядро должно определить reuse этого пути или публичный эквивалент. Projects у Codex/OpenCode нельзя выдавать за готовый adapter API: точное публичное отображение project registry относится к единому контракту. `getSessionMessages(limit)` не заменяет `getRawTranscript` и доказательство полной пагинации.

## Fixtures, которые сохраняются

- `tests/native/test-model-server.py`, `launch.py`, `candidate_stand.py`, `candidate_driver.py`, `herder_journey.py`, `transcript_proof.py`, `search_proof.py` — существующая deterministic основа. Один fixture server/profile на lane.
- `tests/native/ahap_opencode_stand.py`: точный writer Luna `01a1b5e5-b6de-74c3-8276-45803194a16f`, worktree `/home/roomhacker/.codex/worktrees/ahap-opencode-consumer/agent-herder`. Не писать конкурентно; reuse опубликованный stand. Manifest `ahap-qocjoin-1d89d04d/manifest.json` и штатные --core/--runner/--opencode/--node/--bootstrap.
- ZCode pinned existing runner и native package: refs/argv в `../20261105-deterministic-harness-ci/evidence/CI-SHARED-INPUTS-20261107.md`; CONFIG заменяет machine constants, не переписывает adapter.
- ChatGPT page7 / exact chat `6aee9fd5-7ee0-83ea-a06f-a3ed148605e8`; account/claim в защищённом resource-scope. Один native оператор CI, UNKNOWN не replay. Обычные page1/page3 не становятся тестовыми автоматически.
- Gemma4 — дополнительная проверка понятности tools. Быстрый deterministic CI остаётся без GPU/provider expense. Browser ChatGPT/Z.ai — настоящие авторизованные приложения.

## Исполнение до дедлайна

Сначала ChatGPT/Z.ai: read-only reconciliation сохранённых receipts → минимальный доказанный defect через RED→fix→GREEN → native readback. Затем OpenCode, Codex, ZCode. CONFIG/REPORT независимы и сохраняются. Astra ведёт сложные defects и приёмку, Terra — ограниченные config/wiring задачи, Luna — готовые routine checks. Новые исполнители не считаются работающими до native admission.

Обнаруженный пробел thin wrapper передаётся ядру один раз с exact method/capability; legacy исправляется CI только при воспроизводимом нарушении исходного поведения. Наличие метода в source не означает current live PASS. В этой сверке коллизий файлов или фундаментальной несовместимости reuse не обнаружено; редкий timeout/unsupported hookup не повод создавать новый adapter.

## Проверено 07.11 22:39 МСК: вторая отправка OpenCode

Artifact ahap-qocjoin-1d89d04d содержит v2.2.4 с native family **v2**. Два POST `/api/session/{same-id}/prompt` с delivery=queue дали два завершённых ответа и ровно2 обращения к изолированной лжемодели. Evidence: `evidence/opencode-second-send.json`. Принудительный v22 `/provider` отказан до отправки. Legacy v2 умеет follow-up; initial-only gate текущего AHAP wrapper — точный остаток продуктового owner. Ограничение v22 не снимаем без отдельного доказательства. Это native proof, не public MCP/installed PASS.
