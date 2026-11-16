# Короткий dev-release контур

Короткие команды поверх существующего guarded rollout:

    python3 deploy/fleet/dev-release.py build --sha origin/main
    python3 deploy/fleet/dev-release.py green --sha <sha>
    python3 deploy/fleet/dev-release.py promote --sha <sha> --release-proof <proof> --apply
    python3 deploy/fleet/dev-release.py rollback --release-proof <proof> --apply
    python3 deploy/fleet/dev-release.py stop --apply

В status установленный релиз называется blue, staged-кандидат — green.
Green проходит отдельный fake/native candidate gate. promote вызывает штатный
rollout-node.py, поэтому сохраняются lease, CAS, ancestry, readiness и
встроенный rollback. Обёртка не меняет current и systemd drop-in напрямую.
Без --apply promote, rollback и stop печатают план и ничего не меняют в
live-сервисе.
