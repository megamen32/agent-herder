# REGRESS10 — focused source regression results (2026-11-10)

Scope: current `main` source/tests only. These are **not installed acceptance**. No model/native/browser sends or runtime mutations were performed. TEST_ACCESS was read at `.agents/TEST_ACCESS.md`; this run used local test fixtures only, no provider turns. Existing dirty plan/lead/bug-ledger files and unrelated untracked records were preserved.

## Environment and command record

- Checkout: `/home/roomhacker/agents-projects/agent-herder`, HEAD and `origin/main`: `1fcac12e511d17d203ab8a08fb662f2a1f7b46b1`.
- Available memory: 39 GiB; free disk on `/`: 288 GiB. (Measured `free -h`, `df -h . /home`.)
- Immutable Node: `/home/roomhacker/herder-artifacts/releases/herder-v1-restore-a3812e2c/fixture/node`, version v22.22.2, SHA256 `81925c0995b5c1427b5d538e6a90ca2fdc4daffb786b09af749beaf7369d4e90`. System Node is also v22.22.2 but was not used for TS tests.
- Initial wrong-cwd attempt `cargo test -p herder --lib` from repo root: **exit 101**, no tests run (`could not find Cargo.toml`). Corrected to the crate manifest below.

| Command | Working directory | Exit | Result |
|---|---|---:|---|
| `cargo test --manifest-path Cargo.toml --lib` | `crates/herder` | 0 | 203 passed, 0 failed. Includes core/domain completion, authority, adapter, store and Codex create tests. Known `ETXTBSY` did **not** reproduce. One compile warning: `owner_policy::is_member` dead code. |
| `cargo test --manifest-path Cargo.toml --test automation_wake` | `crates/herder` | 0 | 1 passed, 0 failed (`public_create_list_reconcile_replay_and_humanstop_are_durable`). |
| `cargo test --manifest-path Cargo.toml --test oauth_authority_contract` | `crates/herder` | 0 | 1 passed, 0 failed (`subject_survives_verified_grant_and_old_connection_rechecks_revocation`). |
| `cargo test --manifest-path Cargo.toml` | `crates/herder-compat` | 0 | 5 passed, 0 failed, 1 ignored (requires explicitly built native stdio binary); compat contract/first call/handshake/launcher targets. |
| `/home/roomhacker/herder-artifacts/releases/herder-v1-restore-a3812e2c/fixture/node node_modules/vitest/vitest.mjs run tests/ahap-opencode-runner.test.ts tests/ahap-zcode-runner.test.ts tests/ahap-browser-runner.test.ts tests/ahap-codex-runner.test.ts --reporter=dot` | repo root | 0 | 4 files / 105 passed. Node emitted only its ExperimentalWarning for SQLite. No browser was opened. |
| `python3 -m unittest -v test_candidate_release_gate` | `tests/native` | 0 | 37 passed. |
| `python3 -m unittest discover -s tests/native -p test_candidate_release_gate.py -k vibe -v` | repo root | 0 | 15 Vibe validator focused tests passed. |

Cargo commands were started concurrently and reported Cargo cache/build-directory lock waits; they completed normally. No test invocation remained running.

## Known Codex create bug B77878108142345f69820

The Codex create unit test ran within the 203-test `herder --lib` suite and passed. The known `ETXTBSY` was not reproduced, so I made no changes under `crates/herder/src/adapters/codex/create.rs`; no RED/GREEN source fix is warranted from this run. Bug remains `open` until the Lead elects a specifically targeted deterministic reproduction or accepts existing repeated-run evidence. No production edit occurred.

## CIVIBE_REQUIRED_EVIDENCE — current evidence and Lead CAS candidate

The requested canonical old RED evidence path exists: `.agents/tasks/20261107-herder-v1-core/evidence/ci-visible-20261109/red.log` (SHA256 `543edd052dfc7f8732bb23eaa3a19870782f4dfd01f68bf3f853bca95abbe4ac`). Its paired `.agents/tasks/20261107-herder-v1-core/evidence/ci-visible-20261109/red-result.json` records RED exit 1, source SHA `b38ce856ce2074181515cdaf64e17253c5d178200ac7741a76de7e2083939850`, test SHA `f571bb8db695dcefd24723770492b790c117a8387c1d4b2757f5981a784ac623`. The old GREEN receipt `.agents/tasks/20261107-herder-v1-core/evidence/ci-visible-20261109/green-result.json` records exit 0 at source SHA `092b143faa8a280e1b8b7aee30ef80c85b30fb77a8fc644ee0c99d0cb0c331ba`; both source revisions predate current main.

Fresh focused release-gate unit validation on this main:

- Exact Vibe command above: exit 0, 15/15 passed.
- Full `test_candidate_release_gate` command above: exit 0, 37/37 passed.
- Current `tests/native/candidate_release_gate.py` SHA256 `1c046e773b69021812b356aacae434ab4fdd769c0013236c673275fd3eaf0397`; current `tests/native/test_candidate_release_gate.py` SHA256 `39a7c91a4e0f44ef711824a572562972189dce0c429c5b5cbaad11facb008a8a`. Both are tracked/clean at this checkout; existing source identity receipt `evidence/ci-visible-20261109/collector-final-v3/source-identity-result.json` records these same hashes.
- Current evaluator requires bound Vibe transport/run/lane, exact native↔UI session ID, receipts, known matching state and complete native visibility evidence; tests reject missing, mismatched or partial proof. This demonstrates source validator behavior, not that any installed report/browser evidence is now valid.
- Existing historical `release-final/acceptance-summary.json` is source build/release-candidate only and says artifact `installed=false`; it is not installed proof.

**Lead decision needed for bug resolve:** the narrow validator regression is covered by current focused GREEN, and source already includes the validator correction. The requested old RED SHA is retained; no new RED was manufactured by reverting source. Prepared CAS fields (not applied): `bug_id=CIVIBE_REQUIRED_EVIDENCE`, `expected_status=open`, `expected_updated_at=2026-11-08T22:51:58+00:00`, `expected_bug_object_sha256=b2dac44bc45f9410d11ed46a972c63e474fa83a9c996e28c6cb549b610439f73`, `expected_ledger_sha256=341fc84dd2616a0a8962f7038d4602d2a04b5fb31d2fd0376a0d9f7ba2be1772`, proposed `kind=fixed`. Proposed evidence payload: old RED path + SHA/source SHA; fresh Vibe focused GREEN command/exit/15 passed + current source/test SHA; full gate unit command/exit/37 passed. On CAS mismatch Lead should reread current bug/ledger and decide anew. Do not infer installed/browser wiring from this narrow defect fix. I did not call `bug_resolve` or edit `.lhc-bugs.jsonl`; concurrent unrelated bug registrations occurred in that ledger during this run.

## RESTORECORE / RESTORECONTRACTS status correction

I retract the earlier conclusion that the later public wake/cross-host wiring was absent. `evidence/finish-20261108/native-wake-final.md` and `native-wake-confirmed.json`, together with leaves `COREWAKE=done` and `REMOTEFULL=done`, supersede the earlier draft `restore-core-luna.md` for those paths. Current `main` focused evidence adds core library 203/203, wake 1/1, authority 1/1, and compat 5/5 (1 ignored); `RESTORECORE` acceptance is its stated first pure-functional public slice, with live wake handled by COREWAKE. Its result should cite the actual source/test slice and installed/live COREWAKE proof; do not re-open already proven wake or remote acceptance. `RESTORECONTRACTS` must likewise be assessed from the later actual consumer contracts and receipts, not the early readiness draft alone; these regression runs are supporting source evidence, not installed acceptance.

`NPIDENTITY` and `NPLIVEFINAL` were re-read from current source leaves: both already have `status=done`. No status change is requested. `RESTORECORE` acceptance was also re-read: recommend MCP `done` for its first pure-functional public slice, citing current core tests and COREWAKE public/live wiring; do not re-open completed wake. `RESTORECONTRACTS` remains `running` pending integrated three-consumer contract proof through the installed shared Rust-core route; individual wake, remote44 and NoticePlace receipts remain accepted scoped results.

No source, test, plan, leaf, bug object or runtime was changed in this run. No commit made; integration/publication remains Lead-owned. Model cost/token usage: **unknown** (not measured).
