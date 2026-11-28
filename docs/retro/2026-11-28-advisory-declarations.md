# Advisory declaration availability

Base: `192da6d31bf71e95b03606fcf4cbf7749b2ec292`.

## Symptom and cause

`ProcessResourceApplication::snapshot` propagated errors from optional
`declarations.json` into `resource/get` and the whole `resource/list`.
`declare` called blocking `File::lock` on the request path, so another
advisory writer could stall the request indefinitely.

These declarations advertise worktree intent. They do not acquire ownership,
authorize execution or establish a release lease.

## Change

Resource snapshots preserve canonical ownership and occupancy when declarations
cannot be read. They return an empty declaration array with
`declarations_unavailable: true` and `declarations_error`.

Declaration writes use `try_lock`. Busy or unavailable advisory storage returns
`status: unavailable`, `advisory: true` and a reason. It does not claim that a
declaration was recorded. Invalid input, unauthorized callers and removal of
another principal's declaration remain errors. Canonical owner, execution
binding, storage marker and sealed release-authority checks remain enforced.
Malformed declaration metadata is preserved for diagnosis.

## Reproduction and verification

Run from the repository root:

```sh
cargo test --locked --offline --manifest-path crates/herder/Cargo.toml   --lib application::process_resources::tests:: -- --nocapture
```

Before the fix: the three new regression tests failed and the two existing
ownership/declaration tests passed. Corrupt JSON returned an MCP error for both
resource reads and declaration writes. The held-lock fixture timed out after
one second; it then released its lock and joined the worker, so the regression
test itself did not hang.

After the fix: all five tests passed, including the same three regressions.
The fixtures cover missing declarations, corrupt/nonregular metadata, failure
to open the lock file, a held lock, retry after lock release, unchanged
authoritative owner bytes, invalid input and exact-principal removal policy.

The local verification used an isolated detached worktree and Cargo target
directory. Deployment and live consumer acceptance belong to the combined
Herder recovery rollout.
