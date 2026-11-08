# Legacy MCP entrypoint

The existing standalone RMCP translator serves MCP 2025-06-18 and forwards
to native Herder 2026-07-28. It has no separate task store and does not change
native tool handlers or caller authorization.

Build and launch one process for one trusted caller:

```sh
cargo build --locked --manifest-path crates/herder-compat/Cargo.toml --bin herder-compat
HERDER_NATIVE_COMMAND=/absolute/release/fixture/herder_native_stdio   /absolute/herder-compat --trusted-owner-profile /protected/profile.json
```

The native launcher validates the owner profile. Arguments are passed as
literal argv, never shell text or values supplied by MCP clients. Do not
share one owner's profile among untrusted callers.

Native clients connect directly. Legacy clients discover the forwarded tools
and available compat_task/compat_skill/compat_changes helpers. A long-running
operation returns structuredContent.task_ref; read it with
compat_task(action=get, task_ref=...). Completion is not implied by acceptance.

## Evidence and limits

The original translator was already preserved in main. The November 8 fix
only forwards launcher argv, which previously prevented using the new trusted
owner profile. The regression fails against the original launcher and passes
with the fix. Exact native SDK handshake tests also pass.

acceptance/compat/opencode_consumer.py reuses the complete OpenCode business
stand, but its downstream wire uses legacy initialize, ordinary tools/call,
and compat_task reads only. On candidate805fd477final it proved two distinct
messages, both replies, full native export, search, registered projects, and
restart without another model request. Receipt:
.agents/tasks/20261107-herder-v1-core/evidence/finish-20261108/compat-result.json.

This proves a real legacy-wire consumer through the translator and native
harness. It does not prove Codex model tool selection or its approval UI.
The historical Codex approval refusal is retained and was not bypassed.
The translator is not yet included in the shared installed artifact.
