# ZCode archive receipt: source and fixture verification

Scope: `tests/native/v1_zcode_stand.py`, `tests/native/test_v1_zcode_stand.py`.
No native consumer, real provider, browser, shared-runtime change, commit or push.

## Historical evidence

`zcode-5ff-command.json` invokes the stand in the `herder-zcode-v1-ci`
worktree with `--retain-on-failure` and candidate manifest
`9fc6f17e7b5c43b1a9208a2a60edc461d5d38c6357e19946892dbded50af1dfb`.
Both that stand and this slice's starting stand proceed directly from
restart/readback to PASS: there is no archive RPC. The emitted allowlist also
omits archive evidence. `zcode-5ff-result.json` has no archive fields.
The command's retained root no longer exists. The launcher removes successful
roots. Historical PASS therefore does not prove archive; no receipt was invented
or historical operation repeated.

## Change

After restart/readback, persist PARTIAL plus the exact archive request key and
UNKNOWN placeholder before one `session(action=archive)` call for the fixture's
session. Persist the complete returned wire reply before checking it. PASS
requires no error, `archived=true`, `effect=confirmed`, and matching `session_ref`.
Export the complete reply, attempted flag and request key in ordinary stdout
report evidence, so successful-root deletion cannot discard them.
Transport failure or an unconfirmed/mismatched reply prevents PASS and is not
retried; existing launcher failure retention preserves the local evidence.

## Verification

Command: `python3 -m unittest discover -s tests/native -p test_v1_zcode_stand.py -v`

- RED: `zcode-archive-red.log`; archive was never called (four failing assertions
  across two tests/subtests).
- GREEN: `zcode-archive-green.log`; 14 tests run, 13 passed, one environment-gated
  runtime test skipped. Full fixture consumer path checks archive after
  restart/readback and report survival after temporary root deletion. Negative
  cases cover UNKNOWN, wrong session, and transport exception with one attempt.
- `git diff --check` passed for both source files.

This is source/fixture proof only. Next acceptance: a fresh isolated local fake
model consumer using the supplied final candidate and a new unique root; retain
its full stdout report including actual `evidence.archive`. Historical receipts
and previous native instances remain unchanged.
