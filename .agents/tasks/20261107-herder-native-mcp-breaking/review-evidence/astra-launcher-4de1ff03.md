# Launcher delta review: 4de1ff03

Verdict: SUPPORTED for local scoped authority opening within the documented trusted-root/current-UID boundary. Independent reviewer: Nietzsche, session 01a1b453-5507-7b81-ae21-6853827cef0e; Astra checked and delivered the result to Terra on 2026-11-07.

- Exact schema v3 and expected objects are validated with authority rows on one SQLite connection/read transaction. Downgraded user_version and missing v3 trigger are rejected.
- Ancestors must belong to root/current UID and forbid foreign writes; immediate parent remains private. Opened DB FD retained, pathname/device/inode checked before and after reading. pragma_database_list alone is not a file-descriptor identity proof; safety relies on the explicitly verified trusted path and excludes hostile root/same-UID changes.
- O_NOFOLLOW and O_NONBLOCK precede regular-file checks, so a FIFO without writer does not hang profile loading.
- Caller::Unknown and empty grants remain. Valid --scoped-profile negative stdio test rejects forged identity with effect=none and no intents.

Independent command in existing herder-v1-v004 worktree:

```text
cargo test --offline --locked --manifest-path crates/herder/Cargo.toml --test launcher_scoped_profile
8 passed; 0 failed; 0 ignored
```

No native sends, no tracked edits; reviewed HEAD 4de1ff03. Public ApplicationPort/Task wiring and create-deliver-read are separate gates, not proven by this review. Integration handed to Terra; no further broad review required for this slice.
