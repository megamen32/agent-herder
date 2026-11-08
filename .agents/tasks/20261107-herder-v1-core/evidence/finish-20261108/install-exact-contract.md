# V1: точный контракт отдельного installed entry

Проверено 08.11.2026 около 18:39 МСК, source
`54f937063e5c603bec30b91be02de170a176f63c`.
Только source/metadata/file hashes; install/deploy, запуск V1, browser/native RPC,
изменения legacy runtime и чтение секретных значений не выполнялись.

## Решение для интегратора

Готового V1 stable entry/installer в проверенных source/config путях нет.
Достаточно существующего immutable manifest `launch_compat` + одного тонкого
exec-wrapper, зарегистрированного отдельным stdio MCP server `agent-herder-v1`.
Один запуск wrapper → один compat → один Rust core → несколько существующих
AHAP runner subprocesses. Новый daemon, scheduler, HTTP proxy или fleet manager
не требуется. Повторные независимые MCP подключения создадут дополнительные core:
это stdio per connection, не глобальный singleton. Не регистрировать один набор
активных profiles параллельно в нескольких клиентах ради «единственного core».

Sole installer — integrator `01a1bb0c-4fd3-75e2-ae2a-2c18a99462de`.
Это уже отражено в последних разделах CONTRACT, CANDIDATE и INSTALL leaf;
старые CI-only формулировки исторические. Acceptance gates exact artifact/lanes
сохраняются; этот отчёт не разрешает объявить непрошедшие browser lanes PASS.

## Что существует фактически

| Объект | Проверенное положение |
|---|---|
| Последний найденный bundle | `/home/roomhacker/herder-artifacts/releases/herder-v1-54f93706-diagnostic` |
| Manifest | `<bundle>/manifest.json`, SHA256 `91610caa9295935ef51a019b2de8bfc106718f2ae75d9990249dd9f897e8d861` |
| Native entry | `<bundle>/fixture/herder_native_stdio` |
| Ordinary consumer entry | `<bundle>/fixture/herder-compat` |
| Node | `<bundle>/fixture/node` |
| Provisioning only | `<bundle>/fixture/ahap-owner-bootstrap` |
| ChatGPT и Z.ai | общий `<bundle>/fixture/ahap-browser-runner.mjs`, harness выбирается profile kind |
| Остальные AHAP | `<bundle>/fixture/ahap-{opencode,codex,zcode}-runner.mjs` |
| Existing legacy service | user `agent-herder.service`, active, WorkingDirectory `/home/roomhacker/agents-projects/agent-herder`, ExecStart `/usr/local/bin/node %h/agents-projects/agent-herder/dist/index.js` |
| Existing Codex MCP | `/home/roomhacker/.codex/config.toml`, `[mcp_servers.agent-herder]`, HTTP `/mcp` на `127.0.0.1`; это legacy entry |
| Repo MCP | `.mcp.json` agent-herder HTTP, `mcp.json` agent-herder streamable-http |
| Предлагаемый stable command | `/home/roomhacker/.local/bin/agent-herder-v1`: сейчас отсутствует |
| Предлагаемый selector config | `/home/roomhacker/.config/agent-herder/v1-entry.json`: сейчас отсутствует |

Последние два пути — предложение к применению parent, не существующая установка.
Проверенный artifact root содержит releases/ci-runs/retained; installed/current V1
pointer там не обнаружен. CANDIDATE header ещё на aa111101 и не является выбором
последней сборки: конкретный manifest и его hash приоритетны для проверки bytes.

Проверены хеши фактических файлов последнего manifest, все совпали:

| Component | SHA256 |
|---|---|
| core | `e82a83532d18025819b99a949774b209241178068c568f6c1882954bf4b48ddf` |
| compat | `0987d70addacc790534a6079be2a7871f35808c25b34b66faa0aebf1aaf3bec3` |
| node | `81925c0995b5c1427b5d538e6a90ca2fdc4daffb786b09af749beaf7369d4e90` |
| bootstrap | `21d7002c71689c4302e3d9724786e016ae4872ef7a7e0c7753da86cceb38312e` |
| browser/chatgpt/zai | `5d43c3be778f5dcca604a56d51c1c477d5f7f83c4d67387b49a504c87e66b112` |
| opencode | `fc979e24434590a86f0496f5c772da918b487a89e9ecc071a969ec39a44813ed` |
| zcode | `64966d048fc5e36a256558dc8acbb3287ce3cdd90278603638eac9a33df5f4a7` |
| codex | `423df84c83002831ad0605c395a86db428de057c686c2982e6a851b39234517c` |

Бинарники mode0500, bundle0500; profile0600. Эти права не защищают от владельца
того же UID, поэтому readback hashes обязателен. `source_commit` — provenance,
packager прямо отмечает prebuilt inputs: commit name не заменяет component hash.

## Существующий command/profile contract

`deploy/fleet/build-v1-core.py:110` пишет абсолютные пути и templates:

```text
launch = [manifest.core, "--trusted-owner-profile", "{protected_owner_profile}"]
launch_compat.argv = [manifest.compat, "--trusted-owner-profile", "{protected_owner_profile}"]
launch_compat.env.HERDER_NATIVE_COMMAND = manifest.core
```

Для двух profiles: подставить первый placeholder и добавить ещё одну пару
`--trusted-owner-profile <second-profile>`. Не синтезировать другой protocol:
core уже принимает повторяемые пары в `crates/herder/src/bin/herder_native_stdio.rs:44`.
Compat передаёт все argv без shell (`crates/herder-compat/src/main.rs:14`).
Комментарии «one profile» в packager/compat старее реализации повторяемых argv;
текущий CONTRACT это явно уточняет. Native protocol2026-07-28; ordinary compat
edge2025-06-18, native tools плюс доступные compat helpers. Tasks read для legacy:
`compat_task {action:"get", task_ref:...}`, не raw native tasks/get.

`--config` не заменяет owner profile: эта ветка создаёт ConfigApplication
без owner identity и не даёт готовую multi-AHAP композицию.

Profile top level: `database`, `gate`, `generation`, `owner`.
Owner: `principal`, `node`, `instance`, `kind`, `executable`, `ahap_script`,
`code_home`, `cwd`, optional `ahap_base_url`/`ahap_env`.
Для AHAP `executable` = manifest.node, `ahap_script` = manifest.adapters[kind].
Один principal для всего набора, уникальные instance IDs, ahap_script у каждого:
`owner_multi.rs:98` проверяет весь набор до adapter startup.
Отдельные authority/store/home/account bindings сохраняются. Kind/harness не
выводится из имени файла, общий browser runner обслуживает chatgpt и zai.

Проверенные existing profiles двух account из старого прогона:

```text
/home/roomhacker/herder-artifacts/ci-runs/multi-chatgpt-aa111101-1803/0/herder-owner-home/authority/profile.json
/home/roomhacker/herder-artifacts/ci-runs/multi-chatgpt-aa111101-1803/1/herder-owner-home/authority/profile.json
```

Оба principal `qa-multi-browser`, node `qa-controller`, instances
`chatgpt-profile-0`/`chatgpt-profile-1`. Они указывают на aa111101 executable/runner,
а не54f93706. Их нельзя назвать updated installed profiles. Это retained QA,
не выбранные production profiles: не подключать их молча, пока parent ведёт QA.
Ни account scope, ни browser endpoint здесь не раскрываются.

Перед регистрацией parent выбирает ровно разрешённый набор existing authorities.
В той же private authority directory можно подготовить новый immutable profile
filename с обновлёнными executable/ahap_script, сохранив database/gate/generation,
principal/node/instance/code_home/cwd и adapter config. Старый профиль не трогать.
Так сохраняются session/task receipts и UNKNOWN; bootstrap существующей authority
не выполнять. Для новой authority bootstrap только fresh canonical0700 home.

`scoped_profile.rs::open_profile`: absolute canonical private parent, без symlink,
root/current UID ancestors без group/other write, profile/DB current UID,
single link, private mode, profile≤16384bytes; DB/gate лежат рядом с profile.
`trusted_executable` отвергает symlink components. Поэтому физический перенос
bundle требует перепаковать новый manifest; alias в owner executable/runner
не подставлять. Самый простой install использует уже immutable releases paths.

AHAP subprocess получает env_clear, HOME=owner.code_home, pinned PATH,
AHAP_VERSION/HARNESS от core и только allowlisted ahap_env. Не рассчитывать, что
произвольный env wrapper автоматически попадёт в browser adapter. Credentials
не переносить в descriptor, отчёт, stdout или новый config.

## Минимальный wrapper, который parent может применить

Предлагаемый descriptor `v1-entry.json` mode0600, parent0700, immutable per-release
profiles. Поля: `manifest` (точный существующий абсолютный path),
`manifest_sha256` (принятый digest), `profiles` (упорядоченный список объектов
`path` и `sha256`). Это selector, не новая authority/operation registry.
Значения protected profile references parent выбирает по действующей приёмке.

Один wrapper mode0700 по stable command выше выполняет только:

1. Один раз читает descriptor; проверяет manifest hash по его bytes.
2. Проверяет component hashes core/compat/node/bootstrap и уникальных adapters,
   canonical paths внутри manifest.artifact_root. Проверяет ровно существующие
   launch/launch_compat templates, не угадывает executable и не использует shell.
3. Проверяет profile hash, same principal/unique instances и точное соответствие
   owner.executable/ahap_script выбранному manifest; ошибки в stderr только
   фиксированным текстом. Не логирует profile body/env.
4. Строит argv из `launch_compat.argv`, заменяет placeholder первым profile,
   append дополнительных пар; добавляет только declared launch_compat.env в
   наследуемое окружение и `os.execve(argv[0], argv, env)`.

Никаких init/read/send/retry, supervisor loop или background process в wrapper.
Не делать hash mismatch fallback на старый artifact. Разрешённый native consumer
может использовать manifest.launch напрямую, но обычный клиент — compat.

Отдельная Codex регистрация после подготовки wrapper/selector:

```toml
[mcp_servers.agent-herder-v1]
command = "/home/roomhacker/.local/bin/agent-herder-v1"
args = []
```

Это предлагаемый новый block, не уже внесённый config. Legacy agent-herder block
и systemd unit не менять. Не клонировать в новый block HTTP auth headers/env.

## Атомарное применение parent

Подготовить wrapper и profile snapshots полностью до регистрации; использовать
exclusive temp files в той же directory, проверить contents/modes/hashes.
Selector заменять `os.replace` одного staged file после fsync; rollback — ранее
сохранённый selector с его hash. Это одна точка переключения manifest+profile set,
без двух несогласованных current symlinks. Stable wrapper не менять при каждом
artifact. Для первой установки записать selector до добавления MCP block.

Общий `/home/roomhacker/.codex/config.toml` содержит чужие MCP настройки:
сохранить исходные bytes/hash, подготовить temp0600 с одним новым block, проверить
отсутствие дубликата, проверить что original hash не изменился с чтения, затем
atomic replace. Если hash изменился — перечитать и пересобрать, не overwrite WIP.
Один назначенный installer, без конкурентного config writer; hash check+rename
сам по себе не является kernel CAS против чужого same-UID writer.

При readback/откате закрыть только собственное V1 MCP подключение. Статус accepted/
UNKNOWN сохранять по исходным task/request IDs. Selector update не переключает
уже живой child: новые bytes проверяются на новом собственном подключении.

## Как доказать installed bytes и ordinary consumer

1. Считать stable command/selector/config обратно с диска: hashes, modes, выбранный
   manifest и profiles, same authority DB/gate/generation; секретные поля не выводить.
2. Проверить все artifact hashes повторно и сохранить receipt со source, manifest
   SHA, component hashes, profile hashes/references и фактическим argv.
3. Через обычный зарегистрированный `agent-herder-v1` подключиться; downstream
   initialize2025-06-18, tools/list и discover instances дают ожидаемый набор.
   Для этого одного подключения в `/proc` подтвердить один compat и один core,
   core executable bytes по `/proc/<pid>/exe`, argv с точными profile paths;
   AHAP children — manifest.node + каждый точный runner. Не печатать окружение.
4. Проверить read существующих разрешённых session/task через тот же registered
   entry. После закрытия/reopen своего V1-подключения те же refs и receipts
   читаются без новой mutation. Full business canary parent выполняет отдельно
   в разрешённом scope по CONTRACT, с exact inputs/outputs, export/search/projects,
   transcript/cleanup receipt и без replay старых UNKNOWN.

`tests/native/v1_multi_browser_stand.py --stage installed` сейчас проверяет
manifest artifacts, но создаёт собственные свежие profiles и Popen(manifest.core)
напрямую. Это installed-artifact fixture, НЕ доказательство stable wrapper,
Codex registry, compat или persistent installed profiles. Её receipt можно
приложить как отдельный слой; пункты1–4 ею не закрываются. Существующий
`acceptance/compat/opencode_consumer.py` доказывает wire legacy→compat отдельно,
но тоже запускает binary напрямую. Не выдавать direct source/wire PASS за
проверку пользовательской регистрации.

## Почему прежние fleet installers не применять

`deploy/fleet/build-v1-core.py` — packager, прямо never install/switch.
`rollout-node.py::switch_current` уже использует atomic rename, но его release
schema и service activation относятся к TS fleet node/config/current.
`rollout-mcp-child.py` переключает canonical `dist/index.js` зарегистрированного
GPTAdmin AgentHerder child. `rollout-candidate.py` также legacy release flow.
Эти пути не принимают V1 manifest как готовый multi-owner stdio install и
затрагивают чужой legacy runtime; для отдельного V1 entry они не нужны.

Infrastructure source начат с canonical ServersAdministartion AGENTS,
infra/access-topology.md и docs/inventory/README.md. Локальный HEAD7295c36b
совпадает с имеющимся origin/main, access-topology/README без WIP; network fetch
не выполнялся, свежесть remote сверх локального ref не заявляется. Живые metadata
legacy service проверены read-only. AgentMemory не дал релевантных install
решений; код/manifest/live metadata использованы как текущие источники.

Итог: READY_TO_IMPLEMENT для parent. В этой сессии создан только этот отчёт;
wrapper/config/profiles/registration не применены. Точные неизвестные до install:
окончательно принятый artifact digest и разрешённый persistent profile set.
