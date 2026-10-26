# Public composer consumer — 2026-10-26

Public `https://agent.bezrabotnyi.com/` was opened in isolated browser session `hfr26m` / namespace `r26m`, through existing QA SSO. Public asset was `index-8PQvmYV9.js`, from the already verified 16f73e1 static pin.

The initial isolated browser expired into `about:blank` before credential fill; screenshot `/tmp/hfr26m-fill-error.png` was captured and inspected before reopening. A recording attempt without a virtual device showed “Микрофон не найден”; screenshot `/tmp/hfr26m-no-mic.png` was captured and inspected. No provider request or send occurred in that attempt.

For the real provider canary, a task-owned eSpeak WAV was decoded in an AudioContext and exposed as a virtual MediaStream by the browser's getUserMedia seam. The actual UI recording button started MediaRecorder; its stop button submitted exactly one observed `POST /api/composer/transcription`, HTTP 200. The actual provider text appeared in the composer draft. No send button was clicked, and no message or call was sent. Screenshot `/tmp/hfr26m-public-transcribed.png` was captured and inspected.

The synthetic English audio was transcribed poorly and repeated because the virtual source looped while recording. This proves public recording → real configured provider → draft insertion without autosend; it does not establish human microphone or transcription-quality acceptance. The task-owned draft is cleared before cleanup.

The same browser exposed a separate defect: local session sidebar entries lack hostId and display “Машина не подтверждена”, disabling pins even though the selected session's work target names Server 100. This is assigned to the delivery worker for source tracing and remains open until corrected and read back.
