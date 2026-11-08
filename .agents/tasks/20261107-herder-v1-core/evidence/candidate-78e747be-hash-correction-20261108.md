# Hash correction for 78e747befinal handoff (2026-11-08)

My delivery 1a8ea640 wrongly said the opencode adapter bundle equals the
805fd477final bytes and omitted that bootstrap changed. CI read the manifest
(bf570d10) and corrected it; verified here against both manifests:

- core c1952779... is identical to 805fd477final (6237dca1 is a TS adapter
  fix, not a Rust core change).
- bootstrap changed: 21d7002c71689c4302e3d9724786e016ae4872ef7a7e0c7753da86cceb38312e
  (805fd had e9f5ea64...).
- compat 8a5b4df2979913978a17d136c43a3cb3f1b4eba042012d96d9322cd2dfc09d46.
- All four adapter bundles changed from 805fd: opencode
  5602c6290d2c44c3a034c80ef50558930aa28c064bfc06a00434345ac4c912bf, zcode
  607825f66cd4f97acd68439951ba7038b6355f3fd81034c204abd380681cfc91, codex
  36bbb17746ec57e687209c1071eee04f6ca794ea49a46b935884cca429b8ae46,
  browser/chatgpt/zai
  ee8f450552c53216029bca7687e1bec0aa736ebaa842247c76ae6667c3c903bb.

Consequence per CI: no digest reuse; CI already re-ran native and packaged
compat consumer proofs on 78e747, both PASS. Sole installer remains CI
session 01a1ac52. Next bundle waits for CI's next ready fix; browser owner
is CI (2dee96ca published, live ChatGPT full case not yet PASS, API 429).

