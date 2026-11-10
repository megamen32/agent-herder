# Bug resolution evidence readiness — 2026-11-10

Scope: only ZCODE_INSTALLED_PROFILE_20261110 and EXTENSION_CONNECTION_LAYOUT_20261110. No registry/status changes were made.

## ZCODE_INSTALLED_PROFILE_20261110

The registry record is open with SHA 68e23fc74fc3a662fecaf3fed4b5503efd0c99b83e31f6fd23450c75c10a15da.

Text RED source: evidence/resume-20261110/terra-route.md. Exact recorded preflight result: ChatGPT, Z.ai и ZCode вернули native_read_or_coverage_failed. Exact ZCode failure detail in that same text file: у установленного adapter отсутствуют getPinnedCreateModel, verifyPinnedCreateModel и export readZcodeOfficialRunning, которые требует установленный smoke. В profile также отсутствует ключ AHAP_ZCODE_CREATE_MODEL. This is the recorded installed preflight failure; no separate raw red log exists in ART or canonical final-verification.

Text GREEN source: ART/herder-candidate/zcode-final-preflight.json (outside plan_dir, therefore not usable as relative proof_path unless copied, which this task does not authorize). Exact result: ready=true and model pin 4cc673aa-6c6a-418b-8b91-9e601fef99f6/MiniMax-M3.1-Flash$enabled; canonical mirror evidence/resume-20261110/final-verification/zcode-installed-preflight.json reports ready=true, source=zcode-native-create-model-catalog, model_effects=0.

Prepared evidence values only; bug_resolve was not called because valid red/green proof files must be relative to plan_dir and exact test output files; the RED currently exists as narrative evidence, while the final GREEN is structured JSON rather than a plain test transcript.

- red_proof_path: evidence/resume-20261110/terra-route.md
- red_result: ChatGPT, Z.ai и ZCode вернули native_read_or_coverage_failed. Для ZCode: у установленного adapter отсутствуют getPinnedCreateModel, verifyPinnedCreateModel и export readZcodeOfficialRunning, которые требует установленный smoke. В profile также отсутствует ключ AHAP_ZCODE_CREATE_MODEL.
- proof_path: evidence/resume-20261110/final-verification/zcode-installed-preflight.json
- test_command: installed ZCode native preflight via /opt/agent-herder-ci-smoke/bindings.cjs; native.zcode.preflight(); no model submission
- result: {"ready":true,"source":"zcode-native-create-model-catalog","model":"4cc673aa-6c6a-418b-8b91-9e601fef99f6/MiniMax-M3.1-Flash$enabled","model_effects":0}

## EXTENSION_CONNECTION_LAYOUT_20261110

The registry record is open with SHA ac1f6be23053e7c555e85a083756a4cb86ba89dfe015638017feb55bdf4aa3a4.

Exact gap: no text file containing the original layout RED result was found in ART or evidence/resume-20261110. The registry text ActualChromium fixture preview800px wraps Work/Personal... is a summary, not exact test output. PNG previews are visual evidence and cannot fill red_result. Final text log evidence/resume-20261110/final-verification/extension-node.log has passing named-destination tests (ok 20, ok 22) but no layout RED transcript or exact 375/800 layout assertion result. Therefore valid bug_resolve fixed arguments cannot be prepared for this bug from available text evidence. Required next evidence: recover the original text RED output or rerun the exact failing layout check and save its output as text, then pair it with the exact matching GREEN text result.

## Bootstrap final artifact refresh

Before copying, ART/bootstrap-final.log was parsed and confirmed result=PASS, checks.length=10. It is now an exact byte copy at evidence/resume-20261110/final-verification/bootstrap-final.log.

## Resolution tool validation

A `bug_resolve fixed` attempt for ZCODE_INSTALLED_PROFILE_20261110 was rejected by the registry validator: `evidence.result must document a passing check`. Registry record remains open and unchanged. The candidate GREEN value above is the exact observed JSON but does not satisfy the tool's required PASS-documenting result field; no wording was fabricated to force acceptance. EXTENSION_CONNECTION_LAYOUT_20261110 was not submitted because its exact text RED proof is absent.
