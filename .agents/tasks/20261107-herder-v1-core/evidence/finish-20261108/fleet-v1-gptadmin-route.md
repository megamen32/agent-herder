# Fleet Rust V1 through existing GPTAdmin

## Recommended composition

Fleet HTTP MCP clients -> existing GPTAdmin authenticated per-server facade ->
server100 ShellMCP `mcp_call(ref=AgentHerder)` -> one persistent stdio session ->
`/home/roomhacker/.local/bin/agent-herder-v1` -> installed herder-compat -> Rust
core -> existing TS AHAP adapters. No extra HTTP proxy/daemon is required.

Use the SAME ref and SAME server100 ShellMCP instance for every client. Sessions
are cached/serialized by ref in `go-shellmcp/internal/mcpclient/client.go`
(getStdio/stdioSession). Hub HTTP initialize is facade-local; disconnecting one
HTTP consumer does not create/close a separate upstream process. Native timeout
can terminate that child; do not replay UNKNOWN mutations after reconnect.
Two configured refs (AgentHerder and AgentHerderV1) create two sessions/cores;
keep only the canonical enabled owner ref once parent finishes verification.
Do not launch the entry per fleet client or deploy Rust daemons to every host.

## Exact management contract

Live read-only schema obtained from `control:roomhacker-server-100`, tool
`mcp_manage`, call_ref `op_a9e5604a940dce2e`:

```json
{"type":"object","additionalProperties":false,"required":["action"],"properties":{"action":{"type":"string","enum":["list","upsert","remove","enable","disable","restart","status","config"]},"ref":{"type":["string","null"]},"config":{"type":["object","null"],"additionalProperties":true}}}
```

`upsert` replaces the entire definition and closes the existing protocol session.
It persists atomically at `/etc/gptadmin/mcp-supervisor.json` (root,0600).
Enable does not eagerly start: discovery/call starts the child lazily. Definitions
and lifecycle must be changed only on owning server100 control target, not Hub's
inventory-only admin endpoint. Parent owns mutations; none were made here.

Concrete desired definition (reference for parent, not executed):

```json
{"action":"upsert","config":{"ref":"AgentHerder","name":"agent-herder","transport":"stdio","command":"/home/roomhacker/.local/bin/agent-herder-v1","args":[],"cwd":"/home/roomhacker/agents-projects/agent-herder","user":"roomhacker","env":{"HERDER_V1_ENTRY":"/home/roomhacker/.config/agent-herder/v1-entry.json","XDG_CONFIG_HOME":"/home/roomhacker/.config","XDG_CACHE_HOME":"/home/roomhacker/.cache","XDG_STATE_HOME":"/home/roomhacker/.local/state","XDG_DATA_HOME":"/home/roomhacker/.local/share"},"enabled":true}}
```

Leave connection_mode/owner_profile_id empty for this legacy unscoped route.
Tool allowlist, if used, must include actual discovered V1 tools and compat_task;
never preserve the old daemon's unrelated 40+/88-tool catalog as acceptance.

UID matters: shellmcp.service runs as UID0 in this snapshot. Actual protocol
client `mcpclient/process_unix.go:17-65` enforces config.user via setuid/gid/groups
and sets HOME/USER/LOGNAME to that account. It is NOT enough to set HOME while
running root. Launcher validates selector/profile owner UID == os.getuid(),
mode0600, canonical regular file, single link. `user=roomhacker` is required.
The old supervisor.Manager comment saying User is ignored does not describe
this real child protocol path.

Unscoped stdio inherits ShellMCP environment plus overrides; an explicit env map
is not an environment scrub. Do not copy credentials into the registry or assume
setuid removes inherited secrets. Only protected reference paths are needed here.
No environment values or secrets were printed in this review.

## Installed entry metadata (read, not started)

Entry is a private executable Python launcher; default selector is
`~/.config/agent-herder/v1-entry.json`, override HERDER_V1_ENTRY. It execs manifest
compat, passes protected --trusted-owner-profile arguments, and sets
HERDER_NATIVE_COMMAND to the manifest Rust core. It validates all artifact
hashes. Do not point supervisor directly at the raw modern core for old clients.

Sanitized selector snapshot: manifest
`/home/roomhacker/herder-artifacts/releases/herder-v1-d08a68ae-cooldown/manifest.json`,
SHA256 `5e21be1d8fb7ee50654e0823db4dcaec5955f3469527c10daa2bf448c5663f39`,
one profile, kind codex, principal local-owner, node roomhacker-server-100,
instance codex-local. This proves selection, not coverage of other harnesses.
A singleton core serves only profiles selected there; registering the singleton
cannot invent absent remote harness instances. Parent owns profile expansion.

## Existing remote paths and authentication

Live descriptor for server100: child server_id `c8d52d2c7c85f`, target alias
`mcp:shell:roomhacker-server-100:AgentHerder`, parent
`shell:roomhacker-server-100`, ref AgentHerder, slug
`shell-roomhacker-server-100-agentherder`.

Fleet URL:
`https://mcp.bezrabotnyi.com/server/shell-roomhacker-server-100-agentherder/mcp`.

Use existing GPTAdmin Bearer/OAuth credentials with permission for that exact
child target. Same tenant origin's /server/{slug}/mcp is also the supported path;
never embed a token in a URL. GET /mcp-relay/servers provides public_mcp_slug/path.
The explicit HTTP invocation facade remains POST /mcp-relay/call with
`{target:"mcp:shell:roomhacker-server-100:AgentHerder",tool:"discover",arguments:{...}}`.
Prefer ordinary per-server MCP for fleet registrations; the full Hub /mcp surface
adds routing/admin tools that clients do not need just to use Herder.

All clients on this owner route share Herder's selected trusted owner principal;
Gateway credential/profile authorization is not automatic end-user identity
propagation into Rust. Restrict to the authorized owner fleet. No cross-user
isolation or delegated arbitrary profiles is claimed.

## Compatibility and why /connection is not selected

`/server/{slug}/mcp` is a tools facade, not transparent JSON-RPC byte forwarding.
Hub handles initialize/server-discover locally. ShellMCP separately initializes
stdio; tools/list/call route to the persistent child. Hub tasks/get/cancel refer
to Hub jobs, not automatically to a child Rust task ID; managed /connection
supports tools only. Do not advertise native subscriptions/tasks transparency.

The INSTALLED entry already uses herder-compat. That exposes native tools and
compat_task(get/answer/cancel), compat_skill and compat_changes when supported.
Native task starts return a normal tool result with task_ref/status; read those
through compat_task. This stays within tools/list/call and composes with existing
GPTAdmin. Native cancellation/stream semantics remain limited to that wrapper;
no raw tasks/get forwarding or SSE-notification equivalence is asserted.

Managed `/connection/{slug}/mcp` creates per-credential/session partitions.
Scoped stdio is currently disabled (`ScopedProcessGroupsSupported=false`), even
on Unix. It is neither a shortcut to a shared singleton nor a supported way to
bypass that guard. Setting connection_mode=stateless does not remove the gate.
Use the supported unscoped legacy facade for this trusted shared owner service.

Known first-call issue reported by parent: a new stdio ref passed mcp_tools then
mcp_call(discover), but changing an existing ref caused first discover to fail
Unknown compatibility operation until tools/list. Cached native clients need
that first-call path fixed in herder-compat, not an artificial rediscovery ritual
or a new proxy. This agent's next authorized slice is exactly that source fix.

## Fleet client support

| Client | Supported composition | Limit |
|---|---|---|
| Codex, Claude Code, OpenCode, VS Code | Existing remote HTTP MCP registration, this URL and protected Bearer/OAuth | Verify fresh startup and discover through exact child; do not count old cached catalog |
| Hermes, Zed, Fast Agent | Existing GPTAdmin client HTTP config support in cli.py | Same compatibility tools surface; actual loaded instance reload is separate proof |
| ZCode | cli.py _configure_zcode_mcp writes existing native remote MCP server config | Existing owner token retained; exact official consumer read required |
| Claude Desktop/other stdio-only environments | Existing GPTAdmin/HTTP-to-stdio client bridge if already deployed | Bridge is a client transport, not a second Herder daemon; do not invent native HTTP support |
| Browser ChatGPT/Z.ai | Not MCP harness clients in this migration | They remain backend AHAP instances, only when explicitly selected profiles exist |

## Evidence boundaries and parent handoff

Read-only evidence: live mcp_manage schema; live Hub descriptor; sanitized local
supervisor/selector metadata; source review at GPTAdmin
52e2838aaa6b5d9afb8ba8265db092c784ef78ef. Config/descriptor snapshots can differ
during parent's rollout (initial file was legacy HTTP18787, later ref was stdio).
No configs edited, processes started/stopped, deploy, secret output or child
native tools called by this reviewer.

Parent supplied actual proof: AgentHerderV1 mcp_tools then mcp_call discover PASS;
canonical AgentHerder switched to stdio user=roomhacker; tools/list then discover
PASS. That validates the route beyond static design, but not first-call cached
clients, one PID across concurrent callers, whole-fleet migration or all harnesses.
Remaining parent acceptance: fix first-call compatibility; one shared canonical
ref; simultaneous clients read same exact installed core without extra Herder
PIDs; cold/reconnect discover and compat_task read; reconcile/retire old per-host
registrations while preserving their history/disabled entries and in-flight work.
