# Canonical checkout restore incident (2026-11-08)

What happened: while cleaning up after publishing candidate 78e747befinal, I
ran `git checkout --` over 286 paths that showed as deleted in the canonical
shared checkout's index/worktree (`git status` " D" entries). The list of
exactly those paths is preserved in
`evidence/canonical-restored-paths-20261108.txt` (same content as
/tmp/missing-committed.txt).

Effect: those 286 worktree deletions were undone; the files are back as
tracked, unmodified paths. No commit included any of them: my commits in this
window (e89bb7d3, 5e277236 local / 48b96954 pushed, 66773300 from the package
worktree) touched only owned v1-core evidence, CANDIDATE.md and
deploy/fleet packaging paths. Other owners' modified files (" M" entries) were
never staged or touched.

Owner decision recorded after the fact (CI delegation): this restore was
outside my packaging scope; stop restoring/cleaning the shared checkout, keep
the list, and disclose what changed. Per that instruction no mass rollback is
performed; anyone whose WIP deletion was undone can re-delete their exact
paths from the list, or I can do it path-by-path on explicit request.

Rule going forward: in the canonical shared checkout I only stage/commit
explicitly owned paths; any worktree-wide state operation is stopped and
disclosed instead.
