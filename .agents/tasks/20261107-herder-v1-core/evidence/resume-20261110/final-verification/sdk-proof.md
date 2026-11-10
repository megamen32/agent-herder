# CODEXMCPSCHEMA11

Base 45fde4a766a1dc701f31a1e18a0e6d2090bab83e; scoped source commit 58253aef. Only herder-compat edge and its handshake tests changed. No deployment or push.

- sdk-red.log: installed @modelcontextprotocol/client 2.0.0 against original staged selector and launcher initializes, then rejects the 14 native tool input schemas as INVALID_RESULT.
- rust-red.log and rust-green-final.log: real candidate native endpoint through LegacyEdge; compare all 14 exact input schemas, preserving oneOf branches and every other field, with only root type added.
- compat-tests.log: all nonignored compat tests pass; the ignored real-native check was run explicitly and passed separately.
- build.log: release herder-compat built on independent worktree target. Candidate copy sha256 0870c199939a619cb227ab17647fba3836965b5fb1efadf0ba8c8681b9615c2f.
- selector.json and manifest.json: private task-local selector uses the candidate compat copy with verified digest and retains staged candidate core/profiles.
- sdk-green.log: unchanged SDK validator connects via launcher, lists 14 native tools plus capability-advertised compat_task, and performs the read-only discover nodes call successfully.

No production sends, calls, notifications, or installed launcher/config mutations.
