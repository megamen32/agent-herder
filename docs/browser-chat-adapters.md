# Browser chat providers

## Production route through the extension

Use the Chrome extension and the existing [bezbrowser deployment tools](https://github.com/megamen32/bezbrowser/blob/main/docs/EXTENSIONS.md).
The extension connects over outbound WSS from a signed-in Chrome profile.
Mac Intel and Mac mini are valid browser hosts for an owner running on
server100. The browser must present the provider account already bound to
the Herder profile. Installing the extension uses Chrome's normal extension
permissions. Day-to-day recovery requires no manual DevTools connection or
approval to expose a remote debugging port.

1. Check the intended node with `browser_status` and `browser_profiles`.
   Reuse a connected profile when its identity matches. If it needs the
   extension, use the managed `browser_extensions` install workflow and verify
   the extension ID, version and live connection on that profile.
2. Pin the browser identity in the Herder profile. Use a tab leased to Herder
   for provider operations and verify the pinned account and exact native chat
   before reading or sending. A profile on another machine works through the
   same extension route.
3. The shared Rust scheduler retries in the same conversation. It checks
   HumanStop and the failed input before one continuation. After a lost
   acknowledgement it reads back the native input and the existing receipt.
   Browser adapters without a provider-switch capability stop after that retry.
4. Exercise HTTP 429, HumanStop and restart after a lost acknowledgement
   on the fake provider through the extension transport. Verify that the
   installed Herder reads one already registered ChatGPT conversation and that
   recovery is armed for that conversation. Enable Z.ai once its provider
   exposes a failure tied to the latest assistant message and user input.

Implementation status on this branch: the Rust scheduler and ChatGPT recovery
pass the fake-provider tests over direct CDP. The Rust owner still needs the
bezbrowser transport and an end-to-end extension test. Installed UserIO
profiles remain available during migration.

The Rust browser port in [port.rs](../crates/herder/src/adapters/browser/port.rs)
is where bezbrowser leases and page operations belong. The provider scripts
continue to verify the same account, chat and failed input. The trusted owner
binding in [scoped_profile.rs](../crates/herder/src/bin/herder_native_stdio/scoped_profile.rs)
and the candidate builder in
[process-leases-candidate.py](../deploy/fleet/process-leases-candidate.py)
must carry the same pinned browser identity. The
[browser smoke](../tests/native/browser_adapter_smoke.py) must exercise
the recovery scenarios through the extension before this route is released.

## Native Rust owner profiles for the direct-CDP stand

On an isolated stand, the native MCP server runs either browser adapter over
direct Chrome CDP.
Rust handles validation, session routing and durable receipts. Each adapter
executes JavaScript inside its bound page to operate the composer and read
the site's conversation API.
Use a protected owner profile with `kind` set to `chatgpt` or `zai`, omit
`ahap_script`, and point `executable` at the installed `herder_native_stdio`.
The standalone `herder-browser` executable implements the same AHAP 0.1
JSONL interface. Each owner uses its own explicit browser binding.

| Field in `owner.ahap_env` | Value |
| --- | --- |
| `AHAP_BROWSER_TRANSPORT` | `direct-cdp` |
| `AHAP_BROWSER_CDP_WS_URL` | Browser-level loopback URL, for example `ws://127.0.0.1:9222/devtools/browser/<browser-id>` |
| `AHAP_BROWSER_CDP_CONTEXT_ID` | Exact Chrome browser context |
| `AHAP_BROWSER_CDP_TARGET_ID` | Exact signed-in site tab in that context |
| `AHAP_BROWSER_ACCOUNT_SCOPE` | Lowercase SHA-256 of the provider's account ID |
| `AHAP_BROWSER_CDP_ORIGIN_PORT` | Optional port in the WebSocket Origin header sent to Chrome |

Chrome must accept the loopback origin used by the adapter. For a dedicated
Chrome with a dynamic debugging port, launch it with
`--remote-debugging-port=0 --remote-allow-origins=http://127.0.0.1:9222`
and set `AHAP_BROWSER_CDP_ORIGIN_PORT=9222` in the owner profile. Use the
actual browser WebSocket URL for `AHAP_BROWSER_CDP_WS_URL`. This also works
when an SSH tunnel forwards the debugging socket to a different local port.
An HTTP 403 during the WebSocket handshake occurs before the adapter can
inspect the page or verify the provider account.

In a V1 installation, select the profile in the usual private launcher
selector. Set `owner.executable` to the exact `core` path from its pinned
manifest. To run the core directly, use `--trusted-owner-profile PATH`.
The native path supports session discovery, exact session lookup, recent
message history, draft creation, delivery, and stopping a response. Create
saves a local account-scoped draft. Its first send binds
the stable draft ID to the new conversation. A confirmed send carries the
provider's new user-message ID. Herder persists the delivery receipt and
handles request-key replay across restarts. Inspect `initialize.capabilities`
for the operations available through this adapter.

In MCP, `create` and `deliver` accept an optional `attachments` array.
Each entry carries `name`, `mime_type`, and standard padded `data_base64`.
The inline transfer supports up to 16 files and 2 MiB of original bytes in
total per input. Reuse the same request key to recover the original receipt.
Changing the attached content under that key produces an idempotency conflict.
Fleet mesh accepts attachments for a ChatGPT or Z.ai target that advertises
`browserInlineAttachments`. Through the GPTAdmin relay, the whole encoded
request must fit in 64 KiB, including the envelope and base64 data.
ChatGPT accepts an empty caption. The Z.ai web composer requires text with
an upload. Its native adapter advertises `browserFeatures.attachmentCaptionRequired`
and checks the prompt before uploading.

Read the chat with `session` action `messages`. Each image or file in a
message's `parts` has an `attachment_id`, name and MIME type. Use `session`
action `attachment` with the same `session_ref` and `attachment_id`, and
set `message_id` to the row's `id`. The result contains the original bytes
in `data_base64`, up to 2 MiB per download. Download requires read access
to the session. Plain Markdown links, including ChatGPT `sandbox:` links,
remain in the message text.

Use `stop` action `stop` with `session_ref` and `request_key` during
generation. Herder can use the delivery's request key to identify the
input. The browser verifies the open conversation and active input before
clicking its Stop control. The response reports the scoped hold and the
outcome of the native interruption separately.

The reproducible browser acceptance test starts a private Chrome context,
serves local fixtures for each origin, and exercises both the standalone and
owner MCP interfaces. See [browser_adapter_smoke.py](../tests/native/browser_adapter_smoke.py).

## TypeScript compatibility profiles

ChatGPT and Z.ai are **two separate Agent Herder adapters** with one shared
implementation: `BrowserChatAdapter`. The adapter registry, UI, harness
routing, lifecycle, capabilities and enabled setting belong to each provider,
not to an aggregate `browser-chat` adapter.

| Harness | Driver | Identity | Account archive |
| --- | --- | --- | --- |
| `chatgpt` | `builtin:chatgpt-userio` | stable native `/c/<uuid>` | UserIO extension channel |
| `zai` | `builtin:zai-userio` | stable native `/c/<uuid>` route | UserIO extension channel |

The maintained AHAP browser transport is the UserIO extension channel. It runs
inside the selected owner browser profile and does not expose cookies or site
credentials to Herder. A complete UserIO profile is required; missing fields
fail clearly and never trigger Vibe or direct CDP fallback.

Vibe and direct CDP remain explicit experimental/unmaintained compatibility
transports only. They are not selected implicitly and are not part of the
maintained browser adapter contract.

Configure `AGENT_HERDER_BROWSER_CHAT_PROVIDERS` with a JSON array:

```json
[
  {"id":"chatgpt","name":"ChatGPT","cwd":"/home/roomhacker/.browser-chat/chatgpt","module":"builtin:chatgpt-userio"},
  {"id":"zai","name":"Z.ai","cwd":"/home/roomhacker/.browser-chat/zai","module":"builtin:zai-userio"}
]
```

The loader validates both entries and initializes each provider independently.
Use `/api/adapters` to inspect/disable them separately. This API also returns
`browserFeatures` for each site. The site features are explicit: inherited
base capabilities are not treated as proof of native provider support.

## Sessions and sending

UserIO broker results must carry matching `agent_id`, `agent_instance_id`, and
command action. Missing native instance identity is a failed receipt, even when
the backend response says `ok`. `gpt_read` returns `chat_ref`,
`snapshot_epoch`, `revision`, `account_scope`, `coverage`, `complete`,
`limitations`, and when available the complete native `messages` array. Each
message retains native id, role, text, status, `end_turn`, `create_time`, and
`update_time`. Full messages are consumed before the latest pair; pair fallback
is reported as incomplete.

Each provider exposes its own harness and scoped session IDs:

- `harness="chatgpt"`, `sessionId="chatgpt::<encoded-native-id>"`
- `harness="zai"`, `sessionId="zai::<encoded-native-id>"`

These prefixes keep persisted IDs recognizable and prevent a session from
being routed to the wrong authenticated site. The legacy `browser-chat`
harness remains in some historical schemas but is **not registered**.
No fallback to the last active browser or a different provider is allowed.

A `zai::route%3A<uuid>` target is an exact native route identity: it resolves,
resumes and delivers even when the chat is not currently rendered in the
bounded sidebar. chat.z.ai serves `/c/<uuid>` only through its client router
(a full page load of the route redirects back to home), so the driver drives
the app's own history while the owned tab is idle and re-confirms the exact
route before any composer action; a wrong route fails identity confirmation
and nothing is sent.

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

## Creating a new ChatGPT or Z.ai conversation (feature branch)

Both sites show a blank new-chat composer at their root `/`, but do
**not** assign a persistent native conversation ID until the user sends
their first message. The browser adapter therefore supports explicit
`createSession(harness="chatgpt"|"zai")` in two safe stages:

1. The Create button saves an empty **local draft** with a stable
   `chatgpt::draft%3A<uuid>` or `zai::draft%3A<uuid>` session ID.
   It appears immediately in the Agent Herder list and survives a service
   restart. No external request, model generation or synthetic message is
   sent during this stage.
2. Only after the user types a real first message, the site driver opens
   an **independent background tab** in the existing authenticated Mac mini
   Chrome and submits once from the site's own blank composer. It confirms
   the exact site origin, blank route, editor content, idle Stop state and
   one enabled Send button. After the site's own `/c/<uuid>` route appears,
   the draft is durably linked to that ID. It retains the same Herder session
   ID, avoiding chat-list duplicates and broken client links.

The two drivers share the local draft store and background-tab admission
helper but keep their own composer and Send selectors. Drafts are stored
in mode-0600 JSON files inside mode-0700 directories, split by provider
and SHA-256 account scope. Neither tokens, cookies nor prompt text are
stored in draft metadata. Each account has at most 100 drafts.

An aborted pre-click operation returns the draft to pending. Once a click
may have occurred, a missing response or missing native route is marked
**uncertain**, including across restarts. The operation is never
automatically replayed, so a timeout cannot silently create duplicate chats.
New chat tabs stay open after the first successful submission; existing
personal chat tabs are never navigated during initial creation.

The Create dialog suppresses the irrelevant folder and initial-model
selectors for browser chats and explains the draft semantics. Site-specific
model switching remains available on an actual native conversation afterward.

Safety/acceptance: tests exercise both providers with simulated page tools.
No personal first message was sent during implementation, and this feature
is not deployed by creating the source branch.

## Creating new browser chats (feat/browser-chat-create-20261103)

ChatGPT and Z.ai allocate a persistent native conversation route only
after the first user message. createSession therefore persists a private
account-scoped LOCAL EMPTY DRAFT and returns a selectable draft ID. No
automatic prompt is submitted, and this does not consume model quota.

The first user message opens a new background tab on the same site,
verifies its authenticated account against the owner of the local draft,
fills only that user message and clicks the unique Send button after a
target/draft/Stop safety preflight. The native conversation route is
verified before it is bound to the local draft, preserving one stable
Herder session ID across the transition.

Pre-click failures can return to pending. An uncertain post-click outcome
is durably marked uncertain and never retried automatically. Drafts are
stored per site and per verified account (mode 0600), capped at 100.
A changed account cannot read or send another account's drafts.

The UI shows ChatGPT and Z.ai as separate create-session choices with no
filesystem folder or model defaults for local browser drafts. It explains
that the empty chat appears on the site after its first real message.

Authorized acceptance used two newly created, clearly labelled test chats only. Existing conversations were not sent messages or stopped.

### Live acceptance, 2026-11-03

The creation path now verifies ChatGPT account identity using the explicit
session-auth endpoint only. It does not depend on or re-enable background
conversation polling; the account digest alone crosses CDP.

ChatGPT: one new local draft, one user test prompt, a native conversation
route, and one assistant reply containing the test marker were verified.
The first API history read returned HTTP 429; it did not trigger another
message submission. A later read of the exact new tab confirmed the one
user message and one assistant reply.

Z.ai: local draft and new-page first Send were exercised. The site rejected
generation with its native concurrent-conversation-limit error, and the
history endpoint returned HTTP 403. This is not successful generation.
The first-message admission helper now inspects that native error surface
before accepting a new route; it fails closed and never resends on an
unknown or rejected outcome. No existing user's generation was stopped to
free a slot, and no account limit was bypassed.

After binding, the local draft's stable ID resolves to its native ID for
Stop/model controls; merged session metadata preserves the native working
state rather than flattening every admitted chat to idle.
