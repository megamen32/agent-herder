# Fresh owner authority bootstrap

This CLI preserves the existing `ahap-owner-bootstrap` contract and provisions
one **new, isolated** owner authority with search schema v4. It does not install
Herder, launch a harness, send prompts, migrate a live database, or grant access
to existing sessions. Source was carried forward from the reviewed bootstrap;
the initializer and SQL migrations belong to the same checkout's Herder core.

Build from the repository root with the pinned Rust toolchain:

```sh
cargo build --locked --manifest-path deploy/fleet/owner-bootstrap/Cargo.toml --target-dir crates/herder/target
python3 deploy/fleet/owner-bootstrap/test_bootstrap.py crates/herder/target/debug/ahap-owner-bootstrap
sha256sum crates/herder/target/debug/ahap-owner-bootstrap
```

The test script creates private, disposable homes under the checkout's `.tmp/`.
It checks schema v4, initialized authority, empty search tables, file modes and
duplicate refusal with unchanged file bytes, inodes and modification times.
It also checks pre-existing authority, symlinks, unsafe permissions and invalid
paths. It does not use a runtime owner home.

For provisioning, the caller supplies an existing absolute canonical directory
named `herder-owner-home`, owned by the caller with mode `0700`. All ancestors
must be directories owned by the caller or root and not group/other writable.
Symlink components are rejected. In particular, `/tmp` is not a protected
ancestor. Run only against a newly prepared isolated home:

```text
ahap-owner-bootstrap /protected/path/herder-owner-home
```

Success prints one JSON object with the unchanged keys:

```json
{"database":"/protected/path/herder-owner-home/authority/state.db","gate":"/protected/path/herder-owner-home/authority/gate","generation":"ahap-owner-...","profile_seed":"/protected/path/herder-owner-home/authority/seed.json"}
```

The same JSON is saved as private `authority/seed.json`; it is a seed for the
integrator's owner profile, not a complete harness profile.

The CLI exclusively creates `authority/` before any database write and pins its
fresh gate. It uses `Writer::create_file`, the existing v1→v2 and v2→v3 SQL,
`Writer::initialize_fresh_stop_authority`, then
`Writer::migrate_search_v4(&pin)` before releasing the pin. The latter consumes
the v3 writer. No new initializer or migration API is introduced.

An existing `authority/` causes refusal before opening its files; a duplicate
invocation never overwrites state. Failures after initial directory creation
leave the partial authority for inspection and do not print a successful seed.
Do not retry or remove an existing authority automatically. This tool is for
fresh provisioning only, not recovery or adoption of existing state.
