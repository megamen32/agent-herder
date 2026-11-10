# B83 RED — 2026-11-07 18:31 UTC

Command: `python3 tests/build-release-candidate-config.test.py`

Working directory: `/home/roomhacker/.codex/worktrees/herder-session-info/agent-herder`.
New regressions were added before modifying production builder source.
Observed tool output chunk `159ab6`, exit 1:

```text
FAIL: test_assemble_does_not_install_into_an_empty_catalog
AssertionError: True is not false
FAIL: test_assemble_preserves_live_pointer_and_config
AssertionError: PosixPath('releases/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') != PosixPath('releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
FAIL: test_rebuild_of_active_release_refused_before_moving_bytes
AssertionError: RuntimeError not raised
Ran 5 tests in 0.280s
FAILED (failures=3)
```

These tests invoke the real assemble function on disposable directories. No runtime service was changed.
