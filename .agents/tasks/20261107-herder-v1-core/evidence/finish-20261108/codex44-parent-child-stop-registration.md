# Codex 44 completion hook: inactive parent registration contract

This is an install-ready, inactive contract for the Terra Dirac canary. The
parent orchestrator is the sole installer and activates it only after Core is
green. No target runtime, global hooks, or config was changed by this worker.

## Verified target and hook order

- Server-44 Codex CLI/managed daemon is `0.167.0`; native HOME is
  `/home/roomhacker`, `CODEX_HOME=/home/roomhacker/.codex`, and
  `~/.codex/config.toml` enables `hooks=true`.
- A read-only check found no `/home/roomhacker/.codex/hooks.json` at the time
  of inspection. Parent installer must merge the registration below and ensure
  the daemon has loaded it before creating either root session.
- Codex `Stop` executes synchronously before terminal `turn/completed`.
  Consequently the hook defers work to a bounded detached process and asks
  Core to reconcile the exact native turn. It retries only an explicit
  `completion_unconfirmed` with `effect=none`, within the configured bounded
  completion window. Core's native completed-turn reader remains the proof.
- The accepted canary creates two scoped root sessions via ordinary `create`,
  then binds them with Core `automation.create` child_completion. Native
  subagent spawn/lineage is not part of this contract; `parent_thread_id` is
  expected to be absent. Register both `Stop` and `SubagentStop`; the exact
  mapping and `cwd` constrain which event can cause a call.

## Parent installer registration patch

Install the hook at
`/home/roomhacker/.local/share/agent-herder/v1-completion-hook.mjs`, then
merge both entries into `/home/roomhacker/.codex/hooks.json`, preserving any
unrelated existing configuration:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "AGENT_HERDER_V1_HOOK_CONFIG=/home/roomhacker/.config/agent-herder/v1-completion-hook.json node /home/roomhacker/.local/share/agent-herder/v1-completion-hook.mjs" }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "AGENT_HERDER_V1_HOOK_CONFIG=/home/roomhacker/.config/agent-herder/v1-completion-hook.json node /home/roomhacker/.local/share/agent-herder/v1-completion-hook.mjs" }] }
    ]
  }
}
```

Protected paths:

- config: `/home/roomhacker/.config/agent-herder/v1-completion-hook.json`
- bearer: `/home/roomhacker/.config/agent-herder/v1-completion-hook.bearer`
- optional receipts: `/home/roomhacker/.local/state/agent-herder/completion-hook-receipts`

Config, bearer, hook, and receipt files are mode `0600`; containing config and
receipt directories are mode `0700`. Parent installer extracts the existing
Authorization value directly to the bearer file without printing it. Initial
config is written before either root session is created:

```json
{
  "endpoint": "https://mcp.bezrabotnyi.com/server/shell-roomhacker-server-100-agentherder/mcp",
  "bearer_file": "/home/roomhacker/.config/agent-herder/v1-completion-hook.bearer",
  "receipt_dir": "/home/roomhacker/.local/state/agent-herder/completion-hook-receipts",
  "timeout_ms": 5000,
  "defer_ms": 300,
  "completion_wait_ms": 5000,
  "completion_poll_ms": 250,
  "children": []
}
```

## Exact owner binding and activation sequence

1. Parent installer registers both event types and writes the protected
   empty-mapping config before creating the two scoped root sessions through
   ordinary Core `create`.
2. Read back both exact native `session_id` and `cwd` values. Resolve their
   Core refs under the same `samecodex-44` authority. Use ordinary
   `automation.create` to bind the chosen parent session and child ref with a
   `child_completion` rule and persist the returned `rule_ref`. Do not expect
   native spawn lineage or a `parent_thread_id`.
3. After binding is verified, atomically replace the config's empty `children`
   array with the single explicit entry below. This enables only the exact
   child native session/cwd and the Core binding supplied by the owner:

   ```json
   {
     "session_id": "<exact child native session_id>",
     "child_native_id": "<same exact child native session_id>",
     "parent_native_id": "<exact owner-created parent native session_id>",
     "cwd": "<exact child native cwd>",
     "parent_ref": "<owner-bound parent Core session_ref>",
     "child_ref": "<owner-bound child Core session_ref>",
     "rule_ref": "<automation.create result>"
   }
   ```

   The hook matches `session_id`, `child_native_id`, and `cwd` exactly and
   requires the explicit owner-bound refs. It never infers parent identity
   from hook payload fields.
4. The next child turn invokes the registered native hook. It returns `{}`
   promptly, then the bounded worker performs MCP initialize/initialized,
   schema discovery, and exactly one reconcile effect (repeating only the
   explicit effect-none completion-unconfirmed response). `event_id` is the
   unchanged native `turn_id`; no timestamp/hash substitutes for it.
5. Review the sanitized receipt and Core receipt, then verify the original
   parent consumer shows exactly one wake and model-send count has no extra
   send from the hook. Until this canary readback is observed, acceptance is
   not PASS.

## Sanitized receipt schema

With optional `receipt_dir`, the hook writes one record per exact mapped
`session_id` + native `turn_id`; the filename is SHA-256 of those two values
joined with a NUL byte. Directory/file permissions are forced to `0700` and
`0600`; records are capped at 4096 bytes. Fields are ISO timestamp, native
session/turn IDs, allowlisted observed identity key names, `stage`, and
allowlisted `code`, `effect`, and `task_ref` when supplied by Core. It never
stores messages, tokens, transcript paths, unknown input values, or raw errors.
Receipts are best-effort and cannot block Stop. Unmapped sessions create no
receipt. The receipt is diagnostic evidence, not proof of wake/completion.

## Evidence boundary

Read-only gateway proof previously confirmed MCP handshake, tool discovery,
and Core automation create/reconcile schema. This document and local unit
tests do not establish native hook delivery or a real parent wake. No
registration, hook activation, mutating Core call, or model send occurred in
this worker task; Terra Dirac owns the live canary.
