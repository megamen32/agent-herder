---
status: fixing
trigger: ZCode Herder synchronous root/userio calls time out; website cannot resume ZCode or send new message; fix through TDD
---

## Current Focus
hypothesis: GPTAdmin aggregate memory.high throttling caused MCP timeouts; unconditional ZCode resume reloads accepted queues and direct cold resume lacks exact workspace.
next_action: install the two reviewed methods without restarting active native sessions, then verify SAME-SID HTTP continuation.
tdd_mode: true

## Symptoms
Expected: ZCode reaches Codex through Herder and website continues original ZCode SID.
Actual: synchronous tool timeout; resume/send fails on website.
Reproduction: reported existing airlock-admin session; use owned canaries for mutations.

## Evidence
- Main checkout synchronized initially; unrelated untracked OpenCode release artifacts preserved.
- Live service PID3787155, 1/2GiB memory, CPU4, tasks512. Host MemAvailable37GiB.
- ZCode user config routes agent-herder through existing GPTAdmin connection.
- Native source transcript confirms airlock-admin used server44 Herder to address a server100 Codex SID; local44 exact lookup returns not-found96ms.
- GPTAdmin same credentials initialize timed out8–30s while health200. Measured high3GiB/current3.27GB/fullavg6015.5%; supported live high4GiB restored initialize41–67ms, samePID3158, hard10GiB/CPU2/swap0 retained.
- New tests first RED3/3: loaded running/idle session reload and cold direct resume chose default workspace. Same proofs GREEN3/3 after minimal source fix.
- Existing staged-guide test contradicted native boundary-attribution test; aligned it to pending ACK, never false delivery or replay.
- Final focused142/142 and TypeScript candidate passed under native guard; peak647725056B, swap/OOM0, same-generation cleanup, expected60s/emergency600s.
- Native consumer: GPTAdmin created one own ZCode sess_aa101f75-ba5b-4b4c-9258-3c443762e91c. Its actual Herder MCP sent HERDER_ZCODE_OK_8a7f to this active Codex chat and native assistant confirmed success.
- Original user SID97ae is active on a finite TaskOutput wait for its own20-minute business check. Already promoted e6d541bd and queued e6615663 are preserved, never resent.
