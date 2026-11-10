# OpenCode integration review d7b560d3

REVISE: Bbe1294ad7a834a65b0d2. OpenCodeSessionControl accepts Current with a nonempty expected_turn but does not send or enforce the expected turn. The native prompt body contains text, steer and correlation metadata only. If observed A finishes and B starts before admission, the message can reach B and return success, contrary to domain/adapter.rs exact-turn contract.

Minimal correction: before any POST reject Current with a descriptive DefinitelyNotSent/unsupported reason unless the verified native API has an atomic exact-turn precondition. A preflight GET is not that guarantee. Queue remains supported; existing live receipt was Queue and does not need replay. Persist a RED/GREEN no-POST test for Current even with a nonempty observed turn, and align capability declaration if present.

Known separate follow-up: create local validation still returns Unknown despite proven no POST; worker already owns typed DefinitelyNotSent mapping.

Reviewed baseline otherwise sends one request without retry, checks selected instance and native message/session/delivery receipt, and refuses Start without idle CAS. Seven author source tests and existing V065LIVE receipt are available. No public MCP consumer claim accepted. No native sends during review.
