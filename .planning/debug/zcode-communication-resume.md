---
status: resolved
trigger: ZCode Herder synchronous root/userio calls time out; website cannot resume ZCode or send new message; fix through TDD
---

## Current Focus
hypothesis: GPTAdmin aggregate memory.high throttling caused MCP timeouts; unconditional ZCode resume reloads accepted queues and direct cold resume lacks exact workspace.
next_action: none; backend and public pinned frontend installed and real SAME-SID consumers accepted.
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

## Resolution and final acceptance (15 October)
- Website Continue uses the same durable input/outbox/background job as composer,
  with stable-ID reuse while pending/UNKNOWN. Focused RED before feature, GREEN.
- Browser exposed a second defect: SSE events incremented the request generation
  faster than native history returned. Coalesced background reads now let the
  original response unlock the editor; explicit selection/reload still invalidates
  old reads. RED regression then74/74 UI tests, TypeScript and isolated bundle
  GREEN82.92s, peak612388864B, no swap/OOM, native runner cleanup confirmed.
- Public nginx serves a pinned UI release, independent of dist/web. Published and
  installed3fc63f4 release including old hashed assets; only2 roots/source header
  changed. nginx -t and reload passed; native Herder PID436876 unchanged.
- Authenticated browser on server44 loaded the original97ae SID with history and
  writable editor; screenshot original-ready.png. No extra business input sent.
- Final public bundle BWIPqQiO: actual Continue click admitted input
  13f33bcd-709c-48f0-ae4a-e6e5de2b4970 and native assistant answered sameSID.
  A later attempt to click the old Continue selector found no button because the
  UI had already advanced to normal Send; screenshot inspected before navigation.
- Earlier diagnostic inspector cleanup caused an unintended controller crash.
  Unsupported in-place activation abandoned; standard installation at zero live
  workspace CLI, then all3 interrupted SIDs restored once with no-replay prompts.
  Actual native assistant rows verify97ae/16ae/0dd4 recovery. This was our error.
- GPTAdmin source budget/doc published separately: soft3→4GiB, hard10GiB,
  existing PID3158 and all other limits retained. No historical shell jobs deleted.
- Infra shared main had preexisting divergent foreign history and overlapping WIP.
  Published only the owned vhost blob onto remote main with a private Git index;
  identical local source blob verified. No reset, stash, foreign merge or worktree.
Evidence retained in .tmp/zcode-communication-resume-20261014 (ignored/private).
- Final ordinary browser Send input4c73e51b-6d12-4ade-95a1-31291add0394
  promoted once; actual assistant HERDER_FINAL_UI_OK_55c1 visible. Both outbox
  entries delivered. Both own browser units closed, temporary auth profile deleted.
- User extended task to desktop visibility after this outcome; tracked separately
  in zcode-desktop-visibility.md without replacing the original assignment.
