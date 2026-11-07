# Browser AHAP launch contract

The runner requires an explicit site and transport. It supports `chatgpt` and
`zai` through the existing `BrowserChatAdapter` and site drivers. It never
starts another browser, opens a replacement tab, or falls back to another page
or transport when the configured page is missing.

## Common configuration

- `AHAP_VERSION=0.1`
- `AHAP_HARNESS=chatgpt|zai`
- `AHAP_BROWSER_TRANSPORT=mac-mini` (the existing `MacMiniChromeTransport`)
- `AHAP_BROWSER_PAGE_ID=<exact Chrome MCP page ID>`
- `AHAP_BROWSER_ACCOUNT_SCOPE=<expected 64-character lowercase SHA-256 account scope>`

The runner filters `list_pages` to the exact page ID and provider origin before
the existing driver can inspect or use it. The selected provider driver checks
the pinned account before and after reads. Reported browser features come from
the selected `BrowserChatAdapter`; AHAP control capabilities remain limited to
the methods actually implemented by this runner.

`AHAP_BROWSER_TRANSPORT=direct-cdp` remains an explicit alternative. It also
requires `AHAP_BROWSER_CDP_WS_URL`, `AHAP_BROWSER_CDP_CONTEXT_ID`, and
`AHAP_BROWSER_CDP_TARGET_ID`. Transport availability is never probed to select
or switch modes. Legacy ChatGPT-prefixed transport/page/scope variables remain
accepted for existing ChatGPT launches.

## Z.ai account-proof limit

The current Z.ai account proof is derived by the existing list API script from
the first returned chat's `user_id`. An empty list, or a list response without
that user identity, does not prove the account scope. The runner fails closed
before returning data or performing a mutation in those cases. This contract
does not claim exact account proof for an empty Z.ai account; the native Z.ai
acceptance case remains separate.

This is a source launch contract only. Native target preparation and any
separate exact scope/lease belong to provider acceptance; this document does
not select a browser tab or authorize a native message.
