# ZCODE10: подготовка installed preflight, 10 ноября 2026

## Результат

Подготовлен отдельный immutable V1 candidate и защищённый ZCode profile; shared fixture, selectors и runtime не менялись. Native preflight именно через установленный `/opt/agent-herder-ci-smoke/bindings.cjs` `NativeWorkerPort` с candidate adapter и staged profile прошёл: `ready=true`, источник `zcode-native-create-model-catalog`, время `2026-11-10T12:14:40.069Z`; закрытие собственного transport PASS. Создание сессии, inference и отправка не выполнялись. Это не installed acceptance и не public consumer proof.

Native catalog подтвердил `4cc673aa-6c6a-418b-8b91-9e601fef99f6/MiniMax-M3.1-Flash$enabled`: этот exact pin уже присутствовал среди сконфигурированных native model IDs; catalog отдельно содержит точную пару provider/model и единственный уровень `enabled`. Fake-model fixture не использован. Доступность provider для inference не проверялась.

## Артефакты и вход для Lead

- Корень staging: `/home/roomhacker/herder-artifacts/ci-runs/resume-zcode-20261110-01a1c551`.
- Manifest `candidate-v2/manifest.json`, SHA256 `f05b3961d9a19bc573408578193d688258ef042e7cd06b956f936544daa13aa8`.
- Adapter `candidate-v2/fixture/ahap-zcode-runner.mjs`, SHA256 `895cc417b437de4c83e0918d3d841912994fceac22b38eb57f63f67a4f44339b`.
- Profile `zcode-profile.json`, mode 0600, SHA256 `d21b38c6ab9350140b8741255530105a06aabf77e6db68d630ef6f941961c1a4`. В профиле сохранены прежние identity/cwd/transport, заменён путь adapter и добавлен точный model pin.
- Машиночитаемый CAS input `migration-input.json`, mode 0600, SHA256 `920369eeb5cfed3a2e76c19856648431308b526a5ca358ab6cb48297fd389f87`. Содержит точные старые и новые значения `bindings.native_profiles.zcode`, входные SHA и ожидаемые итоговые SHA fixture/install для JSON с indent=2 и завершающим newline. Значения иных профилей следует сохранить. До применения Lead обязан повторно сверить хеши и при изменении переосновать delta, включая новую browser-extension работу.

Снимок CAS: fixture `1402612500115572cce7b7c300fa2c0873cb3d3cf5254195a918f4c1af9f1470`, install manifest `f9741f61b745a6eed42709665810f783535ef7990112f04f16756830f0517f59`. Ожидаемые после предложенной строго определённой сериализации: fixture `6310d028d86e715b8ff61a17bb66aa241b11ace658c5e156436f8c1aed379c60`, install `ec3376b099ebfbff2e3b004c8b2a387a163589149b994bd9cb4fb4a30e816ab3`. Это не применённые значения.

## Сборка и проверка

`tsc --outDir <staging>/compiled --declaration false` из canonical checkout `1fcac12e511d17d203ab8a08fb662f2a1f7b46b1`; tracked source, packages и build config совпали с HEAD, untracked source файлов нет. Builder `python3 deploy/fleet/build-v1-core.py --output <staging>/candidate-v2 --source-sha 1fcac12e511d17d203ab8a08fb662f2a1f7b46b1 --node <existing immutable Node22> --core <d584fb68 core> --bootstrap <d584fb68 bootstrap> --compat <a3812e2c compat> --compiled-dir <staging>/compiled`. Rust binaries переиспользованы как явно указанные inputs; source SHA является provenance для compiled TS, а не доказательством сборки этих Rust binaries из этого commit.

Первая сборка `<staging>/candidate` остановилась на `UNRESOLVED_IMPORT agent-resume-mcp`, так как compiled directory был вне checkout. Создана только staged symlink `node_modules` на существующие зависимости, новый `candidate-v2` собран без перезаписи первого. `python3 deploy/fleet/test-build-v1-core.py <staging>/candidate-v2/manifest.json`: PASS, включая component hashes и zero native mutations/browser connections. `vitest run --root . --config vitest.config.ts tests/ahap-zcode-model-pin.test.ts tests/installed-zcode-proof.test.ts`: 2 файла, 30 тестов PASS. Source defect в ZCode не найден, изменения source/tests не потребовались.

## Маршрут установки

Штатный `deploy/fleet/provision-installed-smoke-runner.py` отказывает при существующей установке: `existing_install_refused_use_reviewed_refresh_or_remove`; отдельной исполняемой команды reviewed refresh в проверенном `deploy/fleet` не обнаружено. Поэтому команда повторного provision или удаления runner не предлагается. Lead выполняет свой release/CAS маршрут: удержать lease, сверить оба входных SHA, атомарно обновить только ZCode binding в private fixture и `fixture_sha256` в root-owned install manifest, сохранив permissions и все чужие поля; затем штатный `installed-smoke-helper.py` проверит хеши при следующем разрешённом запуске. До реального refresh/install нет доказательства установленного ZCode preflight. Переход browser lanes на собственное Herder extension выполняет отдельный исполнитель; устаревшие Vibe gates не являются целью ZCODE10.
