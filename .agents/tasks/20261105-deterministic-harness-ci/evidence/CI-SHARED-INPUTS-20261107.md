# Existing CI inputs — 2026-11-07

The source of truth is the individual receipt. Candidate processes below are not the installed Herder PID. No receipt authorizes a new send.

## Codex and OpenCode, deterministic candidate on server-44

Source: `origin/main` commit `c32f6083302dcf3048f9c3c0ecb70e71e51666b7`, files `tests/native/launch.py`, `test-model-server.py`, `candidate_stand.py`, `candidate_driver.py`, `herder_journey.py`, `herder_transcript_http.py`, `herder_search.mjs` and `search_proof.py`. Local fixture remains the only model endpoint in the isolated network namespace. The following exact invocation was run on server-44; it returns 2 intentionally for INCOMPLETE:

```sh
cd /home/roomhacker/.local/share/agent-herder-ci/versions/payload-proof-1f1cfcd8
python3 tests/native/launch.py --candidate /home/roomhacker/.local/share/agent-herder/fleet/releases/1f1cfcd8e98a99c0939dae4962933cecd0c1ca07 -- /usr/bin/python3 "$PWD/tests/native/candidate_stand.py" /home/roomhacker/.local/share/agent-herder/fleet/releases/1f1cfcd8e98a99c0939dae4962933cecd0c1ca07 /home/roomhacker/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex /home/roomhacker/.npm-global/lib/node_modules/@opencode/cli/bin/opencode.exe
```

Receipt on server-44: `/home/roomhacker/.local/share/agent-herder-ci/versions/payload-proof-1f1cfcd8/receipt.json`. Codex 0.167.0 and OpenCode 2.1.3: each two exact sessions, three transcript pages, exact search and two fixture requests; 7.252 seconds. Scope `isolated-candidate`; missing installed PID and other environments. `candidate_driver.py` from c32f6083 is installed in this runner; the tested product bundle is `1f1cfcd8e98a99c0939dae4962933cecd0c1ca07`.

## ZCode, deterministic candidate on server-44

Receipt: `evidence/l45-zcode-transcript-candidate.json`; observed native version 3.17.2, two sessions, project/search, two 8-page transcripts and five fixture calls; 26.645 seconds, scope `isolated-candidate-only`. Underlying exact retained receipt and candidate: server-44 `/tmp/herder-minci-01a1ac52/zcode-candidate2/receipt.json` and `/tmp/herder-minci-01a1ac52/zcode-candidate2/dist`. Product fixes include origin/main `dcb01f5e`; the exact candidate source SHA was not attested by the receipt, which carries its artifact digest instead. Driver snapshot on server-44: `/tmp/herder-l04-runner-01/run-isolated-native-ci.py` sha256 `c8946d4973fe8e39eb18114faeb7c5f5acdd1579ad356ba5a619bc02e9c6961d`, `zcode-official-probe.py` sha256 `bf4edabd131ad4cc5c860d7a72ff102d179026e83cf61e725ab331cd2db4b037`, `zcode-official-probe.mjs` sha256 `47a2ce6572bf5f4f1999be04c7320cce257358956edab3e147d20a715f577195`. Accepted CLI shape is `python3 run-isolated-native-ci.py --herder-dist <absolute-candidate-dist> --codex <absolute-codex.js> --opencode <absolute-opencode.exe> --zcode-official-root <isolated-official-server-release> --zcode-official-only --receipt <new-receipt>`. The exact previous runtime-root argument and full argv are not in the retained receipt and are not asserted; do not substitute the production ZCode profile. Recover the isolated runtime provenance before rerunning. This ZCode probe uses the real ZCode server and Herder HTTP server/adapter, but not the dist/index.js entrypoint or installed PID; its MCP search uses in-memory transport. Neither the old receipt nor the scoped PASS is a combined or installed gate.

## ChatGPT, installed browser

Installed read-only receipt: `evidence/chatgpt-installed-transcript-20261107.md`; real session `chatgpt::6aee9fd5-7ee0-83ea-a06f-a3ed148605e8`, 12 events, 3 pages, marker `HERDER_CHATGPT_CI_OK`, earlier release `3ba6e50b`. Current `1f1cfcd8` session_info returned marker; actual automatic continuation origin remains unproven (L101). Browser uses Mac Mini logged-in profile; no direct background fetch, preserve 429 backoff. The owner delegated QCHATCASE one fresh create/deliver/read; its worker must first receive exact account/context/target scope and an existing exclusive lease before using the shared target. Unknown or accepted sends must not be repeated. Until that handoff, wait.

## Z.ai, installed browser

Real test session `zai::draft%3Ab923342a-c573-449e-bff5-acb84cdd22b4`, native ID `ef57577a-fc02-4b9a-85ce-a0c4a214d887`, marker `HERDER_ZAI_CHECK_20261107_1455`. Installed server-100 `1f1cfcd8`: 30 events, 3 pages, complete=true; session_info showed last pair. The security-page auto-reload is covered by TDD but not observed during a real security challenge (L99). Do not generate a challenge or repeat an accepted send.

## Installed Codex on server-44

Normal create/read/list on `70d2ead80242f54c7d9fcd889e2ed25d549cf1fb`, PID 590955: existing empty test ID `01a1b68f-6c3d-78e0-b4d5-966ed9659e1b`, evidence server-44 `~/.local/share/agent-herder-ci/installed-probe-20261107-1508/{create,readback,filtered-list-after-70d2}.json`. No turn or model request was sent. Do not recreate it. The installed PID has no proven per-session fixture provider, and the real app-server 0.167.0 provider mismatch is documented in `evidence/codex-thread-provider-probe.md`. CIINSTALLED and CIGATEINSTALLED remain incomplete.

## Recovered exact L45 invocation

Historical invocation on server-44, recovered from the current session's recorded tool arguments and checked against surviving files (the receipt below already exists; do not rerun into it):

```sh
python3 /tmp/herder-l43-full-v16-9e80/scripts/run-isolated-native-ci.py --herder-dist /tmp/herder-minci-01a1ac52/zcode-candidate2/dist --zcode-official-root /home/roomhacker/.cache/herder-ci-research/run.7jqHXfIA/zcode-server-release --zcode-official-only --receipt /tmp/herder-minci-01a1ac52/zcode-candidate2/receipt.json
```

The exact runner SHA-256 is `a7b04ad8ad495e93e6c7f1069b494b1e49bddf7bd2606d204d2dc850894ffab0`. The isolated ZCode release still has `runtime/node`, `server-cli.js`, `server-core.js`, and `zcode.cjs`. This recovers the prior invocation and does not establish current-candidate, current-environment or installed-PID acceptance.

For repeatable candidate runs, the exact L45 runner and required 18 sidecars are copied on server-44 to `/home/roomhacker/.local/share/agent-herder-ci/versions/zcode-l45-a7b04/`; the runner hash remains `a7b04ad8ad495e93e6c7f1069b494b1e49bddf7bd2606d204d2dc850894ffab0`. The isolated ZCode 3.17.2 release is copied to `/home/roomhacker/.local/share/agent-herder-ci/versions/zcode-server-3.17.2/`; its four runtime entry files matched the source copy after transfer. The candidate gate stages its own temporary release under its own CI directory and removes that staging on completion; it does not expose the installed profile to the native driver.
