# QBROWSERJOIN: source review

- Published ancestry: main c65715df includes c9f143f2, 2a1ac842, 67fde740, 55d323b2, c3b992ff and 9c0c34f3 (original ed1acd95 → 429d39b0 → 385efc83 → d0a71185 → 76bd8325). No browser interaction.
- Direct CDP pins context/target, correlates command IDs, bounds command and connection, rejects disconnect/timeout as potentially unknown. AHAP mutation errors are marked unknown and non-retryable. Handshake defect B417e66c4fa4e4bf1a466 has saved RED/GREEN evidence.
- Mutation paths check pinned account before create and send. Source review identified B720e95cbcdcd484ab0f8: cached scope check does not establish current identity during list/messages reads. This open defect must be fixed before native browser/account-isolation acceptance; no claim that read scope is safe.
- CI checkout /home/roomhacker/.codex/worktrees/herder-native-ci/agent-herder at de8584c9 has dirty WIP in browser-chat.ts, chatgpt-mac-cdp-driver.ts and zai-cdp-driver.ts. Its transcript and inventory hunks remain there; the already published chain adds account pinning in the same ChatGPT driver, independently. No CI paths were staged or changed. Further composition requires CI owner to preserve both sets; this source review does not accept uncommitted CI WIP.
- Native case requires exact delegated target and lease; no target selected, no browser session used, no provider calls.
