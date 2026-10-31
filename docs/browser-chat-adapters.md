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
