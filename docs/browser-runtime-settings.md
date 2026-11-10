# Browser runtime settings

Browser transports use opaque public aliases and a private owner profile. The
repository contains validation and setting names only; it does not contain the
MCP target, SSH destination, remote user paths, browser session IDs, account
scopes, or access tokens.

The owner profile or protected service environment supplies these values at
launch time:

- `AGENT_HERDER_MAC_MINI_SSH_TARGET`
- `AGENT_HERDER_MAC_MINI_CHROME_GATEWAY_SCRIPT`
- `AGENT_HERDER_MAC_MINI_CHROME_GATEWAY_URL` (optional loopback URL)
- `AGENT_HERDER_VIBE_MAC_SSH_TARGET`
- `AGENT_HERDER_VIBE_MAC_NODE_PATH`
- `AGENT_HERDER_VIBE_MAC_CLI_PATH`
- `AGENT_HERDER_VIBE_SERVER_CLI_PATH`

The Vibe and direct-CDP keys above are retained for explicit experimental
compatibility runs and are not the maintained ChatGPT or Z.ai route.

The protected profile is owner-only and must be stored with directory mode
`0700` and file mode `0600`. The Rust trusted owner launcher allowlists these
keys and validates the alias, SSH destination, absolute paths, and loopback
gateway before starting an AHAP child. A missing or conflicting descriptor
fails closed.

For maintained ChatGPT and Z.ai adapters, an omitted `AHAP_BROWSER_TRANSPORT`
selects `userio` only when the complete UserIO profile is present. Required
fields are `AHAP_USERIO_ENDPOINT`, `AHAP_USERIO_AGENT_ID`,
`AHAP_USERIO_INSTANCE_ID`, `AHAP_USERIO_ACCESS_TOKEN_FILE` or the Rust
compatible `AHAP_USERIO_TOKEN_FILE` alias, and account scope. Optional
`AHAP_USERIO_CONNECTION_ID` and `AHAP_USERIO_PRINCIPAL_ID` pin broker receipts
to one named UserIO connection and authenticated principal. A partial profile
fails clearly; there is no implicit Vibe, Mac CDP or direct CDP fallback.

The account scope is SHA-256 over provider, UserIO user ID and workspace
account ID. Existing user-only scopes require a Lead-controlled pinned-profile
migration.

Use `mac-mini` or `server-100` in public configuration. The private profile
resolves that alias to the actual child command and, for `mac-mini`, the SSH
destination. Tokens remain in the existing owner-only token file boundary and
are never placed in this settings map.

Vibe and direct CDP settings remain explicit experimental/unmaintained
compatibility settings for controlled legacy use.
