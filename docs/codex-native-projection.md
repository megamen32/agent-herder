# Codex native hook release projection

Codex `rust-v0.162.1` selects a schema-declared root `plugin.json` before legacy
manifests, and its AgentPlugin loader supplies zero native hooks. Merely enabling
`hooks`/`plugin_hooks` does not change that selection. The verified installed
`plugin/read` returned `hooks: []`. The Stop payload is already supported and
uses `session_id` and `turn_id`; no field alias or feature toggle fixes this.

Primary version-pinned sources:
[manifest selection](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/utils/plugins/src/plugin_namespace.rs#L38),
[hook loading](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core-plugins/src/loader.rs#L897).

The utility uses the existing TypeScript parser on the build host to inspect actual JavaScript import syntax; SQL strings/comments are not dependencies.

The release utility makes a **Codex-only artifact of the existing plugin**.
The original portable AgentPlugin 1.0 manifest, other harness interfaces,
and canonical checkout are unchanged. The utility itself does not write the
installed native cache; the subsequent official installer does. The artifact has
no root portable manifest, so native Codex discovers `.codex-plugin/plugin.json`.
Its exact original hook commands, HTTP singleton MCP route, skills, built
runtime and hook dependency closure are retained. Version is selected as
an explicit new stable native version, e.g. `0.2.3`, while portable `0.2.2` stays unchanged. Identical input has the same content fingerprint. Dependencies come from the reviewed package's installed modules;
there are no network/package-install/provider calls.

Root first prepares a coherent built package containing `package.json`, both
source manifests, `.agents/plugins/marketplace.json`, the declared hook payload,
skills, `dist` and installed hook dependencies. Source compiled/runtime pins
must match its reviewed release. This utility does not build or install it:

```sh
node scripts/prepare-codex-native-projection.mjs \
  /absolute/reviewed/package-root /absolute/new/codex-native-artifact 0.2.3
```

Root must independently verify this new version is absent from the native cache before install. Never reuse an installed version for different bytes. Native selection takes the greatest cached semver; an old-version prerelease is insufficient.

**Before official installation, Root must archive the existing plugin cache
outside that plugin's managed cache directory and verify its complete file
inventory and hashes against the archive.** Retain the verified archive and its
receipt as the preservation/rollback evidence. The native updater's
`PluginStore.activate_staged_plugin_cache` calls `remove_old_plugin_versions`:
it prunes older cached versions when activating the new version. A distinct
new version or cache path does **not** preserve the previous installed bytes.
Do not install until the pre-install archive has been verified.

Historical result, 2026-10-12: official installation of native `0.2.3`
successfully exposed five trusted hooks and produced a genuine Stop `done`
receipt. The installer also deleted the previous `0.2.2` cache before any
backup was made. Root's comparison of 62,234 old file hashes confirmed
preservation **FAIL**. Earlier claims that the old installed cache remained
immutable/preserved were incorrect; source portable `0.2.2` and the other
harness interfaces remained unchanged. Record this missing backup honestly;
do not reconstruct unverified old bytes, fabricate preservation evidence or
rewrite the installed cache to disguise the loss.

The new output must be separate from the input package and absent. Limits are
16 MiB and 4096 files; symlinks, escaping imports, missing dependencies and a
subprocess MCP route are refused. Source content fingerprints and dependency
names are recorded in `projection-receipt.json`.

The artifact exposes its existing native marketplace definition at
`<artifact>/.agents/plugins/marketplace.json`, retaining the marketplace name
`agent-herder-local`, plugin name `agent-herder` and local source `.`. Root owns
registration/install through the native supported marketplace/plugin release
mechanism. Do not patch installed cache files, copy skills into harness homes,
change global MCP/auth/grants, or restart the shared native writer to apply it.
Preserve accepted work; hook availability is checked through model-free native
`plugin/read`/`hooks/list` for a newly loaded supported context.

Acceptance is actual nonzero matching native hook discovery and a genuine
Stop invocation/explicit outcome on Root's authorized fixture. Packaging tests
alone do not prove native discovery, hook execution or business completion.
Cold completion reconciliation is separately documented in
[codex-parent-completion.md](codex-parent-completion.md), and never fabricates a
Stop receipt when native hooks are absent.

`tests/codex-native-projection.test.ts`: fast unit, expected under 1 second,
maximum 5 seconds; verifies deterministic versioning, portable-source retention,
exact copied hooks/MCP/skills/transitive dependencies, no overwrite, and refusal
of symlinks, missing dependencies, escaping imports or a second server writer.
Combined ordinary release checks remain bounded at 180 seconds.
