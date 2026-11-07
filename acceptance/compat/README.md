# Compatibility wire probe

`cargo test --manifest-path crates/herder-compat/Cargo.toml --test handshakes`
checks the pinned RMCP server/client handshake in both directions: the native
upstream negotiates `2026-07-28`, and the legacy-facing endpoint negotiates
`2025-06-18`. It uses an in-memory SDK server solely as a protocol probe. It is
not evidence that Codex, the installed translator, the real Herder handlers,
caller authentication, or durable Tasks work.

The executable endpoint uses `HERDER_NATIVE_COMMAND` to launch one native MCP
process per downstream stdio connection. It exits before serving the legacy
client unless the upstream negotiated the pinned native version. It only
advertises `compat_task`, `compat_skill`, and `compat_changes` when the
corresponding upstream Tasks, Skills, and Resources capabilities exist.

## Caller boundary

`clientInfo`, tool arguments, task refs, resource refs, and claimed sender IDs
from the legacy peer are never identity evidence. The stdio process must be
bound to exactly one caller by the trusted launcher/authentication boundary;
sharing one upstream identity across downstream callers is forbidden. This
crate does not yet have a verified-caller transport hook. The current native
stdio endpoint therefore remains `Caller::Unknown` and rejects operations as
unsupported with `effect=none`. T003 stays open until the native core provides
an authenticated per-connection binding and ACL checks. The wire probe records
protocol behavior only and does not satisfy that identity acceptance.
