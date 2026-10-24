# ChatGPT harness

The `chatgpt` harness turns ChatGPT chats into Agent Herder sessions. A
session is one chat in the one ChatGPT page the driver owns: the sidebar is
the session list, a message is a chat message, and the model picker of the
page is the model switch.

The harness is available when a ChatGPT driver is configured. Agent Herder
loads it through the same module seam the CDP chat capability uses:

```bash
export CDP_CHAT_DRIVER_MODULE=/absolute/path/to/chatgpt-cdp-mcp/dist/herder-driver.js
```

The module must export `createCdpChatDriver()`. The
[chatgpt-cdp-mcp](https://github.com/megamen32/chatgpt-cdp-mcp) project ships
one that talks to the user's own Chrome over the browser DevTools WebSocket:
no BrowserClaw, no launchd unit, no OS automation. The bundled BrowserClaw
driver exposes the same harness seam.

## Sessions

| Action | Result |
| --- | --- |
| `list_agents({ harness: "chatgpt" })` | Every visible chat of the owned page, with its title, working state and recency. |
| `create_session({ harness: "chatgpt", name, cwd })` | Creates one disposable chat and returns it as a session. |
| `new_or_resume({ harness: "chatgpt", name, cwd, message })` | Reuses the chat with that title, or creates one, then delivers the message. |
| `send_message({ harness: "chatgpt", sessionId, message })` | Sends one message into that chat. `queue: true` returns without waiting for the answer. |
| `list_models({ harness: "chatgpt" })` | The models the page's own model picker currently offers. |
| `change_model({ harness: "chatgpt", sessionId, model })` | Selects one of those models through the page's own picker. |

A ChatGPT chat is identified by its chat id. `create_session` and
`new_or_resume` use the chat title as the session name, so a chat and a
session with the same name are the same thing.

## Scheduled messages

`cadence_schedule` works for a ChatGPT chat exactly as it does for a Codex
thread, and it keeps the same durable semantics: 15-minute wakes in the first
hour, 30-minute wakes in the second, then the `:45` Europe/Moscow anchor
hourly.

```bash
cadence_schedule({ sessionId: "<chat id>", requestId: "<stable id>", harness: "chatgpt" })
```

`harness` defaults to `codex`, so existing schedules are unchanged. The wake
is delivered through the ordinary automation path of the owning harness, and
HumanStop, the automation lever and the quota gates still apply.

## Boundaries

- The harness owns one page. `create_session` and `send_message` can navigate
  that page, and the page must be on the machine that runs the driver: a
  Herder process on another host cannot reach a local Chrome DevTools port.
- The chat is the session. There is no separate native thread, so the
  harness exposes no cancel, no detach, no fork and no subagents.
- `edit_message` and the task controls of the driver stay unavailable unless
  the concrete driver implements them.
- Model names come from the page. They change with the account and with the
  product, so `list_models` is the only trustworthy source.

## Engineering checks

```sh
npx tsc --noEmit --pretty false
npx vitest run tests/chatgpt-adapter.test.ts tests/cadence-scheduler.test.ts tests/cadence-tools.test.ts
```
