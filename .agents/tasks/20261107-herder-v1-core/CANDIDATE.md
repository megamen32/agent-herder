# V1 candidate — готов к native consumer

Source: `d66c9c0729fea2a18038fe6569625a14177a7adc` published main.
Manifest: `/home/roomhacker/herder-artifacts/releases/herder-v1-d66c9c0729fe/manifest.json`
SHA256: `2db3cc41b3411e1028ba641e1d3812369d054f01ab43cda135dd9c6ad5f454e4`

Включены browser pinnedblank264eb01c и CIreport76ec55f3. Build pipeline: committed source → cargo build core/bootstrap locked → tsc .tmp/v1-dist → versioned build-v1-core.py. Артефакт read-only, current не переключался.

Entrypoints берутся из manifest.core / bootstrap / node / adapters[harness]. Для OpenCode old-stand compatibility manifest.adapter == adapters.opencode. Native opencode binary остаётся exact approved `/home/roomhacker/herder-artifacts/releases/ahap-qocjoin-1d89d04d/fixture/opencode` SHA25facd7099c19018e83dce858f3ab922cd2d49ad29b144bc36968418ca6eb5aa; family v2.

Bootstrap CLI `<manifest.bootstrap> <fresh protected home>` → JSON database/gate/generation/profile_seed с provisionedv4. Owner profile и launch: CONTRACT.md, `<manifest.core> --trusted-owner-profile <protected profile>`. Exact ahap_env Codex: AHAP_CODEX_CWD и ровно один AHAP_CODEX_SOCKET или AHAP_CODEX_BIN; optional CODEX_HOME. HOME=owner.code_home.

Проверено: manifest hashes, повторная упаковка в existingpath отказала без изменения bytes; initialize bundled runners всех5kind. Native send=0. NEG через exactcandidate binary выполняется отдельно и будет сохранён в evidence. Это НЕ 5 native lanes и НЕ installedPASS.

Browser numbers7/9 из старого CONFIG недействительны: gateway renumbering. CI soleoperator заново проверяет exacttarget/accountscope перед action. Наши sourceworkers browser mutations не делали; old browserworker idle. Не вшивать ephemeral page numbers в артефакт.

CI sole V1installer; legacy TS current73e7aac отдельный NoticePlace installer. Нет ожидания legacyrelease.
