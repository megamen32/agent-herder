# Browser V081A/B independent source review: REVISE

Reviewed immutable commit `0bbfbb2812586de9531eca8222582599d8e5302b`, `crates/herder/src/adapters/chatgpt/{read.rs,mod.rs}`; no live browser/CDP, native sends or foreign WIP changes. Tests below use an archive of this commit at `/tmp/herder-v081-review-0bbfbb28`; only extra test code was appended to that scratch copy.

## P1: malformed current branch becomes successful empty/incomplete recent

`read.rs:166,219-235`: `selected_branch` silently breaks both on absent node and on cycle; its caller returns `Ok(normalize_recent(...))` as if the source were complete. This violates `application/recent.rs`'s distinction between unavailable source and empty history and can omit an older user or assistant without any partial indication. Deterministic RED using the published conversation fixture:

- non-existent `current_node` => `Ok(RecentMessages { user: None, assistant: None, assistant_replies_to_user: None })`;
- current node's parent absent => `Ok` with only the fixture assistant and no user;
- current node self-cycle => same successful incomplete result.

Return an explicit normalization error or accurately exposed partial coverage when a referenced node is missing or revisited; preserve legitimate complete empty/root histories.

## P1: malformed list row silently makes coverage complete

`read.rs:249-255,270-276`: `filter_map` discards missing ID/title or invalid ID while advancing offset by all raw rows, and `partial` only tracks continuation. Fixture `{"total":1,"items":[{"id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}]}` yields `Ok(ChatGptConversationPage { conversations: [], next_cursor: None, partial: false, total: Some(1) })`. Thus a nonempty source is reported as complete and empty. Explicit archive/temporary filtering is a different case; malformed source rows must fail or carry separate incomplete coverage. Also source ordering uses mutable `updated` offsets; complete enumeration across changes is not snapshot-proven.

## Account and target isolation: bounded proof and open seam

`attach_via_browser` calls `attach_target` with selected target/context; `cdp.rs` validates target info and context. `list_conversations` and `recent_messages` independently compare the account scope after session lookup. Existing fake CDP tests for wrong context, account switch, provider failure, pagination and recent returned 11/11 PASS. These tests fake CDP responses rather than execute the JS or exercise real account credentials. `recent_messages` (`read.rs:112`) fetches the conversation using ambient credentials, unlike list (`read.rs:56`) which binds the observed bearer and account header; scope checked before that fetch does not by itself demonstrate that the response belongs to that account during a switch. Treat this as an unproven isolation seam, not a confirmed cross-account leak; owner should bind/verify the provider request and add a deterministic account-switch-during-fetch test before claiming isolation. Preexisting `read_conversation` likewise lacks per-read account checking, outside this commit's newly added recent method.

## Reproduction

```
# git archive 0bbfbb28 crates/herder acceptance into scratch, append four review_red tests to scratch read.rs
CARGO_TARGET_DIR=/home/roomhacker/.codex/worktrees/herder-native-adapters/agent-herder/crates/herder/target \
 cargo test --offline --manifest-path crates/herder/Cargo.toml --lib review_red -- --nocapture
# exit 101: 4 expected failures described above
CARGO_TARGET_DIR=/home/roomhacker/.codex/worktrees/herder-native-adapters/agent-herder/crates/herder/target \
 cargo test --offline --manifest-path crates/herder/Cargo.toml --lib adapters::chatgpt::tests:: -- --nocapture
# 11 passed
```

Scratch test source is `/tmp/herder-v081-review-0bbfbb28/crates/herder/src/adapters/chatgpt/read.rs` under `mod review_red`; it is disposable. No production or consumer proof is claimed. Fixes remain with Browser owner.
