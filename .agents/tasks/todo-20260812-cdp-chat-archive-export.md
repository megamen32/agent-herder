# Task: export ChatGPT articles, deep-research reports, and Library files

Started at: 2026-08-12 11:57 MSK
Lifecycle provenance: new user-selected follow-up from the completed CDP Chat MCP adapter task; created before archive implementation.
Last task-file mtime observed: 2026-08-12 11:57 MSK
Harness: Codex desktop
PID: unknown (desktop harness)
Agent session: current Codex task thread (opaque ID not exposed to task shell)
PID status: active Lead task
Last PID signal: 2026-08-12 11:57 MSK, read-only BrowserClaw discovery completed.
Last task-file transition: todo created; source-path discovery complete, implementation not started.

## Original request

> Мне нужно все-все-все статьи и файлы скачать, и все глубокие исследования. И заодно добавь в MCP сервер. Сначала подумай минимальный путь, который нужно расширить, чтобы это получить.

## Business outcome / 80-20 DoD

One ChatGPT archive is requested and, when available, downloaded into a user-controlled local archive. The MCP exposes the two minimum operations needed to keep that outcome repeatable:

1. request the native ChatGPT data export for conversations/deep-research history;
2. download all selected Library files into one archive directory with a JSONL manifest.

The archive preserves original files and the native ZIP first. Publishing/conversion to Markdown or HTML is deliberately deferred until the real source formats are visible.

## Production-path evidence

- Real authenticated ChatGPT UI exposed `Библиотека` and `Настройки` in one BrowserClaw-owned page on Mac mini.
- BrowserClaw exposes `tabs`, `snapshot`, `act`, `download`, `evaluate`, and `screenshot`; `download` accepts a page and a fresh UI ref.
- Official ChatGPT documentation says native export provides chat history and related account data via an email/SMS ZIP; Library supports selection and download of saved files; completed Deep Research reports support Markdown, Word, and PDF downloads.

## Shortest business canary

One persistent BrowserClaw MCP process opens exactly one owned ChatGPT page, requests the native account export, and returns a redacted receipt. When the email/SMS ZIP is available, one `archive_import_zip` canary lists the actual archive content. A separate `archive_library_download` run downloads one selected Library item, verifies its manifest row and byte count, then batches the rest.

## Confirmed scope

- Extend the existing standalone/Agent Herder namespaced CDP chat capability, not Telegram or the browser-wake path.
- Add archive models, MCP tool registration, BrowserClaw persistent-page operations, local manifest/archive storage, focused tests, and operator documentation.
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

- Source path verified; persistent single-page adapter is the next narrow implementation seam.

## Evidence / result

- Pending implementation.
