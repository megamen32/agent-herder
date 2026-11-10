# Scoped Codex native port delta: 03eccbc2

SUPPORTED after Astra source-diff and stored live-receipt review, 2026-11-07. No replay of native send during review.

The live test now passes CodexCreateControl directly to ScopedAuthority::create_fresh_root and its native_control to admission. The test-only poll-once Future wrapper was removed. Existing native receipt lookup, HumanStop, exact-turn interruption, reopened-profile readback and denied next claim remain.

Stored evidence: review-evidence/v025port/native-bounded-20261107.txt. Native thread 01a1b555-3995-7502-8c62-e46b02dda17e, turn01a1b555-3ad5-7ca0-b741-8a98cea4bb31; isolated profile, loopback model fixture; reopened native readback interrupted; next_claim denied. Author live run 1 passed in2.69s, source suite19 passed/1ignored. Reviewer inspected source and receipt, did not repeat external effects.

Accepted boundary is scoped guard plus real bounded native ports. Public MCP/ApplicationPort/Task composition and installed v1 delivery remain separate incomplete gates.
