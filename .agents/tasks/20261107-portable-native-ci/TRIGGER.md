# TRIGGER: минимальные точки подключения V1 report gate

Срез `origin/main`: `a6ff5bc03efa1514ac88a886785837b1ae078475` (проверенные ниже файлы не изменились относительно `76ec55f3`). Это read-only анализ; wiring, build, install и native сценарии не выполнялись. Решение о месте запуска V1 producer и об отдельном установленном V1 runtime остаётся владельцу.

## Существующие entrypoints и 3 patchpoint

1. **PR fast checks:** `.github/workflows/fleet-session.yml:3-6,19-33` уже запускается на push, pull_request и workflow_dispatch, matrix Linux/macOS; сейчас проверяет Node build и vitest, V1 reports не производит. Добавить в существующий job только быстрый независимый unit test валидатора:
   ```yaml
   - name: Verify V1 report gate
     run: python3 -m unittest discover -s tests/native -p test_candidate_release_gate.py
   ```
   Это проверка кода gate на обоих runner OS, не candidate/installed PASS и не native acceptance.

2. **Candidate/update до допуска:** `deploy/fleet/build-release-candidate.py:581-594` уже вызывает legacy `candidate_release_gate.py` пятью позиционными аргументами; сохранить вызов и смысл результата. У реального update отдельная обязательная проверка в `deploy/fleet/rollout-candidate.py:51-108`, вызываемая для fleet на строке 771 и для owner node-side на строке 586 под release lease. Для выбранного владельцем **отдельного V1 пути** после получения полного V1 candidate report и до его V1 acceptance вызвать этот же validator в режиме ниже; ненулевой exit означает V1 INCOMPLETE/отказ допуска. Legacy preflight не заменяется и current legacy `73e7aac` не переключается. Build `23df966f` сохранять как имеющийся owner builder; он собирает legacy Node release и проверяет свой manifest, а не автоматически Rust→AHAP V1 artifact. Сам факт сборки не создаёт V1 report. Конкретный V1 producer/entrypoint пока не подтверждён: не добавлять фиктивный обязательный workflow step без обеспеченного report и не встраивать unconditional V1 blocker в общий legacy rollout.

3. **Installed acceptance после установки отдельного V1 runtime:** `deploy/fleet/accept-node.py:1028-1050,1066-1072,1221-1249` — существующая отдельная legacy acceptance Node (rollout сам указывает отдельную команду `accept-node.py` на `rollout-candidate.py:754`). Её `ACCEPTED` не доказывает V1. В выбранной владельцем отдельной V1 post-install acceptance после real consumer readback вызвать тот же validator для `stage=installed`; результат выдавать отдельно от legacy acceptance. Не делать unconditional изменение legacy `accept-node.py` и не объявлять V1 installed PASS по candidate или service readiness. Как V1 consumer получает runtime identity, а также где должен жить его запуск, — решение владельца; существующий вызов для V1 не найден.

## Точный интерфейс в точках 2 и 3

```text
[<python>, <committed-tests/native/candidate_release_gate.py>,
 "--validate-v1", <report.json>, <expectedidentity.json>]
```

```sh
"$PYTHON" "$GATE" --validate-v1 "$CANDIDATE_REPORT" "$CANDIDATE_EXPECTED"
"$PYTHON" "$GATE" --validate-v1 "$INSTALLED_REPORT" "$INSTALLED_EXPECTED"
```

Вызовы показаны для интеграции, не запускались. Использовать проверенный gate из доверенного commit, который содержит REPORT (`76ec55f3` или его потомок), а не произвольный старый candidate SHA: `rollout-candidate.py:61-77` сейчас извлекает `tests/native` именно из candidate commit, в котором `--validate-v1` может отсутствовать. Exit 0 означает PASS только указанной стадии; отсутствие report/identity, несовпадение, неполная проверка, unsupported или UNKNOWN → nonzero и V1 не принят.

`expectedidentity.json` создаёт доверенный вызывающий код из собственных наблюдений/пина запуска, **не копируя его из непроверенного отчёта**:

```json
{"run_id":"<exact-run-id>","source_sha":"<full-source-sha>","artifact_sha256":"<exact-v1-artifact-sha256>","stage":"candidate"}
```

Для installed — отдельный expected с `"stage":"installed"`, собственным run_id и identity реально установленного runtime; тот же consumer, свежий report. Report должен совпасть с expected по всем четырём полям и содержать пять lanes × семь PASS и пять PASS в общем `negative_checks`. Установленный digest подтвердить независимым readback. `build-manifest.json.bundleFingerprint`, SHA файла `dist/index.js`, SHA manifest и V1 core/artifact digest — разные определения: какое именно поле является `artifact_sha256`, и как доказать соответствие candidate установленным байтам, должен определить владелец V1. Без этого нельзя безопасно подставлять legacy fingerprint вместо digest V1.

Для обновления версии native клиента использовать тот же существующий кандидатный путь и свежий отчёт, привязанный к фактически выбранным версии, run и artifact; автономного version-trigger/scheduler в проверенном workflow нет. Не повторять UNKNOWN mutation для получения зелёного отчёта. Требуются реальные результаты всех lanes и negative gate; отсутствующий producer или недоступный runtime означает INCOMPLETE.
