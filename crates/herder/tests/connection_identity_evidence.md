# Native stdio connection identity: evidence and missing contract

Baseline: origin/main `67aebe8b0fe85208c72d87872211cd00596bb1e5`.
`src/bin/herder_native_stdio.rs` starts `Caller::Unknown` with an empty grant
set. `auth/identity.rs` requires a verified principal and independently verified
self binding; a session ref supplied by the request is only a claim. The native
transport currently has no trusted source for either principal or binding.
The existing owner stdio ingress in `src/mesh/authenticated-ingress.ts` explicitly
sets `senderVerified: false`; owner-level transport authority is not per-session
identity. The compatibility design requires a distinct verified caller per
connection. The separate compatibility worktree is uncommitted work in progress:
its current launcher spawns a native process, but it explicitly documents that
it has no verified-caller hook. Its mere process isolation is not authentication.

`connection_identity_stdio.py` launches two actual configured native stdio
processes with different forged environment and client metadata, attempts both
own and foreign session reads and writes, changes the claim on an established
connection, and requires failure with `effect=none`. It proves fail-closed
behavior in this unbound state only; neither positive self authorization nor
isolation of authenticated connections is established by that result.

## Required integration contract

A trusted harness-side authority must associate each actual MCP connection with
the native session it owns, using evidence unavailable for selection or forgery
by the client/model. It must convey a connection-specific, authenticated binding
of principal and session to Herder over a protected channel with audience,
connection/lifetime binding and replay resistance; acquisition, verification,
expiry/revocation and ownership of that channel must be defined and tested.
A plain environment variable, JSON-RPC metadata, claimed session ref, shared
owner identity, process UID alone, or translator-supplied arbitrary identifier
is not such evidence. The exact mechanism and issuer must be chosen with the
harness owner: an inherited capability is only valid if issued by an authority
that already knows the session and is not available to an untrusted peer.

The translator must preserve a one-downstream-to-one-upstream connection binding
without inventing or upgrading identity; reconnect obtains fresh authority and
unknown or mismatched bindings fail before effects. Herder performs explicit,
exact resource/action grant checks against its authoritative policy and self
binding on each operation. Native Herder remains the sole Task lifecycle/store;
translator keeps no independent Task state. Acceptance must exercise the ordinary
launcher with two genuinely harness-issued bindings: own grant succeeds, foreign
session and spoofed binding fail without effects, and no connection can reuse the
other's authority, including reconnect/replay. Until then the launcher remains
unbound and fail-closed.
