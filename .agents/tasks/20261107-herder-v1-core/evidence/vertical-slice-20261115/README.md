# Agent Herder Rust OpenCode vertical slice evidence

Recorded 2026-11-15 from source commit f5e30722; the Rust core binary was built from 7633fafa (the later commit changes only the fixture identity flags).

- local-mcp-consumer.json proves VS01–VS06 through the ordinary MCP stdio consumer and the deterministic loopback fake model.
- remote-server44-mcp-consumer.json proves the same consumer on the live server-44 host. Its envelope target is server-44 and its attribution sender is roomhacker-server-100.
- artifact-manifest.json pins the immutable core, AHAP runner, OpenCode v2.3.0 and Node v22 files.
- summary.json is the compact gate/readback index; the two .log files preserve raw consumer output.

Both receipts report: envelope delivery, same-key replay, changed-payload conflict, HumanStop before and after core restart, native readback, native export, search, project provenance, and resend_count=0. Common export remains an explicit V1 unsupported contract with effect=none (VS08).
