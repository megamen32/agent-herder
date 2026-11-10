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

The protected profile is owner-only and must be stored with directory mode
`0700` and file mode `0600`. The Rust trusted owner launcher allowlists these
keys and validates the alias, SSH destination, absolute paths, and loopback
gateway before starting an AHAP child. A missing or conflicting descriptor
fails closed.

Use `mac-mini` or `server-100` in public configuration. The private profile
resolves that alias to the actual child command and, for `mac-mini`, the SSH
destination. Tokens remain in the existing owner-only token file boundary and
are never placed in this settings map.
