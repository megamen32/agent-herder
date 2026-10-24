# Exact Codex thread cadence

The process-owned Herder runtime exposes three MCP tools:

- `cadence_schedule({sessionId, requestId, message?})` activates a durable schedule for an existing Codex thread. The session ID must be the native ID of the thread being continued. Reuse the same request ID when retrying an uncertain registration.
- `cadence_status({scheduleId?})` reads schedules, activation, next deadline, sequence, stable delivery input ID and the last native result.
- `cadence_control({scheduleId, sessionId, action: "pause" | "complete"})` stops that schedule. The continuation must call `complete` when its goal is achieved and `pause` on explicit pause. Herder cannot infer business completion from a turn ending.

The first wake is 15 minutes after activation. During the first hour the delay is 15 minutes; during the second hour it is 30 minutes, with wakes at the hour boundaries. After the two-hour wake, the next wake is the next clock minute `:45` in Europe/Moscow, then `:45` every hour. The first clock anchor can be less than 60 minutes after the two-hour wake. Moscow is UTC+3 with no daylight-saving transition, so the minute anchor is also `:45` UTC.

Busy native turns and approval prompts defer wakes in the first two hours. In the final hourly phase, a busy `:45` slot is skipped and the next chance is `:45` next hour. An hourly slot also expires after its clock minute, so restarting at `:50` does not deliver a stale `:45` wake. Missing or unverified native state defers it. First-phase missed deadlines produce one continuation when the session becomes available; they never produce a catch-up burst. Native delivery uses the existing `SessionSupervisor.sendMessage` automation path and selected Codex adapter, addressing the original session ID. The scheduler does not create or fork a thread and contains no financial/provider action implementation. A custom message carries no additional authority.

HumanStop remains independent of cadence registration and blocks automatic submission. An observed explicit Stop permanently pauses the schedule, including before its deadline; clearing HumanStop later does not rearm it. Explicit pause and completion are terminal for their request ID. Starting a later, newly authorized cadence requires a new request ID. Reusing a live or unresolved session's cadence under a second request ID is refused.

State is stored in `cadence.json` under the existing resolved autopilot state directory. It is shared by HTTP and stdio MCP transports and survives process restart. A filesystem lock coordinates registrations and claims across processes. Atomic rename and file/directory fsync complete before submitting a native input. The durable input identity is `cadence_<digest>:<sequence>`.

Each due delivery transitions to `dispatching` before the native call. An accepted result schedules the next wake. A proven pre-submission refusal becomes `blocked`. An uncertain response becomes `delivery_unknown`. A process crash during dispatch leaves `dispatching`; neither unresolved state is retried automatically. These records remain inspectable. Do not delete or edit production records to replay a potentially accepted continuation. A pause during submission does not cancel an already admitted turn; the receipt is preserved and the schedule remains paused.

The runtime polls persisted schedules every five seconds. It uses the selected existing Codex transport and the normal automation policy/quota/manual-stop gates. Registering a cadence does not override those gates. No new model, credentials, daemon, cron job or MCP endpoint is required.

Engineering checks:

```sh
npx tsc --noEmit --pretty false
npx vitest run tests/cadence-scheduler.test.ts tests/cadence-tools.test.ts tests/codex-adapter.test.ts
```

These establish source behavior and MCP protocol boundaries with isolated fixtures. Installed GPTAdmin discovery, production process identity, registration of the owner's current thread, an actual timed wake and independent model acceptance remain separate delivery claims. This change does not install or restart a production MCP service.
