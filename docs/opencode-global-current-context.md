# Fresh global OpenCode current-turn context

The physical project release passed real once/wait/ACK and idle-no-debt checks
on backend `092cb9c`. A new default-config consumer instead kept its input pending
and never observed the active code. The global config listed the canonical
Herder plugin URL, but that alone does not prove which cached module factory was
used. Cached canonical code is a hypothesis, not a claimed live-byte inspection.
The failed consumer and its accepted effects must not be retried.

## Supported native discovery

OpenCode 1.18.32's [ConfigPaths.directories](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/config/paths.ts)
includes `Global.Path.config` for each instance. Its
[instance config loader](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/config/config.ts)
calls `ConfigPlugin.load(dir)` while constructing that instance's config.
[ConfigPlugin.load](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/config/plugin.ts)
discovers `{plugin,plugins}/*.{ts,js}` and keeps distinct physical file URLs.
This scan is separate from the infinite cached global JSON config. The native
[plugin loader](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/plugin/loader.ts)
imports the resolved entry, so changing a query string or the bytes behind a
previously imported filename is not an activation proof.

`integrations/opencode/agent-herder-current-context.js` is a self-contained
legacy function projection. It exports only
`experimental.chat.messages.transform`; it has no imports of canonical Herder
code and no second autopilot, event, command, system or tool handler. It uses
the existing exact root-user/SID context endpoint and durable one-offer store,
including fresh native busy/identity, persisted Stop and connection checks.
The 1200ms body deadline is unchanged. A changed output root, a failed read or a
lost response never causes a new input, resume, next-turn debt or blind retry.
An ACK is not proof that the model read the context.

## Root-owned release and activation

1. Verify the published source and compute the bridge file's full SHA-256.
   Stage those exact bytes as a **regular physical `.js` file** under the native
   global `Global.Path.config/plugins` directory. On this verified host that is
   `~/.config/opencode/plugins/agent-herder-current-context-<sha12>.js`.
   Do not use a symlink, query suffix, import wrapper or overwrite an old path.
   Verify the staged bytes match the source hash. Source execution never writes
   to this installed directory.
2. Preserve global JSON, canonical plugin URL, provider/model/auth/permissions,
   the old autopilot plugin and all foreign instances. Do not call global config
   update, global dispose or restart: those can dispose unrelated active work.
   The physical directory bridge supplements only messages context.
3. Fresh directories get a new instance config scan and can discover the new
   filename even while global JSON and the canonical module remain cached. For
   an already existing instance, independently prove that exact directory has
   no active/queued/foreign work before Root uses the supported scoped
   `POST /instance/dispose?directory=<exact directory>`. Unknown/active instances
   keep their old hooks; no immediate safe in-place global refresh is claimed.
4. Verify the resolved plugin list contains the physical versioned bridge for
   one new default-config directory **without a project Herder override**.
   Root performs one new unpredictable-code once/wait/ACK consumer and idle
   report refusal checks. Do not replay old accepted tasks/effects or reset any
   OFFERED receipt. Readiness, configuration listing and isolated tests alone
   are not real model-observation acceptance.

Only one current bridge release should remain discoverable for future scans.
If updating it later, Root may archive old **owned bridge** files outside the
discovery directory; do not remove canonical/foreign plugins. Existing imported
factory references are not unloaded by that filesystem change. The regression
also covers overlapping bridge factories: the existing durable offer prevents
duplicate context without introducing another store or controller.

The isolated proof uses a genuinely cached ESM passive module in a private test
directory alongside a fresh physical bridge and the real Herder HTTP/store/
OpenCode adapter with read-only simulated native responses. It verifies once
offer, Stop/idle/new-user refusal and explicit inbox retention. It models the
supported loading/coexistence boundary; it does not reproduce the live binary's
cache contents or claim activation of foreign instances.
