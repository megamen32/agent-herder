# Browser chat adapter contract

Browser-backed conversations are Herder sessions. The provider-neutral seam is
`src/adapters/browser-chat.ts`:

- `BrowserChatDriver`: list chats, send messages, optional create chat, list models and change model.
- `BrowserChatProvider`: provider ID, user-facing name, harness registration type and namespace CWD.
- `BrowserChatAdapter`: maps the driver into the existing `HarnessAdapter` protocol.

The ChatGPT adapter is a compatibility wrapper around this common adapter.
No login state, page lease, CDP session, browser profile, or browser-specific
selector is owned by the common adapter. A provider's driver must reuse its
authenticated browser session through a dedicated browser transport.

## Onboarding ZAI and DeepSeek

1. Implement a browser driver for each site using the same contract.
2. Register each provider as a distinct harness type and configure its own
   session namespace, capabilities, browser lease, and driver lifecycle.
3. Verify list, resume and send against a logged-in test account before
   exposing a provider to fleet automation.
4. Only then retire ChatGPT-specific MCP tool aliases, using a compatibility
   window to avoid breaking existing callers.

Do not silently fall back to creating a conversation when resuming an existing
chat. Do not enable features unsupported by the current driver.


## Multiple authenticated providers

`BrowserChatRouter` exposes one `BrowserChatDriver` for any number of
site-specific drivers, with stable `provider::encoded-native-id` routing.
Each provider owns its browser profile and page lease; the router has no
cookies, selectors, or login state. A failed list operation for one site
does not hide healthy sites; `providerStates()` exposes partial failures.
Unknown chat IDs and provider mismatches never fall back to another account.
The combined driver is intended for one `browser-chat` harness entry, with
the old `chatgpt` name retained as a compatibility alias until consumers move.

## Configure site drivers

Supply `AGENT_HERDER_BROWSER_CHAT_PROVIDERS` as a JSON array of
`{id,name,cwd,module}` records. The module must be a trusted **local absolute
path**, exporting `createBrowserChatDriver({id,cwd})`. The returned object
implements `BrowserChatDriver`. Example provider IDs: `zai`, `deepseek`.
The loader will only attach to the existing browser owner: it does not create
a Chrome profile, sign in, install plugins, or invent a page lease.

When configured, Herder exposes one `browser-chat` harness using the existing
`list_agents`, `send_message`, `resume_agent`, and `change_model` commands.
A site-specific driver must never expose or log auth cookies/tokens. A live
read-only list of chats is required before activation. If the browser is down,
Herder keeps the other harnesses alive and retries at 30-second intervals.

Legacy ChatGPT-specific `cdp_*` tools remain on by default for clients that
depend on account exports. Set `AGENT_HERDER_CHATGPT_LEGACY_TOOLS=false` only
after those callers migrate to a separate archive endpoint.

## ZAI on existing Mac mini Chrome CDP

The built-in provider module `builtin:zai-cdp` uses the established Chrome
DevTools owner at `127.0.0.1:50260/mcp` **on Mac mini**, reached from the
Herder host using its existing SSH access. It does not open another Chrome CDP
socket, launch a browser, require Vibe MCP, or take over the ChatGPT page.

Configure the Herder user service (not secrets) with:

```ini
[Service]
Environment='AGENT_HERDER_BROWSER_CHAT_PROVIDERS=[{"id":"zai","name":"ZAI","cwd":"/home/roomhacker/.browser-chat/zai","module":"builtin:zai-cdp"}]'
```

A single logged-in `https://chat.z.ai/` tab must be open in Mac mini Chrome.
If more than one is open, specify `AGENT_HERDER_ZAI_PAGE_ID` to pin the exact
page; no guessed fallback is allowed. The driver reads the rendered sidebar,
exposes only uniquely named chats (duplicates are withheld), and derives a
stable route ID for the selected conversation when available. Remaining sidebar
IDs are exact-title handles, not native conversation IDs; renames invalidate
them. The transport connects only to the pinned ZAI origin and doesn't read
browser cookies or chat text during inventory.

Sending is available via the normal `send_message` Herder tool. Before input
the driver verifies the exact selected title or native route and composer,
and never creates a missing chat. An uncertain submission is **not retried**.
The adapter currently does not claim model switching, chat creation, historical
native timestamps, or reliable completion waits. Live sends require a separate
test-account acceptance; inventory reads alone do not prove sending.
