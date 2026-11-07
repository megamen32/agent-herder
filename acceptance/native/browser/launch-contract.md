# ChatGPT AHAP transport launch contract

The runner requires an explicit transport selection. There is no automatic fallback.

## Existing Mac Mini Chrome gateway

Set:

- `AHAP_CHATGPT_TRANSPORT=mac-mini`
- `AHAP_CHATGPT_PAGE_ID=<exact verified Chrome MCP page ID>`
- `AHAP_CHATGPT_ACCOUNT_SCOPE=<expected 64-character lowercase SHA-256 account scope>`
- `AHAP_HARNESS=chatgpt`
- `AHAP_VERSION=0.1`

The runner uses the existing `MacMiniChromeTransport`, which calls the established Mac Mini Chrome MCP gateway. This mode does not require the raw `9222/json/version` endpoint or direct-CDP context/target variables. The page ID and account scope remain mandatory and are checked before and after cached reads.

## Explicit direct-CDP mode

Set `AHAP_CHATGPT_TRANSPORT=direct-cdp` plus `AHAP_CHATGPT_CDP_WS_URL`, `AHAP_CHATGPT_CDP_CONTEXT_ID`, `AHAP_CHATGPT_CDP_TARGET_ID`, `AHAP_CHATGPT_PAGE_ID`, and `AHAP_CHATGPT_ACCOUNT_SCOPE`.

Unknown/missing transport modes, missing page/account identity, and missing direct-CDP fields fail closed. The runner never switches between transports by probing availability.

This is a source launch contract only. Native target preparation and the separate exact scope/lease belong to the CI acceptance step; this document does not select a browser tab or authorize a native message.
