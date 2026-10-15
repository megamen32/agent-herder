---
status: complete
---
# One executor and shared native state: accepted 15 October 2026

The direct human extension selected the repair of both native hosts: one executor
per session, identical Desktop/Herder state and independence from the caller.
The paired source adapter is published and installed, with protected rollback.
Herder436876, SDK437103 and Desktop1430106/1431671 retained their process
generations. Only the Desktop renderer was reloaded, after verifying empty
composers. Original user work was neither stopped nor replayed.

## Defect and repair

The native SDK and Desktop each owned a separate service collection. The original
SID sess_155597f8-bb54-42f3-b16a-8807e8ac2ff7 had overlapping original and Desktop
continuation turns. The exact cause of the user's observed stop was not established
by those logs; the separate executors and divergent runtime state were confirmed.

Private Unix endpoints now attach consumers through the real native connection
scope to the selected existing executor. New Desktop sessions use Herder; active
legacy Desktop executors stay where they are. Two active owners or uncertain
ownership refuse implicit execution. Disconnect only releases subscriptions and
connection scope. Forwarded Desktop sessions are excluded from SDK process
attribution and SDK shutdown checkpoints. Commands are never automatically retried.

## Actual consumer acceptance

A fresh native Codex caller01a13ed0-ea96-7cc3-8744-6f6ef0fb12ae itself created
ZCode sess_ace22e73-c316-4ca8-9237-29e40107e3f1 through registered MCP. The caller
was stopped at12:08:04.851MSK; its native turn is recorded as interrupted. The
child retained turn_843b5beb-bf81-4d0e-af2f-dc1f58bc6f49 and completed at
12:09:36.723MSK,91.872 seconds later, without another prompt.

Native database readback: exactly one input, one completed Bash tool and one
assistant final SHARED_EXECUTOR_OK_323. The actual Desktop showed the running
tool after the caller stopped, then the final result and Send button through live
events. It did not load a local executor: Desktop raw existing-only probe remained
absent, SDK raw probe was present, and both routed views had the same running
turn/revision2/eventSeq99. Final routed views also matched (revision3/eventSeq144).

Secret-safe evidence under .tmp/zcode-independent-lifetime-20261015/:
case2-lifetime-acceptance.json, case2-parent-final.json,
case2-child-before-stop.json, case2-child-after-stop.json,
case2-shared-owner-state.json, case2-native-once-proof.json,
shared-child-running-after-caller-stop.png, shared-child-completed.png.
Both screenshots were inspected. The original Desktop selection was restored.
Own fixtures retain history with autopilot/autostart disabled; archive is
unsupported and was not forced. Foreign OpenCode release artifacts were preserved.

## Verification and its limits

| Scenario | Category | Defect detected | Expected / emergency seconds | Result |
|---|---|---|---|---|
| Six Unix-socket regression cases | Focused integration | Duplicate load, split ownership, lost events, disconnect cancellation, conflicting owners | 5 / 50 | 6 passed |
| Two selected existing adapter/lifecycle cases | Focused integration | Invalid native message limit and forwarded Desktop process attribution | 5 / 50 | 2 passed |
| Exact staged SDK/Desktop parsing | Fast unit | Native-source syntax/target drift | 5 / 50 | Passed |
| Actual native caller stop + Desktop live state | Focused integration | Child cancellation, second executor or missing live completion | 60 / 600 | Passed; controller137.798s |
| Same read-only native state assertion, original then routed services | Focused integration | Divergent Desktop/Herder native state | 5 / 50 | Original exit1, shared exit0 |

The implementation preceded the new regression tests: this was **not strict
test-first TDD**. The final RED/GREEN is a post-implementation regression proof
against the preserved original native services and the routed production services,
using the same assertion without loading or sending to a session. It does not
retroactively establish test-first order or full prepatch UI replay. Receipt:
native-red-green.json; logs native-shared-state-RED.log/GREEN.log. Reusable reader:
scripts/canary-zcode-shared-state.mjs.

Source checks peaked at233390080 bytes, persistent install189661184, native
controller66908160; no swap or OOM, native cleanup confirmed. Source jobs used the
existing guarded project profile, CPU1/tasks128, RAM512MiB (selected source
integration up to1GiB), swap0, private temp256MiB/20000files/IOWeight10, and live
host/UID reserves. Existing sealed native cgroups were retained. No broad suite.

Earlier failed attempts remain evidence: messageLimit0 violated the real native
schema and was fixed to1; the initial source-socket test exceeded the Unix path
limit and its harness was corrected. Neither is claimed as behavioral TDD RED.
The first native Codex case completed its child before caller stop and is not
counted as caller-survival acceptance. The earlier subprocess-SIGKILL case did
finish29.561s after caller death; the final native Codex case above is stronger.

## Persistent delivery

Reviewed sources: integrations/zcode-desktop/{shared-session-service.mjs,
shared-session-service.test.mjs,stage-shared-session-service.mjs,
activate-shared-session-service.py}, src/adapters/zcode.ts and selected tests.
Future-start Desktop ASAR, SDK server and Herder adapter dist contain the same
reviewed change. Protected original archives remain in
/var/backups/zcode-desktop/shared-sessions-{sdk,desktop}-20261015.
Persistent receipts: persistent-install.json and adapter-dist-activation.json.
This bounded task does not complete or reset the separate fleet/Mac milestone.
