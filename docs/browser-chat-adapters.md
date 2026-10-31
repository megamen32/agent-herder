# Browser chat providers

ChatGPT and Z.ai are **two separate Agent Herder adapters** with one shared
implementation: `BrowserChatAdapter`. The adapter registry, UI, harness
routing, lifecycle, capabilities and enabled setting belong to each provider,
not to an aggregate `browser-chat` adapter.

| Harness | Driver | Identity | Account archive |
| --- | --- | --- | --- |
| `chatgpt` | `builtin:chatgpt-mac-cdp` | stable native `/c/<uuid>` | separate `cdp_*` tools |
| `zai` | `builtin:zai-cdp` | currently sidebar title (or verified route) | unavailable |

Both drivers reuse the **existing authenticated Mac mini Chrome CDP gateway**.
Neither opens another browser, profile or login session. A missing/unavailable
site does not disable the other or any coding agent.

Configure `AGENT_HERDER_BROWSER_CHAT_PROVIDERS` with a JSON array:

```json
[
  {"id":"chatgpt","name":"ChatGPT","cwd":"/home/roomhacker/.browser-chat/chatgpt","module":"builtin:chatgpt-mac-cdp"},
  {"id":"zai","name":"Z.ai","cwd":"/home/roomhacker/.browser-chat/zai","module":"builtin:zai-cdp"}
]
```

The loader validates both entries and initializes each provider independently.
Use `/api/adapters` to inspect/disable them separately. This API also returns
`browserFeatures` for each site. The site features are explicit: inherited
base capabilities are not treated as proof of native provider support.

## Sessions and sending

Each provider exposes its own harness and scoped session IDs:

- `harness="chatgpt"`, `sessionId="chatgpt::<encoded-native-id>"`
- `harness="zai"`, `sessionId="zai::<encoded-native-id>"`

These prefixes keep persisted IDs recognizable and prevent a session from
being routed to the wrong authenticated site. The legacy `browser-chat`
harness remains in some historical schemas but is **not registered**.
No fallback to the last active browser or a different provider is allowed.

Both browser drivers check generation/activity in the live page and confirm
the exact intended conversation and composer before Send. A visible Stop
control means an active response; a visible Send control on an empty composer
may be disabled without indicating generation. Z.ai has a known square Stop
control; the ChatGPT driver uses its own controls. On unknown state, an
existing personal draft, changed target or ambiguous Send button, admission
is refused. An uncertain click outcome is **never automatically retried**.

Use `mode="queue"` for deferred messages. `steer` is not native to either
provider and must not silently substitute Stop/Continue. Neither driver is
considered live-send-accepted without a dedicated test-account conversation.

## Compatibility

The separate old ChatGPT `ChatGptAdapter` is removed. The archive and official
account export `cdp_*` tools remain independent and are **not** registered as
another chat adapter. Previously stored `browser-chat` records are not deleted
and existing stored queued deliveries are not replayed during migration.

The frontend shows `ChatGPT` and `Z.ai` as distinct harnesses and adapter
cards. Browser-only adapters without native chat creation do not appear in
the new-session dialog.
