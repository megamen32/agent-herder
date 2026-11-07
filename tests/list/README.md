# List application consumer check

From the repository root:

```sh
CARGO_TARGET_DIR="$PWD/crates/herder/target" cargo build --offline --manifest-path tests/list/Cargo.toml
cargo build --offline --manifest-path crates/herder/Cargo.toml --bin herder_native_stdio
python3 tests/list/check.py "$PWD/crates/herder/target/debug/herder-list-consumer-check" "$PWD/crates/herder/target/debug/herder_native_stdio"
```

The first process consumes `SessionListSnapshot` from the production Rust
application with synthetic cache and source observations. The second process
checks its JSON pages and exercises the public MCP `sessions/list` boundary.
The MCP currently returns `unsupported`; this check does not demonstrate a
live native list or an MCP consumer seeing the fixture data. The fixtures cover
equal project basenames and native IDs across node-scoped instances, an offline
source with cached data, an available empty source, a missing source, filtering,
and coverage on every page. They follow the existing Rust list fixtures and
legacy discovery tests' distinction between unavailable and empty results.
