# L25: входы повторного Qoder canary

Состояние на 2026-11-06: контракт проверен по текущим `scripts/native-qoder-herder.py`, `scripts/native-qoder-herder.mjs` и `scripts/native-qoder-report.py`. Повтор ещё не запускался; `B8a88ae17a75b43e19ed4` открыт. Общий runner принадлежит L23.

## Нужны от L23

- Точный исполняющий host, абсолютный staging `candidate-root` и полный SHA-256 payload, а также согласование периода, в который кандидат и его зависимости неизменны и сборки не выполняются. Ранее проверенный общий payload имел SHA `c5620ac43f6953bc61cc6c5582546bb93ef3dab39a1d3fec282f71181ac35612`; не считать его текущим без подтверждения L23.
- Каталог должен содержать `package.json`, `dist/`, `node_modules/`, `packages/agent-resume/package.json` и `packages/agent-resume/dist/`. Сценарий монтирует `packages/agent-resume` целиком и `node_modules` read-only в контейнер, но это не защищает их от внешней записи на host. Fingerprint охватывает два package.json и файлы двух каталогов dist, **не** `node_modules` или остальные файлы package; поэтому fence от внешней записи нужен для всего дерева и зависимостей, а не только совпадение SHA до/после.
- На выбранном host нужны рабочий Docker, заранее загруженный локальный образ `node:22-slim`, Python 3, OpenSSL, Linux `/usr/bin/pgrep` и `/lib/x86_64-linux-gnu/libprocps.so.8`, доступ к актуальным Qoder scripts и право записать новую квитанцию. Перед запуском проверить `docker image inspect node:22-slim`: при отсутствии Docker по умолчанию может попытаться скачать образ. На текущем server-100 inspect вернул `No such image`; на другом host наличие пока не проверено. Запускать без скачивания и внешней сети.
- Пути к пакету Qoder 1.1.84 и заведомо синтетическому каталогу `.auth` с читаемыми `machine_id` и `user`; никаких пользовательских секретов. На server-100 обнаружены `/tmp/native-qoder-research-1000/package` (версия 1.1.84, SHA bundle `4269479aa05c991fb8bd365bc0e0238bf39faf501036d60e57e6e7e2260bc163`) и `/tmp/qoder-l12-isolated/home/.qoder/.auth` (оба файла читаются, содержимое не выводилось; синтетическое происхождение следует из ранее выполненной L12 работы). На другом host эти пути не предполагаются доступными.

## Запуск после получения и проверки входов

```sh
python3 scripts/native-qoder-herder.py \
  --candidate-root "$CANDIDATE_ROOT" \
  --candidate-sha256 "$CANDIDATE_PAYLOAD_SHA256" \
  --qoder-package "$QODER_TEST_PACKAGE" \
  --synthetic-auth-dir "$QODER_SYNTHETIC_AUTH_DIR" \
  --receipt "$QODER_L25_RECEIPT"
python3 scripts/native-qoder-report.py "$QODER_L25_RECEIPT" \
  --candidate-sha256 "$CANDIDATE_PAYLOAD_SHA256"
```

Путь квитанции должен быть новым и сохраняться в plan evidence; не перезаписывать предыдущий результат. Docker запускается с `--network none`, read-only root и временным HOME; hostname API Qoder сопоставляются с loopback, локальный HTTPS fixture отвечает вместо внешних сервисов. Временный сертификат и фиктивные provider credentials создаются локально. Проверяются версия и SHA неизменённого bundle, fingerprint кандидата до и после, container exit, две созданные сессии и точное совпадение их ID с выдачей, цепочки всех страниц, полные ответы обоих поисков и подтверждённая source coverage, проект, активный ход и счётчик вызовов локальной модели. PASS только по реальному выводу validator; сохранить также полную квитанцию и вывод проверки.

Это scoped canary candidate-модулей Herder с in-memory MCP поиском; он не доказывает общий unified gate, `dist/index.js`, authenticated HTTP MCP или установленный runtime. При сбое сохранить реальные ошибки и не закрывать баг; L23 отвечает за общий gate.
