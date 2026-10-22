# Codex reserve guard

The local Agent Herder owner defaults to enabled, 20% remaining, unknown=block.
A fresh quota of the selected native app-server account is checked immediately before thread/start, turn/start and turn/steer; CLI delivery uses its own CODEX_HOME authentication. No historic rollout is treated as a live quota. Read-only inspection and stop are never blocked. Already executing turns are not interrupted. A native Codex subagent spawned internally by an already admitted Codex turn is outside Herder's dispatch boundary.

The owner web UI exposes this in Automation / New sessions and in Quota. GET/PUT /api/codex-quota-guard uses the existing authenticated HTTP guard, a same-origin write check, revision conflict handling and atomic persisted settings in the canonical autopilot state directory. Changes need no restart. Unknown=allow or disabling protection is an explicit operator choice, not a fallback.

Fleet calls issued through this owner consult the recipient's model_quotas before Codex creation/delivery, including HTTP, SSH-native and GPTAdmin transports. The recipient's missing/unsupported quota blocks by default. This does not update independently accessed older Agent Herder owners on other machines; do not claim fleet-wide binary rollout.

Quota checks do not create an LLM session. Native account/rateLimits/read is used for the selected runtime, preserving account isolation. Reported provider denial wins over percentages. Any reported window below the reserve blocks; exactly 20% is allowed by the 20% threshold. Observed partial/invalid/expired snapshots fail closed by default. A rejection is pre-admission, nonretryable and does not trigger another model automatically.
