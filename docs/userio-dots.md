# Agent Herder Dots through UserIO MV3

Agent Herder uses the existing Universal UserIO Chrome MV3 extension for
ChatGPT Dots. Herder does not install a second extension and does not execute
arbitrary JavaScript in the browser.

When all of these protected settings are present, the MCP server registers
the dot_snapshot and dot_send tools:

- AGENT_HERDER_DOT_USERIO_ENDPOINT
- AGENT_HERDER_DOT_AGENT_ID
- AGENT_HERDER_DOT_INSTANCE_ID
- AGENT_HERDER_DOT_ACCOUNT_SCOPE
- AGENT_HERDER_DOT_CONNECTION_ID
- AGENT_HERDER_DOT_ACCESS_TOKEN_FILE
- AGENT_HERDER_DOT_PRINCIPAL_ID
- AGENT_HERDER_DOT_URL
- AGENT_HERDER_DOT_ROOM

The access token is read only from the protected token file. The configured
URL and room are fixed for the binding; callers cannot select another Dot
room. Every operation first asks the UserIO extension to prove that its exact
profile owns the room.

dot_snapshot reads the visible native messages after an optional cursor.
dot_send performs one UserIO dot_action(send) and then performs bounded
read-only confirmation. A missing result, timeout, ambiguous readback or
transport failure is returned as status unknown; Herder never retries the
send automatically.

The browser implementation remains owned by UserIO:
extensions/vk-inbox/lib/dot.js, lib/dot-media-read.js and the existing
dot_* command handlers. Herder owns only the typed command client and MCP
projection.
