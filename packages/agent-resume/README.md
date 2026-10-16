# Agent Resume core

The shared core of the Agent Herder monorepo. It owns:

- harness protocol knowledge (OpenCode, Codex, Claude): enumerate sessions, read
  messages, admit an input into a live turn, interrupt, wait, models;
- marker search for finding a session;
- durable receipts and idempotency for any delivery;
- detached long-running jobs and their status.

It does not own orchestration: the coordination board, autopilot policy and
judge, fleet/mesh, the web UI and the MCP surfaces stay in Agent Herder.

Agent Herder depends on this package and pins `coreContractHash()`; changing a
capability or an entrypoint here fails the Herder test suite until Herder is
rebuilt and re-pins it.

The same source is published as a standalone installable tool at the monorepo
version:

```bash
npx agent-resume-mcp contract   # machine-readable contract of this build
```

Nothing in this package is maintained outside the Agent Herder repository.
