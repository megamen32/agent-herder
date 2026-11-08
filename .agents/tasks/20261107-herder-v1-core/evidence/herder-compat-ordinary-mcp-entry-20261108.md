# Ready ordinary MCP entry: herder-compat translator (fact for CI, 2026-11-08)

Question from CI: does a ready ordinary MCP entry already exist for ordinary
Codex 0.167, given the native transport requires inline protocol 2026-07-28?

Answer: yes. `crates/herder-compat` is tracked in origin/main (present at
805fd477 and still present at ee6ed6e0; lineage e31d1f52 -> d03cfb8f ->
e4c8d8ea). It is NOT packaged by build-v1-core.py and is not in the
805fd477final manifest, which is why it is absent from the artifact.

Launch contract: `HERDER_NATIVE_COMMAND=<native Herder MCP executable>
herder-compat` (stdio). The translator connects upstream with protocol
V_2026_07_28 and serves a legacy stdio edge downstream.

Verified locally this run (source 805fd477, debug build):

- cargo build --locked crates/herder-compat PASS.
  Binary sha256 21f6cb0b08068fe78397a0a2f1b3da881278ec325f37d7df8b02df55f36fba34
  (debug, not a packaged release artifact).
- Unit handshake test PASS: native and legacy keep their explicit protocol
  versions.
- Real forwarding test PASS against the exact 805fd477final core binary
  (c1952779c9ca812345d7ba4929a12b727ed87dc24d2a06d08852330c90bcc368):
  upstream negotiated V_2026_07_28, downstream observed V_2025_06_18 without
  downgrade.

Scope: local stdio wire proof only. No native sends, no Codex run, no
installation, no packaging change. Whether the ordinary Codex consumer path
uses this entry is CI's call; a release/packaged compat binary would be a
separate packaging decision.
