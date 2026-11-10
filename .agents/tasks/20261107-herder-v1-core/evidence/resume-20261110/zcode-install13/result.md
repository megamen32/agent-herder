# ZCODEINSTALL13 — подготовленный V1 ZCode append

## Статус

Готов standalone ZCode profile и CAS candidates для двух selectors. Shared selectors, canonical checkout, installed manifest и GPTAdmin child не изменялись. Shared install/restart оставлены Lead для отдельного lease. Model pin сохранён exact из existing approved ZCode profile.

## Артефакты и SHA256

- Manifest: /home/roomhacker/herder-artifacts/releases/herder-v1-userio-schema-2d70f4b9/manifest.json — e34aa2b906fb1b4d5c6e97cbdb4a4859b4fee6e9d500c026d96dc74ef65b5beb.
- Profile: /home/roomhacker/herder-artifacts/ci-runs/resume-browser-20261110-01a1c551/zcode-install13/herder-owner-home/authority/profile-zcode-install13.json — 84a8f58fd91873043171b5133024e13307661c5a1ea3ddd820010e94c7443620. Principal local-owner, instance zcode-local, transport official-server, pin 4cc673aa-6c6a-418b-8b91-9e601fef99f6/MiniMax-M3.1-Flash$enabled.
- Authority DB: /home/roomhacker/herder-artifacts/ci-runs/resume-browser-20261110-01a1c551/zcode-install13/herder-owner-home/authority/state.db — schema v4, search rows 0; separate gate/seed.
- Fresh NativeWorkerPort receipt: /home/roomhacker/herder-artifacts/ci-runs/resume-browser-20261110-01a1c551/zcode-install13/native-readiness.json — SHA256 3663ae036dc383b8bd623d5d54ed866e1a0a4865f213711cbdb47684026f620b.
- V1 candidate: /home/roomhacker/herder-artifacts/ci-runs/resume-browser-20261110-01a1c551/zcode-install13/v1-entry-candidate.json — 9b523a001a60f1964aa89c976288f9da9f3ec2e397cb5accbd1fc03921d788ec.
- GPTAdmin candidate: /home/roomhacker/herder-artifacts/ci-runs/resume-browser-20261110-01a1c551/zcode-install13/gptadmin-entry-candidate.json — same SHA256 9b523a001a60f1964aa89c976288f9da9f3ec2e397cb5accbd1fc03921d788ec.
- Launcher receipts both SHA256 d670fddc2282a52477c99fdef2d4855c2d70b7274e9b69fd9a64d289e874046f; both --check exit 0, five profile paths, manifest and all hashes verified.
- Existing shared selector hashes at final read: v1-entry.json and gptadmin-entry.json each 9203749046e34a8fcceca23e1ec3d45dbf3e390ad618d23d5ebd6ee9a63d6e30 (four profiles). Re-read/CAS required by Lead before install.

## Readiness proof

Fresh NativeWorkerPort.preflight through installed ZCode adapter, capability pinned_official_server_owner: ready=true at 2026-11-10T19:06:35Z. Receipt model pin source zcode-native-create-model-catalog matches the exact existing value; no create/send/archive or inference was performed. Owned native transport close returned closed=true. This resolves the prior capability mismatch; owner_active_catalog was not used for final proof.

SDK initialize/tools/list and read-only discovery succeeded earlier on temp selector but did not invoke ZCode adapter, so it is not counted as ZCode readiness. Targeted SDK session.context without session_ref did not return within bounded wait; own probe was stopped. Thus SDK context readback is UNKNOWN/unproven. It was not retried, and no other session_ref was selected because the new authority is empty.

## Install proposal

After Lead takes the separate install lease, re-read both selector hashes. If they still match this evidence, atomically replace only each selector with its candidate; this preserves all four current profiles and appends zcode-local as fifth. Otherwise recompute the append from fresh selectors and rerun --check plus SDK/native preflight. GPTAdmin child restart remains Lead-owned under the separate restart lease.

Historic approved receipt: /home/roomhacker/herder-artifacts/worktrees/resume-publication-01a1c551/.agents/tasks/20261107-herder-v1-core/evidence/resume-20261110/final-verification/zcode-installed-preflight.json. It is not substituted for the fresh NativeWorkerPort receipt above. Historical C5A archive UNKNOWN was not touched or replayed.
