# Working machine of a session (host / cwd targeting)

A session has two separate addresses:

- **launch address** — the machine the native process runs on, plus harness and
  native session ID. It never moves while the session is alive.
- **work target** — the machine the work actually happens on, plus the working
  directory. It can be changed at any moment.

The work target is the only thing this document is about. The launch address
stays the address of the reply route.

## Machine identity

`hostId` is the machine identity. One machine always has one spelling.

- `localhost`, `127.0.0.1` and `::1` mean **the machine this Herder process
  runs on**. They are not a remote machine.
- An omitted `hostId` in an operation means the same local machine.
- Everything else is trimmed and lower-cased, so `Server-44` and `server-44` are
  the same machine.

`normalizeHostId(input, localHostId)` in `src/coordination-notes.ts` is the one
place where this happens. Schemas, the session route and the fleet all go
through it; nothing else is allowed to spell a machine differently.

Known machines of this fleet: `roomhacker-server-100` (the local host of the
Herder on 100), `server-44`, `roomhacker-server-88`, `mac-mini-2012.lan`,
`MacBook-Pro-User.local`.

## Where the machine is visible

`AgentSession.hostId` (required) is the machine the session works on, and
`AgentSession.launchCwd` is the directory it was launched from. `cwd` stays the
current effective directory.

- `list_agents` returns the machine of every session. With `hostId` it returns
  only the sessions of that machine; **without** it, every machine is listed.
  The default is not `localhost` — the owner sees the sessions of 44, 88 and
  the Mac in one list.
- The mesh projection (`projectObservation`) reports `currentCwd` and
  `workspaceHostId` for the session, so a peer sees where the work happens.
- `list_agents` accepts `hostId` on `send_message`, `deliver`, `agent_info`,
  `create_session` and `new_or_resume`. The machine defaults to the local one.

## Changing the work target of a live session

```text
set_session_target({sessionId:"<native ID>",harness:"codex",
  hostId:"roomhacker-server-88",cwd:"/home/roomhacker/project"})
```

`hostId` and `cwd` are both optional, but at least one of them must be given;
the omitted one keeps its current value. The receipt is:

```text
{sessionId, harness, hostId, cwd, previous:{hostId,cwd},
 state:"updated"|"unchanged"|"unreachable"|"unsupported", reason?}
```

- `updated` — the new target is declared and observed by the projection.
- `unchanged` — the session already worked exactly there.
- `unreachable` — the machine could not be reached. The target is **not**
  applied locally and the receipt does not claim success.
- `unsupported` — the target cannot be expressed for this session.

The override uses the existing workspace mechanism (`workspace_declare`,
`declareWorkspace`, `projectObservation`). There is no second truth about where
a session works: after the override the old machine no longer owns the session,
and the mesh, the coordination roster and `list_agents` all show the new one.

A remote directory is verified on the remote machine with that machine's own
MCP node before it is declared. A declaration is a lease: it expires after 24
hours and can be renewed by declaring it again.

## Addressing an existing session of the fleet

The fleet could only create sessions before. It now addresses an **existing**
session by its full address:

```ts
fleetService.setSessionTarget(
  {hostId:"server-44",harness:"codex",nativeSessionId:"s1"},
  {hostId:"server-88",cwd:"/w"})
```

The mutation travels through the existing session control channel
(`fleetSessionControlSchema`, new operation `set-target`), so fleet sessions
keep one remote path. The receipt is `FleetSessionTargetReceipt` with the same
four states; an unreachable machine is never reported as applied.

`fleetHarnesses` is unchanged (`codex`, `zcode`, `opencode`). Adding a harness
is one edit in `src/mesh/fleet-contract.ts`, but every node must already
observe that harness first — a node that cannot has to fail closed instead of
disappearing from the fleet view.

## Out of scope

- `minimax-code` is not a fleet harness yet. Before it can be one, the
  `native_observation_failed` failure on the Mac node has to be fixed, or the
  Herder on 100 will not see the minimax-code sessions of that machine.
- The remote owner side of `set-target` (the fleet HTTP route that applies the
  new work target on the node that owns the session) is still to be implemented
  on the owner API.
