# Проверенный CONFIG

Published main313d8c64cd73fc9881bb126af41eacfa6ab43144. 12focused tests pass. Terra proved actual unshare+bwrap readonly access/imports for10inputs; no native sends in mount proof.

Exact current config: `evidence/runner-config-controller.json`. Exact argv and verified artifact identities: `evidence/runner-config-argv.json`.

Dry-run command:

```sh
/usr/bin/python3 /home/roomhacker/.codex/worktrees/herder-ci-runner-config/agent-herder/tests/native/runner_config.py --config /home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-portable-native-ci/evidence/runner-config-controller.json --dry-run
```

The returned argv is the existing launcher+stand consumer command. Executing it starts native initial-send scenario; do not execute again for previously accepted receipts. This artifact is historical1d89d04d, NOT the forthcoming V1 candidate. Once product publishes V1, replace artifact_root/manifest/stand inputs, keep the same config validator/launcher. Stand ownership remains its existing Luna. Full V1 requires second deliver/search/projects/export/reopen proofs beyond this old fixture.

## Existing bootstrap source and recipe

Source `/tmp/ahap-owner-bootstrap-src/src/main.rs`, manifest `/tmp/ahap-owner-bootstrap-src/Cargo.toml`, lockfile beside it. Existing build command:

```sh
cargo build --release --locked --manifest-path /tmp/ahap-owner-bootstrap-src/Cargo.toml
```

Binary `target/release/ahap-owner-bootstrap` and published fixture both SHA256 `a3b66fe5f31b143737ff60f68babe7d27cca4ba9f6b3c088bb274f6be37fae3c`. Verified existing source uses herder dependency and SQL includes from `/home/roomhacker/.codex/worktrees/ahap-opencode-consumer/agent-herder/crates/herder`, migrations1→2→3, acquire_pinned and initialize_fresh_stop_authority. No v4 migration in this old bootstrap. Product core owner has exact next action: use candidate herder dependency and add existing `Writer.migrate_search_v4` under pinned gate. No new test API. Historical source path is temporary; preserve source in the candidate's existing fixture recipe before relying on it for repeatable CI.

CLI `[bootstrap, /herder-owner-home]`; fresh authority seed has exactly database/gate/generation/profile_seed. Stand owns protected profile creation.

## V1 public contract update

owner.kind=opencode|codex|zcode|chatgpt|zai; executable=Node, ahap_script=corresponding dist/ahap-*-runner.js; code_home/cwd/principal/node/instance plus allowlisted ahap_env. Codex AHAP_CODEX_SOCKET xor AHAP_CODEX_BIN, AHAP_CODEX_CWD, optional CODEX_HOME. Required export uses format=native with lossless bytes_base64 and completeness/source. common is explicitly unsupported. Projects: discover(action=projects,instance_ref),14tools. Search requires the explicit fixture bootstrap v4 migration; startup and read do not migrate.
