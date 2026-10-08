# Compact snapshot

Input is a JSON object, at most 1 MiB. Use UTC Unix seconds for observation times. Export native observations, not conclusions from sidebar titles.

```json
{
  "schemaVersion": 1,
  "inventoryComplete": true,
  "contractsComplete": true,
  "sessions": [
    {
      "harness": "codex", "host": "workstation", "id": "current",
      "pinned": false, "access": "available", "nativeStatus": "idle",
      "activeTurnId": null, "queued": false, "observedAt": 2000000000
    },
    {
      "harness": "codex", "host": "workstation", "id": "original",
      "pinned": true, "access": "available", "nativeStatus": "idle",
      "activeTurnId": null, "queued": false, "observedAt": 2000000000
    }
  ],
  "contracts": [
    {
      "id": "logical-task", "scopeVerified": true, "outcome": "pending",
      "owner": {"harness": "codex", "host": "workstation", "id": "current"},
      "aliases": [{"harness": "codex", "host": "workstation", "id": "original"}],
      "children": [],
      "handoffEvidence": {"verified": true, "receipt": "handoff-receipt"}
    }
  ]
}
```

An explicitly verified replacement handoff is required before hiding aliases of a pending task. It must account for the original checkpoint, remaining scope, and unsaved work. Children are retained while their parent is pending.

A completed contract additionally requires:
```json
"completionEvidence": {"kind": "consumer", "verified": true, "receipt": "result-receipt"}
```
Use `kind: "userAccepted"` only for an explicit user acceptance. Source checks and turn receipts are insufficient. If a session belongs to another pending or unknown contract, preserve it.

A native observation is usable for five minutes, independently for each session. Missing/unknown access or queued state prevents unpinning. `activeTurnId: null` must be explicit. Native idle/stopped/failed status cannot change the contract outcome. Unknown or absent IDs stay in the returned full scope.

The planner drops all unrelated input fields, including titles and message previews. Its scope digest binds the plan to the exact ownership/evidence registry. `verify` requires a fresh full snapshot: it rejects changed contracts and recomputes eligibility, while treating already-applied pins as satisfied. Save files privately (`umask 077`); these exports belong to the user's project, not the public plugin.
