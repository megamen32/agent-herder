# UI worker evidence — preview and composer

Date: 2026-10-26 (Europe/Moscow)

## Source and installed runtime

- Source checkout: `main`, HEAD `578d89fe06ce`.
- `agent-herder.service` runs immutable release `4750249bb888074c965bcc56e4e9e28fad2dfdc9`.
- That release's `dist/long-messages.js` has `LONG_AUTOMATIC_MESSAGE_THRESHOLD`, `PREVIEW_LENGTH`, and both read limits set to `8_000`; its preview slices the JavaScript string at 8,000 characters. This is not a token count.
- The same release contains `dist/web-ui/composer-controls.js` posting to `/api/composer/transcription`, and `dist/web/server.js` routes that POST to `transcribeComposerAudio`.
- Earlier L20 notes naming release `8936` and frontend pin `76e83d0` are historical. Root reports the current public static pin as `0b5cb01a4473afa5b40020a3f04e6c43fa7f482f`. The public page was later confirmed rendered in the owned SSO session below; its artifact is still the previous release until Root supplies the new release SHA and pin receipt.

## Preview checks

- Existing source regression checks 7,999, 8,000, and 8,001 character inputs and exact chunk continuity. The delivery-through-MCP regression had become stale because it called `handleSendMessage` without the now-required durable delivery service. I repaired only its test fixture to use `UserMessageDelivery`, a durable local job registry, authenticated owner-ingress fixture, and fake Codex adapter. No real session or message was used.
- `npx vitest run --root . --config vitest.config.ts tests/long-messages.test.ts tests/composer-transcription.test.ts tests/web-ui-controls.test.ts` — **58/58 passed**.
- Source utility/MCP regression proves exact preview and full reconstruction. The installed artifact contains the same code. Public UI consumer acceptance remains open for the next release; the earlier blank capture was an early pre-mount snapshot, and the later owned SSO capture rendered normally.

## Composer and transcription checks

- Local installed UI at `http://127.0.0.1:18787/`, browser session `hfui26c` / namespace `ui26c`, showed the Herder chat composer, “Записать голосовой ввод”, and “Отправить сообщение”. Screenshot: `/tmp/hfui26c-ui-before.jpg`.
- Source implements microphone capture and one same-origin POST in `src/web-ui/composer-controls.tsx`; backend `src/web/composer-transcription.ts` hands audio to the protected Whisper consumer. `src/web/whisper-consumer.ts` uses the configured `whisper-1` endpoint through `sss-run`; no key is exposed to browser code.
- Three independent isolated browser sessions used local eSpeak speech as a virtual microphone. Each produced exactly one observed `POST /api/composer/transcription` with HTTP 200; the returned text appeared in the composer. In each case the send button remained enabled and was never clicked. Example network receipt from `/tmp/hfui26x` session: one `POST http://127.0.0.1:18787/api/composer/transcription (Fetch) 200`.
- The synthesized phrases were transcribed with substantial errors/repetition, so these canaries prove the real provider path and no-autosend insertion, not acceptable transcription quality. Screenshots: `/tmp/hfui26v-transcribed.jpg`, `/tmp/hfui26w-transcribed.jpg`, `/tmp/hfui26x-transcribed.jpg`.
- Physical human microphone was not exercised. The fake virtual device was isolated to these task-owned browser sessions. No phone or call path was used.

## Public UI bootstrap and SSO

- Used the existing `testlogin` QA account through `/home/roomhacker/simple-cookie-auth/scripts/sso-qa-fill.py` and vaulted stdin path, then clicked “Войти паролем” once. The browser reached `https://agent.bezrabotnyi.com/`, title “Agent Herder”.
- The first successful login transition was captured too early: screenshot `/tmp/sso26-postlogin.jpg` showed a blank page, `#root` had zero children and no API calls yet. I did not treat that first paint as a browser error or keep retrying it.
- A fresh, isolated authorized SSO session mounted normally. Screenshot `/tmp/sso26d-rendered.jpg` shows the actual public Herder chat. Accessibility snapshot `/tmp/sso26d-ui.txt` contains composer textbox, voice button, and disabled send button. Runtime evaluation showed `#root` children 1 and body text present. Browser page errors and console logs were empty; the HTML response had no Content-Security-Policy header and no init-script `error`, `unhandledrejection`, or CSP-violation record.
- The public HTML, `index-k5SoCsGs.js`, and `index-BfhEsgx0.css` returned HTTP 200. Their SHA256 values exactly match the installed release's `dist/web-static` files: HTML `750c11f3a70217900590d008475d2d46b90ffe951f9dffa1fb10463395c531bb`, JS `c79a70ad5163c6b7f2fa8abc04c7bb92e91db8538ed9b9c52aff8221c4a9c90c`, CSS `e8f1cbb21c6efbd1b142dd601a4804dbb2caa05f056dc2bde583e4deec284408`.
- No message, task, or call was sent. No deploy, build, service restart, nginx change, or shared commit was performed.
- Public bootstrap failure was not reproduced; L20 and L21 still await consumer acceptance against Root's next exact release SHA and public pin. Local runtime evidence alone is not substituted for that acceptance.

## Next installed-consumer acceptance checklist

- Wait for Root's exact release SHA and public static-pin receipt. Verify public UI asset hashes match that release before browser interaction.
- In isolated authorized public SSO, confirm the Herder session composer renders. Exercise a draft-only `MediaRecorder → configured Whisper provider → composer insertion` path; record the real provider response and confirm no send action/autosend occurred. Do not claim speech quality from a fake provider or synthetic response.
- Render an 8,000-character preview in the actual UI consumer and verify the full character count/content is visible without truncation or loss.
- Call the installed MCP search with `mode=exact`; verify text search runs with no embedding request and the response says coverage is limited to the local index, not fleet-complete.
- Use an isolated native-permission fixture with a pending request marked `canRespond=false`; verify allow/deny controls stay disabled and no production approval endpoint is called.
- Save sanitized screenshots/request receipts and outcomes under this evidence. On any browser error or ambiguous state, capture and inspect a screenshot in the same owned session before retrying or cleaning up.
