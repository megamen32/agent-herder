# L35 Browser Chat transcript

RED: `evidence/l35-red.txt`, `vitest run tests/integrator-transcript-browser.test.ts --config vitest.config.ts` on the L33 v5 source snapshot, failed with `unsupported native JSONL harness`.
GREEN: `evidence/l35-green.txt`, same test and existing `tests/integrator-transcript.test.ts`: 25 passed. TypeScript build output: `evidence/l35-build.txt` (empty, exit 0).

Candidate: L33 v5 snapshot plus `src/integrator-transcript.ts` SHA256 c71bab5ec501db2023aaf91a5a33015168bb9fedc488a2b30cf935f9ea1385d2, compiled by tsc into `.tmp/l35-candidate`. Tested payload digest v2 cb27bf364cdf8474998bb7e66723c58b687a7108d706b0fc73f69083b811b1ee; digest excludes node_modules. Candidate was not installed.

`evidence/l35-fixture.json` is the isolated Chrome+Herder fixture receipt, `evidence/l35-fixture.log` is stderr. Network namespace differs from host and contains only loopback; an outside request was blocked. Two fresh test sessions each yielded question and answer on two complete pages through `/transcript`; cross-session cursor returned 422. The candidate's browser fixture validator returned no errors. This is not a real ChatGPT account or installed service.

The existing Browser fixture lacked `/backend-api/conversation/{id}` required by the native full JSON export. For this run only, `.tmp/l35-candidate/scripts/native-hermes-browser-fixture.mjs` adds that endpoint returning the two submitted fixture messages as a current-node mapping, and switches imports to candidate dist. That fixture adjustment remains in the temporary candidate, not the shared CI script owned by another worker. The candidate must incorporate that fixture adjustment for a repeatable unified run.
