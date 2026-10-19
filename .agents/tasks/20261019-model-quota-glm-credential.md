# GLM Coding Plan quota query: resolved

The user asked Agent Herder to report GLM, MiniMax and Codex usage and to move
to an allowed model after a definite quota rejection. The implementation is on
`main` and deployed in the server-100 `agent-herder.service`.

The user submitted `zaikey` through AskSecret. Its value matched the existing
mode-600 Z.ai credential file at `/home/roomhacker/agents-projects/zai_key`;
the comparison emitted only MATCH/DIFFERENT. No duplicate key was written. The
service now exposes that protected path as `AGENT_HERDER_GLM_TOKEN_FILE`, and
`model_quotas` reads it without returning the credential.

Live MCP quota read on 19 October 2026:

- GLM: weekly window exhausted (`remaining=0`, `percentage=100`), resets
  23 October at 21:06 Moscow time. Shorter credit window has 12% remaining and
  resets 19 October at 22:11 Moscow time. This explains the GLM rejection.
- MiniMax Token Plan: general interval reports 0% remaining and 69% weekly;
  video allowance reports 100% remaining. The configured model fallback uses
  the separately listed OpenCode OmniRoute MiniMax model.
- Codex Pro: primary window reports 34% used, `limit_reached=false`.

Fallback behavior: any definite pre-admission HTTP 429 now qualifies. OpenCode
GLM Flash model IDs default to `omniroute/minimax/MiniMax-M3.1-Flash`; explicit
`fallbackModels` can override the route. The same session and `inputId` are
reused. Unknown/admitted delivery and manual stop still block a retry.

Delivery: `753252d` added the default GLM-to-MiniMax route; `49abcdc` added
protected token-file quota reads. The service is active. MCP `tools/list` and
`model_quotas` were verified live. Relevant tests passed (30 session/schema,
4 quota), TypeScript check and production build passed. No secret value is
stored here.
