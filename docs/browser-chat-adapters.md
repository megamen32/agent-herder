# Browser chat providers

ChatGPT and Z.ai are **two separate Agent Herder adapters** with one shared
implementation: `BrowserChatAdapter`. The adapter registry, UI, harness
routing, lifecycle, capabilities and enabled setting belong to each provider,
not to an aggregate `browser-chat` adapter.

| Harness | Driver | Identity | Account archive |
| --- | --- | --- | --- |
| `chatgpt` | `builtin:chatgpt-mac-cdp` | stable native `/c/<uuid>` | separate `cdp_*` tools |
| `zai` | `builtin:zai-cdp` | sidebar title or exact `/c/<uuid>` route | unavailable |

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

A `zai::route%3A<uuid>` target is an exact native route identity: it resolves,
resumes and delivers even when the chat is not currently rendered in the
bounded sidebar. The driver navigates the owned tab to the exact `/c/<uuid>`
route only while that tab is idle and re-confirms the route before any
composer action; a wrong route fails identity confirmation and nothing is sent.

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

## Stop generation and model selection (ChatGPT and Z.ai)

Both provider instances expose `cancelTurn: true` and `modelSwitch: true`
via their shared `BrowserChatAdapter`, backed by **site-specific** native
controls. A successful Stop means the exact selected chat's visible Stop
button was clicked; the conversation is not deleted. Stop never navigates
to another chat, presses Enter, sends a prompt, or retries an uncertain click.

`list_models(harness="chatgpt"|"zai")` reads models directly from the
authenticated site's picker. The supported names depend on the account and
page: example observed values were `GPT-6`, `GPT-5.6 Sol` for ChatGPT,
and `GLM-5.3-Flash`, `GLM-5.3`, `GLM-5.2` for Z.ai. These are observed
examples, not hard-coded allowed lists. Reasoning effort sliders are a
separate feature; they are **not** claimed as model names.

`change_model` targets one exact provider-scoped conversation. Both drivers
require an idle composer without a personal draft, reject unknown/unlisted
models, click only one exact option and require a readback from the site.
If a click may have occurred but its outcome is unclear, the failure is
not replayed automatically. The unified adapter contains no site selectors,
cookies or model names; each site retains its own browser ownership.

A real Stop requires a dedicated test account with an actively generating
chat. Live personal conversation sends/stops were deliberately not used
in acceptance; read-only model discovery was verified against both sites.

## Fast history and durable 100-chat cache

Both browser site drivers read conversation history through the already
authenticated, same-origin site APIs. They **do not** navigate away from the
current Chrome tab to fetch histories. ChatGPT obtains its account-scoped
bearer from `/api/auth/session` **inside the browser only**, uses it for
the ChatGPT conversation API, and returns normalized text messages only.
Z.ai uses `/api/v1/chats/{id}` and `messages/batch`. Neither token nor
cookie value crosses the browser transport or gets logged or cached.

The driver list APIs return up to **100 latest native chat IDs** per account.
ChatGPT lists with `/backend-api/conversations` and Z.ai requests the first
two pages of `/api/v1/chats/`. The previous sidebar snapshots remain a
read-only discovery fallback if a private API is unavailable. Z.ai now
uses stable `route:<uuid>` IDs for listed chats; legacy
`sidebar:<title>` links can resolve their native IDs by unique title.

The server maintains per-account SHA-256 namespaced compressed files under
`~/.local/state/agent-herder/browser-chat-history/{chatgpt,zai}/<accountHash>/`.
Each message file is mode 0600, parent folders 0700, with an upper bound of
400 KB compressed or 500 KB JSON. Up to 100 most recent chats are retained
per site/account; the account hash is generated inside Chrome from the
account ID, not the access token. Older cache entries outside the current
window are pruned.

On startup the latest 100 histories are queued for **bounded sequential**
background warming, rather than blocking the chat list. A user opening
an uncached conversation gets a high-priority remote history read; afterward
reopening returns the local history immediately. Existing cache is served
before a background refresh, and an HTTP error cannot replace it with an
empty transcript. The frontend keeps its own previously loaded view and
polls the selected browser chat every 8 seconds for fresh replies; a subtle
message shows that it is updating.

History is deliberately a bounded recent text tail (up to 180 nonempty
user/assistant messages, ~210 KB of text) rather than an unrestricted
download of all media or reasoning traces. ChatGPT uses up to 60 recent
turns; Z.ai fetches up to 180 recent message IDs in batches. Media binaries
and authentication material are **not** cached.

For smoke testing with a few conversations, set
`AGENT_HERDER_BROWSER_CHAT_PREWARM_LIMIT=1`; production defaults to 100.
If the site's private API changes, the last verified cache remains
readable and the UI reports the unavailable refresh rather than inventing
a transcript.

### Cold-cache behavior

Opening a never-cached chat is deliberately **nonblocking**: the details
endpoint responds with a loading history immediately and starts a
deduplicated background fetch. A selection of another chat never waits
behind its predecessor. When the fetch completes, the web UI's 8-second
refresh makes its messages visible without discarding any previously
shown content. A failed request is throttled for 30 seconds so an
unreachable private API cannot keep hammering Chrome or the site.
