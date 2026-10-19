# GLM Coding Plan quota query: credential pending

The user asked Agent Herder to report GLM, MiniMax and Codex usage and to move
to an allowed model after a definite quota rejection. The source change is on
`main` as `1e56fd4`, built and running in the server-100 user service.

Live MCP verification on 19 October 2026:

- MiniMax Token Plan reports 27% remaining in its current five-hour window and
  71% in its weekly window.
- Codex Pro reports 33% used in the primary window and a reset in about 5 days.
- GLM returns `unknown / credential_not_configured`; the running Herder service
  has no `ANTHROPIC_AUTH_TOKEN`, `ZAI_API_KEY` or `GLM_API_KEY`. Its OpenCode
  credential store has MiniMax and OmniRoute providers, not Z.ai.

Next action: configure an existing GLM Coding Plan key for the service as the
protected `ANTHROPIC_AUTH_TOKEN`, then call `model_quotas` again. The Z.ai
monitor endpoint uses the bare token in `Authorization` as its official usage
plugin does. Do not put a secret in chat or memory. Until the credential exists,
the live GLM quota remains pending; the tool deliberately reports `unknown`.
