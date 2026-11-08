# Current candidate 71b357f8core

Published source 7ee42db728ed50f731e80e61c2a7bb7ef1a7328c (owner_reads
projects discovery regression; supersedes the 814759a9 core for new
operations). Immutable manifest
/home/roomhacker/herder-artifacts/releases/herder-v1-71b357f8core/manifest.json,
SHA256 a451e1088169419913f6010306f3611767042b0fdaa1da85c87fb62226cfa0c4.
Exact component SHA256: core 71b357f8b710e0fe484d36c3f7c0a9124853940052aea4508a736d4c2b828569,
bootstrap e9f5ea6424794a42583a2c25352f1e30b5bfcf8453672b341855fb0da71c734c.
Adapters unchanged from 814759a9 (browser 2e446c4c correlation bundle).
Rust lib 182/182 PASS, launcher_scoped_profile 17 PASS, bootstrap
test_bootstrap.py PASS (schema v4, 10 checks), test-build-v1-core.py PASS
(all-component-hashes, duplicate-refusal, five-harness initialize, zero
native launches/mutations/browser connections). Exact packaged core
negative gate 5/5 PASS via HERDER_V1_CANDIDATE_BINARY, run log
evidence/candidate-negative-71b357f8core.log (SHA256
a8bcff2b1dfcc83501fa0f08541f70c65f579ce917b4eb007a315ac776b3ca6e).
discover(projects) after authorized registration now returns count=1 with
source authorized_native_session (Archimedes evidence 05:58). These are
source/candidate proofs, not native 5-lane or installed proof; no
installation or runtime switch before exact-digest lanes plus NEG.

# Previous candidate 814759a9

Published source 814759a9248df707f974168f8fb57ba56280ec6b. Immutable
manifest /home/roomhacker/herder-artifacts/releases/herder-v1-814759a9248d/manifest.json,
SHA256 83f5593155f11f7216dd6f36d81190025daef01fc73574fdda30b0e405977385.

Includes browser adapter 2e446c4c native input correlation. Rust core includes
the intervening reviewed fixes 1f586e2f, 561951cc and 508500ed; exact candidate
core SHA256 is 3d21813f041f2388ed4f060d7df94f880ecbb6532e7e99da2a305aa59c3539ae.
TypeScript build and test-build-v1-core.py with this manifest PASS. Exact
packaged core negative gate: 5/5 PASS, run log
evidence/candidate-negative-814759a9.log (SHA256
83829757d2c31985fac4d05708dc946da4a19d50339d710077e004c36e53479b). Checks
used the public stdio consumer with isolated fake AHAP; they are not native
provider or installed proof. Candidate matrix remains incomplete: the second
ChatGPT deliver on the retained test session was refused with effect:none before
send (CI receipt /home/roomhacker/herder-artifacts/ci-runs/ci-chatgpt-native-5ea-0110/second-deliver-receipt.json,
SHA256 97f8a28651db98d84a98d5a4839f8fd0930ac398a615a9fd36b06c325a0404eb).
CI is fixing the ChatGPT runner state transition. No installation or runtime
switch before exact-digest 5/5 native lanes plus NEG PASS.

# Previous candidate 5ea28f51

Published source `5ea28f51838fcfc3230006a8709090f08009a47f`. Manifest `/home/roomhacker/herder-artifacts/releases/herder-v1-5ea28f51838f/manifest.json`, SHA256 `a5d62e9d973f8b37aa7aee3a39e96dfa85aac86dc5dd50502ea30f47e3edf998`.

Includes exact typed Codex prewrite quota refusal (b102a0b6+561951cc), browser outer deadline120s (508500ed), verified account before passive init with sanitized stage (88f81409), CI driver verified-account cache write (e4c5edb6). CLI deadline remains20s; original UNKNOWN intents never reclassified or replayed.

Source tsc+Rust build PASS. Package component hashes, duplicate-output refusal and five advertised initialize responses PASS; zero native/browser calls in that package check. Exact packaged core NEG5/5 PASS: `evidence/candidate-negative-5ea28f51.json`. Independent FIXQ source critique PASS. These results are NOT native5lane/installed proof.

Full ChatGPT case is blocked PREMUTATION on the uniquely created page8: no working composer, account auth_timeout10s, no acquired QA claim. CI owns recovery of this same target; original create/send counters remain0. Receipt: CI/evidence/chatgpt-5ea-blank-scope-blocker.json.

Actual ChatGPT public core readonly preflight PASS14tools/PREFLIGHT_READY, native_sends0: CI/evidence/chatgpt-5ea-receipt.json. This proves startup only. CI accepted next full ChatGPT lane assignment `astra-v1-chatgpt-native-next-20261107T2128`, exact owned blank target required.

CI accepted handoff `astra-v1-candidate-5ea28f51-20261107T2125`. CI owns next exact ChatGPT readonly init, all native effects and sole V1 installation. Current native matrix remains INCOMPLETE; installation closed. Source fixture repairs do not resolve historical UNKNOWN. Deadline08.11 00:38MSK retained.

# Historical candidate a836a7dc

Manifest `/home/roomhacker/herder-artifacts/releases/herder-v1-a836a7dcdfc1/manifest.json`, SHA256 `f1e99e12393eb3de9d92fa05f00df63d0270d74643b18e2d774a0aa8941022c7`. Supersedes d66c9c07 for new operations; old accepted/UNKNOWN receipts retained without replay. Browser init explicit account verifier; ZCode `AHAP_ZCODE_TRANSPORT=official-server`, `AHAP_ZCODE_CWD`, owner.code_home holds supervisor HOME/.zcode/server/run. Do not combine with custom SERVER_NODE/ENTRY.

# Historical candidate d66 — retained evidence

Source: `d66c9c0729fea2a18038fe6569625a14177a7adc` published main.
Manifest: `/home/roomhacker/herder-artifacts/releases/herder-v1-d66c9c0729fe/manifest.json`
SHA256: `2db3cc41b3411e1028ba641e1d3812369d054f01ab43cda135dd9c6ad5f454e4`

Включены browser pinnedblank264eb01c и CIreport76ec55f3. Build pipeline: committed source → cargo build core/bootstrap locked → tsc .tmp/v1-dist → versioned build-v1-core.py. Артефакт read-only, current не переключался.

Entrypoints берутся из manifest.core / bootstrap / node / adapters[harness]. Для OpenCode old-stand compatibility manifest.adapter == adapters.opencode. Native opencode binary остаётся exact approved `/home/roomhacker/herder-artifacts/releases/ahap-qocjoin-1d89d04d/fixture/opencode` SHA25facd7099c19018e83dce858f3ab922cd2d49ad29b144bc36968418ca6eb5aa; family v2.

Bootstrap CLI `<manifest.bootstrap> <fresh protected home>` → JSON database/gate/generation/profile_seed с provisionedv4. Owner profile и launch: CONTRACT.md, `<manifest.core> --trusted-owner-profile <protected profile>`. Exact ahap_env Codex: AHAP_CODEX_CWD и ровно один AHAP_CODEX_SOCKET или AHAP_CODEX_BIN; optional CODEX_HOME. HOME=owner.code_home.

Проверено: manifest hashes, повторная упаковка в existingpath отказала без изменения bytes; initialize bundled runners всех5kind. Native send=0. NEG через exactcandidate binary PASS: evidence/candidate-negative-d66c9c07.json; пять checks для пяти fixturekind, native lanes не подменены. Это НЕ 5 native lanes и НЕ installedPASS.

Browser numbers7/9 из старого CONFIG недействительны: gateway renumbering. CI soleoperator заново проверяет exacttarget/accountscope перед action. Наши sourceworkers browser mutations не делали; old browserworker idle. Не вшивать ephemeral page numbers в артефакт.

CI sole V1installer; legacy TS current73e7aac отдельный NoticePlace installer. Нет ожидания legacyrelease.
