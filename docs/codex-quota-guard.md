# Codex reserve guard

The local Agent Herder owner defaults to enabled, 20% remaining, unknown=block.
A fresh quota of the selected native app-server account is checked immediately before thread/start, turn/start and turn/steer; CLI delivery uses its own CODEX_HOME authentication. No historic rollout is treated as a live quota. Read-only inspection and stop are never blocked. Already executing turns are not interrupted. A native Codex subagent spawned internally by an already admitted Codex turn is outside Herder's dispatch boundary.

The owner web UI exposes this in Automation / New sessions and in Quota. GET/PUT /api/codex-quota-guard uses the existing authenticated HTTP guard, a same-origin write check, revision conflict handling and atomic persisted settings in the canonical autopilot state directory. Changes need no restart. Unknown=allow or disabling protection is an explicit operator choice, not a fallback.

Fleet calls issued through this owner consult the recipient's model_quotas before Codex creation/delivery, including HTTP, SSH-native and GPTAdmin transports. The recipient's missing/unsupported quota blocks by default. This does not update independently accessed older Agent Herder owners on other machines; do not claim fleet-wide binary rollout.

Quota checks do not create an LLM session. Native account/rateLimits/read is used for the selected runtime, preserving account isolation. Reported provider denial wins over percentages. Any reported window below the reserve blocks; exactly 20% is allowed by the 20% threshold. Observed partial/invalid/expired snapshots fail closed by default. A rejection is pre-admission, nonretryable and does not trigger another model automatically.

## The scope of the reserve is the subscription, not the route

The reserve protects the owner's official OpenAI Codex subscription. A request served by a configured third-party provider route is billed by that route, so the subscription quota is not its budget and must not block it. Such a route is proven, never assumed:

- the provider id is known from native evidence: the provider the thread pinned, the provider the request pins, or — for a fresh thread only — the provider the Codex configuration declares as the default;
- the Codex configuration of the app-server declares that provider with an explicit `base_url`;
- that `base_url` is not an official OpenAI/ChatGPT endpoint, and the provider id is not the builtin `openai`/`azure` subscription provider.

Every other route keeps the guard, including a route the configuration does not declare, an unreadable configuration, an official endpoint and the builtin subscription provider. The scope is read from the configuration, so a route that a configuration layer overrides is not recognized by it and keeps the guard. The scope decision reads no transport: a refusal still submits nothing.
