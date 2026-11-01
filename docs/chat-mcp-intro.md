# MCP intro for chats the herder creates

When the herder creates or first adopts a session in a configured chat
harness, it delivers one short MCP connection config into that chat, so the
remote assistant can work on the machines directly through the owner
gateway: the shell nodes and the nested AgentHerder live on the gateway, not
inside the herder process. One herder MCP alone is not enough for that.

The credential is one shared owner-managed key (a gateway profile token),
not a per-chat token. It is set once, edited centrally in the gateway
profile, and one revocation on the gateway side disables every chat at
once. The settings store keeps the key write-only: no API ever returns its
value, only the fact that it is set.

## Settings (herder.env)

| Key | Secret | Default | Meaning |
| --- | --- | --- | --- |
| `AGENT_HERDER_CHAT_INTRO_URL` | no | `""` | Gateway MCP URL. Empty disables the intro. |
| `AGENT_HERDER_CHAT_INTRO_TOKEN` | yes | `""` | Shared gateway key. |
| `AGENT_HERDER_CHAT_INTRO_HARNESSES` | no | `zai` | Comma-separated harness list. ChatGPT is covered by its own bridge plugin. |
| `AGENT_HERDER_CHAT_INTRO_TEMPLATE` | no | `""` | Custom text with `{url}`, `{token}`, `{harness}`, `{sessionId}` placeholders. |

The feature is off until both URL and token are set. Changes apply after a
restart, exactly as the settings form states.

The key is write-only: the environment of the running process carries its
fingerprint marker only, and the delivery resolves the real value from the
secret store of the product at send time. A raw value written straight into
the environment (deployment-owned) is used as is.

## Trigger and delivery doctrine

- The intro fires only on the herder's own `created` events
  (`create_session`, `new_or_resume` first adoption of a target), never on
  a chat merely discovered in a sidebar.
- The send is a normal supervisor message with the stable input identity
  `mcp-intro-<harness>-<sessionId>`: restarts and repeated triggers cannot
  duplicate it, and crash-safe delivery reconciliation applies.
- Delivery is fire-and-forget: a refused or failed intro never fails the
  session creation that caused it. Refusals are logged with the
  `[chat-mcp-intro]` tag.
- The origin follows the creation request: a human-requested creation sends
  as human intent; an automatic creation sends as automation and passes the
  normal automatic admission checks, so a generated intro can never release
  a manual stop.
- A delivered intro is a chat message: the site provider sees the key, same
  as with any manual paste of an MCP config. This is the accepted trade-off
  of one shared revocable key.
