# Контракт Herder для переносимого CI

Дата проверки: 2026-11-07. Это фактический контракт опубликованного продукта и границы исполнения, а не новый тестовый API.

## Владение
CI: runner config, tests/native, candidate/installed report, CI trigger/release integration и build-release-candidate.py (B83d137dd9a3e43ae87c1). Общие tests/native файлы сначала согласовать с Luna, которая владеет текущим OpenCode stand/export regression. Herder: Rust core, crates/herder/src/bin/herder_native_stdio.rs и подкаталог owner/profile/native_reader, AHAP runners и адаптеры. Astra: текущий LHC continuation repair. Page7 и её native sends принадлежат CI до явного resource handoff.

## Штатный запуск
```sh
"$HERDER_CORE" --trusted-owner-profile "$HERDER_OWNER_PROFILE"
```
MCP JSON-RPC stdin/stdout. Точные пути и SHA берутся из immutable manifest; они не должны становиться константами CI. HOME/XDG и native harness config задаёт изолированный runner. Model endpoint конфигурируется в native harness (для проверенного OpenCode existing write_opencode_fixture), не новым параметром core. На принятом Linux пути authority/database/gate/profile создаются существующим bootstrap; файл profile owner-only, code_home/cwd отдельные. Нельзя считать другой backend готовым только потому, что процесс запустился.

Опубликованный проверенный artifact:
`/home/roomhacker/herder-artifacts/releases/ahap-qocjoin-1d89d04d/manifest.json`
core source `1d89d04dbefec21ed355533da49bd60e11ee7114`; manifest SHA256 `cd78329317fac02fe0ae56c2f08aa9f2693ffd0422de943bf9390c218405efac`.

Existing consumer: `tests/native/ahap_opencode_stand.py` (Luna worktree `/home/roomhacker/.codex/worktrees/ahap-opencode-consumer/agent-herder`), existing isolation runner `tests/native/launch.py`. Стенд запускает public core, не приватный тестовый dispatcher. Его CLI принимает `--core`, `--runner`, `--opencode`, `--node`, `--bootstrap`; environment model fixture `HERDER_TEST_MODEL_BASE_URL`. Сохранять существующую изоляцию, а machine paths/endpoints подавать через config/manifest. Bootstrap сегодня не является универсальным product install API: переносимость других ОС и deployment bootstrap требуют отдельного доказательства Herder.

OpenCode profile owner: kind=opencode, executable=<node>, ahap_script=<runner.mjs>, ahap_base_url=<native OpenCode serve URL>, instance=<stable instance ref>, code_home/cwd=<isolated project>. AHAP_VERSION=0.1, AHAP_HARNESS=opencode; существующий OpenCode endpoint/auth берутся из scope runner, не из общей production конфигурации.

## Пять сценариев и честная готовность
| Сценарий | Обычный MCP вход | Текущее доказательство |
|---|---|---|
| Send | create(action=create, instance_ref, prompt, request_key) проверяет initial send; отдельный deliver(action=session, session_ref, message, mode, request_key) — публичный контракт | OpenCode initial send confirmed, native user message exact id; standalone deliver требует собственного результата |
| Read | session(action=messages, session_ref) | OpenCode exact user+assistant, reopen PASS |
| Full transcript | export(action=export, session_ref, format=common) | В pinned core реально unsupported/effect:none; полного export PASS нет |
| Search | search(action=search, query, ...) по текущей tools/list schema | Публичная schema есть; consumer PASS этого artifact не подтверждён |
| Projects | Отдельного projects action в pinned public catalog нет | Это недостающий продуктовый контракт, не разрешение CI вывести проекты из DB или приватного adapter API |

Перед mutation: tools/list + текущая advertised protocol/capabilities. Принятый стенд использует protocol 2026-07-28, Tasks extension и сохраняет taskId/native receipt; ожидание Tasks не подменяется sleep/повтором send. Candidate и installed используют один consumer, разные artifact/runtime manifests. unsupported, UNKNOWN, skipped и PASS должны оставаться разными исходами; gate пяти обязательных сценариев не зелёный при unsupported.

## Browser
Source runner factory ChatGPT/Z.ai опубликован4489c69b; `acceptance/native/browser/launch-contract.md` задаёт explicit transport/page/account scope. Это ещё не универсальный Rust owner-launch: current scoped_profile поддерживает codex/opencode. ZCode/browser composition принадлежит Herder. Browser native proof требует отдельного выделенного ресурса; page7 остаётся CI. Переиспользовать existing MacMiniChromeTransport/direct CDP без Vibe.

Связанные результаты: QOCREGRESSION/E002, QOCEXPORT, QZAIFACTORY, QAHAPLAUNCH. Полная последовательность send/read/export/search/projects пока не объявляется установленным результатом.
