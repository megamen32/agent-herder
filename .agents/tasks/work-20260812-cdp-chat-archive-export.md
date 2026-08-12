# Task: export ChatGPT articles, deep-research reports, and Library files

Started at: 2026-08-12 11:57 MSK
Lifecycle provenance: copied from todo-20260812-cdp-chat-archive-export.md before implementation.
Last task-file mtime observed: 2026-08-12 11:57 MSK
Harness: Codex desktop
PID: unknown (desktop harness)
Agent session: current Codex task thread (opaque ID not exposed to task shell)
PID status: active Lead task
Last PID signal: 2026-08-12 14:58 MSK, native-export route retired; one-page history-export slice started.
Last task-file transition: work redirected to the user-selected YAGNI history-export route.

## Original request

> Мне нужно все-все-все статьи и файлы скачать, и все глубокие исследования. И заодно добавь в MCP сервер. Сначала подумай минимальный путь, который нужно расширить, чтобы это получить.

## Business outcome / 80-20 DoD

One ChatGPT archive is requested and, when available, downloaded into a user-controlled local archive. The MCP exposes the two minimum operations needed to keep that outcome repeatable:

1. request the native ChatGPT data export for conversations/deep-research history;
2. import the returned ZIP into one archive directory with a JSONL manifest.

The archive preserves original files and the native ZIP first. Library batch download is routed as the next capability only if the downloaded ZIP proves that assets are missing; publishing/conversion is deferred until the real source formats are visible.

## Production-path evidence

- Real authenticated ChatGPT UI exposed `Библиотека`, `Настройки`, and the `Управление данными` settings tab in one BrowserClaw-owned page on Mac mini.
- BrowserClaw exposes `tabs`, `snapshot`, `act`, `download`, `evaluate`, and `screenshot`; `download` accepts a page and a fresh UI ref.
- Official ChatGPT documentation says native export provides chat history and related account data via an email/SMS ZIP; Library supports selection and download of saved files; completed Deep Research reports support Markdown, Word, and PDF downloads.

## Shortest business canary

One persistent BrowserClaw MCP process opens exactly one owned ChatGPT page, requests the native account export, and returns a redacted receipt. When the email/SMS ZIP is available, `import_account_export` lists the actual archive content and preserves every entry with a manifest.

## Confirmed scope

- Extend the existing standalone/Agent Herder namespaced CDP chat capability, not Telegram or the browser-wake path.
- Add archive models, MCP tool registration, BrowserClaw persistent-page operation, local ZIP import/manifest storage, focused tests, and operator documentation.
- Preserve existing chats: no prompt submission, edit, or send action.

## Explicit exclusions

- Publishing or transforming material before source inspection.
- Telegram MCP/Overpod and E-Frontier secretary flow.
- Restarting/deploying Agent Herder; activate only after a separately authorized restart.
- Credentials, MFA, account changes beyond the user-requested export request.

## Initial estimate (UTC+3, immutable)

- Started: 2026-08-12 11:57 MSK
- Minimum / maximum active time: 20 / 45 active minutes for source discovery and the first archive-capability slice. Delivery of ChatGPT's native ZIP is asynchronous and outside that active-time estimate.

## Plan / execution

- Source path verified.
- Implementing native export receipt plus safe ZIP import and manifest.

## Evidence / result

- Pending implementation.

## Route change — 2026-08-12 14:58 MSK

The native ChatGPT export surface is not available in the owned page. The user selected the direct route: read a chat in the one persistent owned page, scroll its history, and preserve a resumable local archive.

### Updated 80-20 DoD

1. `cdp_list_chats` returns the page-visible sidebar chats from the one owned page.
2. `cdp_export_chat` opens one selected chat in that same page, reads the visible history, scrolls backward until complete or a bounded checkpoint, and writes a resumable raw archive plus manifest locally.
3. Existing chats remain read-only: no send, edit, prompt submission, or use of `E-Frontier` as the canary.
4. The first live proof is one non-`E-Frontier` chat archived from the running Agent Herder page. File download is the next vertical only when the first archive exposes attachment controls.

### Current bounded cycle

- Started: 2026-08-12 14:58 MSK.
- Minimum / maximum active time: 15 / 30 minutes.
- Worker research lane: inspect the existing BrowserClaw semantic contract and report the smallest read-only scroll/download integration point. No live browser access, no code edits, no restart.
- Lead lane: revise the driver/client boundary, implement the vertical, run focused tests and build, then request one explicit restart approval for the live canary.

### Release canary — 2026-08-12 16:00 MSK

- User approved one restart of `agent-herder.service`.
- Before that restart, the history route now records a private same-page screenshot receipt after the first chat open and on an action failure. This gives the tester/debug path visual evidence without a second tab.
- Canary: list the owned sidebar, select one visible non-`E-Frontier` chat, run `cdp_export_chat` with a bounded segment count, and verify the local receipt, raw archive, and manifest. Stop at the first BrowserClaw failure.

### Canary correction — 2026-08-12 16:40 MSK

- The first live action did not reach a `/c/...` route: the a11y selector accepted a sidebar shell link and stored a landing-page snapshot. It is not accepted as a chat archive.
- The source fix excludes large shell links and non-chat navigation, refreshes the owned page URL after a semantic action, and fails closed unless the click reaches a conversation route. A focused regression test covers both conditions.
- The corrected build needs one separately authorized service restart before the next live canary. The false local archive is removed below; its screenshot remains as private failure evidence.

### Second live canary and selector correction — 2026-08-12 17:55–18:25 MSK

- The user approved one additional restart. The restarted Agent Herder exposed `cdp_list_chats` and `cdp_export_chat`; it opened one BrowserClaw-owned ChatGPT page and did not create a tab per tool call.
- The first selected non-protected sidebar row did not reach `/c/...`; the same owned page remained on the landing route. The driver stopped before saving chat content, captured and inspected the required private same-page screenshot, and wrote a redacted failure receipt under `trash/logs/`. No retry or extra browser action followed.
- Root cause: a Project/sidebar link may share the compact `link` a11y shape of a conversation. The selector now reads only same-page DOM anchors whose `href` begins `/c/`, then performs the actual selection click with the fresh a11y ref. Duplicate a11y labels are bound to their exact row; ambiguous labels are skipped rather than guessed.
- Focused regression suite: 5 files / 34 tests passed. Production build passed. The empty failed archive directory was removed; private failure screenshot/receipt are retained for tester/debug evidence.
- The new source is committed and pushed, but intentionally not loaded into the running service: a further restart and a new bounded live canary need separate approval.
