# BrowserWorker wake boundary

Agent Herder exposes the `browser_wake` MCP tool for one fixed target: the
Mac mini Chrome CDP target -> ChatGPT session `E-Frontier`. The tool accepts
the future Telegram-backed `secretary.inbox.v1` template and the safe
`secretary.browser-canary.v1` liveness template.

The Mac worker owns the literal operational prompt behind each template;
callers do not supply arbitrary prompt text through the wake API. The inbox
template is intentionally not activated until the Telegram MCP/Overpod
transport is selected and separately verified. The browser canary never calls
external tools and asks ChatGPT to return a fixed liveness token.

The request is deliberately opaque and bounded:

- `sourceRefs`: one to eight printable refs such as `inbox://telegram/chat:42`;
- `runId` and `idempotencyId`;
- a deadline in milliseconds.

The request does not carry a prompt body, Telegram text, cookies, page handles,
or a ChatGPT transcript. The Mac worker owns the already-authenticated browser
profile and must return a `completed` receipt with an opaque `receiptRef`; an
`accepted` queue acknowledgement is not enough to mark the inbox wake
delivered. The worker endpoint is configured with
`AGENT_HERDER_BROWSER_WORKER_URL`; set `AGENT_HERDER_BROWSER_WORKER_TOKEN` when
the endpoint is not local. Agent Herder's HTTP MCP listener uses
`AGENT_HERDER_HTTP_TOKEN` for the corresponding bearer check. Agent Herder
stores its durable ledger at
`AGENT_HERDER_BROWSER_WAKE_LEDGER` (default:
`.agent-herder/browser-wake-ledger.json`).

The ledger rejects an idempotency-key reuse with a different request and can
reclaim a `claimed` record after its request deadline. It never makes the
browser or Telegram side effect by itself: deployment, the real Mac Chrome
CDP endpoint, and any outbound Telegram reply remain explicit gates.

The repository includes the browser worker package, a small HTTP worker that
speaks Streamable HTTP MCP to the Mac mini Chrome CDP endpoint. Its endpoint
defaults to `/browser-wake`; configure the worker MCP endpoint variable (the
code still uses a retired product name for it, unchanged), plus
`AGENT_HERDER_BROWSER_TARGET_URL`, `AGENT_HERDER_BROWSER_WORKER_HOST`,
`AGENT_HERDER_BROWSER_WORKER_PORT` (default `9012`, keeping the Mac mini
`9010`/`9011` ports free), and the worker token. The worker ledger is at
`AGENT_HERDER_BROWSER_WORKER_LEDGER` (default:
`.agent-herder/browser-worker-ledger.json`).

The live Mac mini CDP endpoint is the owner's personal Chrome reached through
the loopback gateway `http://127.0.0.1:50260/mcp`; GPTAdmin reaches it under
the shell target `mcp:shell:mac-mini-2012.lan:ChromeMacMiniCDP`, which runs
`http_stdio.py --url http://127.0.0.1:50260/mcp` on the Mac mini itself.

For tester/debug evidence, the same authenticated worker exposes
`GET /debug/screenshot`. It captures a PNG from the worker-owned Chrome page
without dispatching a prompt; keep the image local and temporary, inspect
it before any retry/reload/cleanup, and never publish it because the page may
contain ChatGPT transcript data. The endpoint uses the worker bearer token and
is an evidence seam, not a business API. `GET /debug/screenshot/stage` returns
the last best-effort screenshot taken after prompt typing/submission, also
without opening a tab.

Within one running worker process, the Chrome CDP MCP session and the selected
ChatGPT page id are retained in memory. Every later wake reuses that same
session/page and therefore does not call `tabs new` again. A worker process
restart loses the browser's page ownership; treat the first wake after a
restart as a controlled re-acquisition event and do not run multiple worker
instances against the same Chrome profile.

When `AGENT_HERDER_BROWSER_TARGET_URL` is configured, it is an allowlist for
the target identity, not a URL to navigate to directly. The worker opens one
ChatGPT root tab and selects the pinned `ИИ Фронтир — вечер` target from the
fresh sidebar snapshot; direct conversation navigation can leave the composer
unloaded in this Chrome profile. If old root tabs belong to another MCP
session, the worker skips them and acquires one owned root tab.

The safe canary asks ChatGPT to construct the response token from two prompt
fragments, but the configured GPT may follow its own secretary workflow
instead. The worker therefore proves completion from the real UI lifecycle: a
streaming/thinking marker must appear and then disappear while the composer is
restored. A fixed token is not required for the receipt, so a valid completed
GPT response is not misclassified merely because the GPT followed its own
instructions.

The Mac worker durably claims `idempotencyId` before touching the browser. A
replay with the same request returns the stored receipt and must not type a
second prompt; a replay of an orphaned claim fails closed rather than
repeating a possible ChatGPT side effect. This contract is covered by local
tests. Starting the worker or restarting a production Agent Herder process is
still an explicit operational gate.
