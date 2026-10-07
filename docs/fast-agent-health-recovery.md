# Fast Agent health recovery

Agent Herder observes existing Fast Agent conversations from `/home/roomhacker/.fast-agent`. Health recovery uses a newly created native persisted session, never a manually stopped general conversation. Native creation uses the installed Fast Agent Python SessionManager before the first prompt, so the returned ID is resumable and visible.

POST the local REST endpoint `http://127.0.0.1:18787/api/health/remediation` with the usual incident/plan/name/cwd/message fields and:

```json
{"harness":"fast-agent","execution":{"runtime":"fast-agent","provider":"minimax","model":"MiniMax-M3.1-Flash-Preview","reasoning":"default","topic":"health"}}
```

The model maps to `anthropic.MiniMax-M3.1-Flash-Preview`. This dedicated profile uses the native shell tool and selects no MCP servers. Existing general Fast Agent chats retain their existing workload contract. Responses must be checked through the returned native conversation details; accepted queue delivery is not proof of completed repair.

## Reviewed recovery budget

On server-100 on 2026-10-07 the Fast Agent MCP startup working set measured 134–151 MiB, Herder approximately 352 MiB, and the shared user slice was near its soft memory limit with swap pressure. The reviewed conservative recovery budget is one worker, CPU quota 100%, RAM high/max 384/768 MiB, swap 0, tasks 64, IO weight 25, native one-shot timeout 300 seconds. The worker remains inside the outer fleet safety boundary. Do not run a broad build or test suite from recovery. If a valid diagnostic reaches this cap, split the job before considering a measured budget change.

Put recovery artifacts under the canonical administration checkout's ignored `.tmp/`; producers must bound and rotate diagnostic output. Notice Place owns incident notifications. A recovery worker must verify the shortest real connection/thread consumer canary before reporting restoration and must not automatically resume manually stopped chats.

## Direct MiniMax channel

The dedicated deploy/fast-agent-minimax.yaml template installs at /home/roomhacker/.config/agent-herder/fast-agent-minimax.yaml (mode 0600). Direct native models anthropic.MiniMax-* select this config; the child receives ANTHROPIC_API_KEY from existing protected MINIMAX_API_KEY. Ordinary generic sessions retain their gateway settings. No credential is stored in Git. The direct Anthropic endpoint returned HTTP 200 for exact MiniMax-M3.1-Flash-Preview on 2026-10-07; the local generic gateway rejected that model because its catalog is incomplete.

The matching deploy/fast-agent-minimax-card.yaml installs mode0600 at the same configuration directory. Its native request_params.max_tokens=524288 supplies the Anthropic SDK mandatory field for this custom model. Child-only ANTHROPIC_BASE_URL is fixed to the subscription endpoint and ANTHROPIC_AUTH_TOKEN is cleared. The canonical credential was privately proven equal to OpenCode provider minimax-coding-plan; no PAYG fallback is allowed.

Queued execution writes a bounded, redacted mode0600 herder-execution.json receipt inside the native session directory. A nonzero exit or a completed process without a new native assistant answer becomes an error visible in the Herder conversation.

The exact Flash model's published output ceiling is 524288 tokens, including reasoning; this is not its 1M context window. See https://platform.minimax.io/docs/api-reference/text-chat-openai and https://platform.minimax.io/docs/api-reference/text-anthropic-api. Thinking stays enabled with the provider default max effort.

The explicit card uses unique agent name herder_minimax and CLI --name herder_minimax. This avoids a collision with the pre-existing home card dev.md while preserving ordinary home agents. Native card merge/selection is validated offline before provider dispatch.
