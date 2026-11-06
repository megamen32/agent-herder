# V002: rmcp 3.9.0 local wire probe

Run from the worktree root:

```sh
cargo build --locked --manifest-path crates/herder/Cargo.toml --bin v002_probe
python3 crates/herder/probes/v002_wire_probe.py
```

`v002-wire-transcript.jsonl` is one complete run over stdio, MCP 2026-07-28, using the pinned Cargo.lock and `rmcp` features `server, transport-io` (default features off). The server is a probe with static skill text and in-memory tasks, not the Herder implementation. It starts no adapter and causes no native effects.

The transcript proves discovery, client-without-tasks rejection before probe task creation (counter stays zero), task creation, input_required/get, update with an input response, completed/get with inline result, a second task's cancel and cancelled/get, skills/list/get, resources/read with verified SHA-256, and listen acknowledgement, filtered tool notification and graceful completion. `tasks/list`, `tasks/result` and `resources/directory/read` return -32601 in this configuration. Directory read is not advertised. The transcript is a local fixture, not an installed or named-client acceptance receipt.

## Boundaries and gaps

* The rmcp server dispatcher checks the client Tasks capability on a returned Task **after** `call_tool` has run. This does not prevent an effect or task creation inside the handler. The probe explicitly checks server and per-request client capability before `spawn`; production handlers must do the same before any effect. The negative wire test observes client capability rejection and an unchanged creation counter; it does not toggle the server capability.
* `TaskManager` stores entries in an in-process `HashMap`; it does not provide restart persistence, durable ownership, authorization or native process recovery. Its cancellation is cooperative; a cancel acknowledgement alone does not prove an external operation stopped.
* Skills require handlers and resources capability; SDK support is not evidence that a model loaded or used the skill. `directoryRead` exists as an optional SDK capability, but is intentionally not enabled or implemented here.
* The listen probe exercises one accepted notification and graceful server completion. It does not prove disconnect recovery, request cancellation, HTTP/SSE transport, replay, authorization, or domain snapshots. The SDK's existence of a stream does not supply Herder event sources or persistence.
* No actual Codex/OpenCode/ZCode/ChatGPT/Z.ai client, gateway, authentication or deployed service was tested. The complete SPEC acceptance and the dependent production implementation remain unproven.
