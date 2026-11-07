# Codex V1 candidate: исход попытки 01

- Manifest SHA-256 `2db3cc41b3411e1028ba641e1d3812369d054f01ab43cda135dd9c6ad5f454e4`, source `d66c9c0729fea2a18038fe6569625a14177a7adc`; SHA-256 core/bootstrap/node/codex adapter сверены с manifest перед запуском.
- Публичный MCP через отдельный Codex app-server Unix socket: preflight tools/list успешен; до create model requests 0, native sends 0. Собственный socket server использует отдельный HOME/CODEX_HOME и fixture-only key; launch.py обеспечивает netns/bwrap и localhost model.
- Попытка create одна: Task `create-operation:68ebef496b1d5ca9265c1a8c605ac631`; завершён с `structuredContent.create.effect=unknown`, `prompt.effect=unknown`, `diagnostic.code=outcome_unknown`, `retry=forbidden`; session_ref и native receipt отсутствуют. Reconcile исходной authority SQLite: intent статус `unknown`, binding отсутствует. В локальной Codex SQLite на момент read-only проверки `threads` содержит 0 строк; это не отменяет UNKNOWN и не разрешает повтор.
- Retained original evidence: `codex-v1-attempt-01/home/v1-codex-evidence.json`, `codex-v1-attempt-01/home/authority/state.db`, `codex-v1-attempt-01.log`. `codex-v1-pinned-preflight.log` — отдельный последующий read-only preflight без sends, не повтор create.
- `create`, second deliver, read, export, search, projects, reopen и весь lane НЕ подтверждены. Следующий шаг владельцу: расследовать исходный create Task/intent и adapter diagnostics без replay; код REPORT сохраняет UNKNOWN.
- Probe source commit `19dcfc9cc00c8f46b0e4b9ac08319e815a10f443`. После попытки добавлены проверки hash входов и сохранение полного task_result; новая версия проверена только preflight, mutation не повторялся.

## Выполненный вызов попытки 01 (не повторять)

```bash
cd /home/roomhacker/.codex/worktrees/herder-ci-runner-config/agent-herder
artifact_dir=/home/roomhacker/herder-artifacts/releases/herder-v1-d66c9c0729fe/fixture
codex_bin=/home/roomhacker/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex
evidence_dir=/home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-portable-native-ci/evidence
python3 tests/native/launch.py --retain-on-failure "$evidence_dir/codex-v1-attempt-01" \
  --ro-bind "$artifact_dir/herder_native_stdio" --ro-bind "$artifact_dir/ahap-owner-bootstrap" \
  --ro-bind "$artifact_dir/node" --ro-bind "$artifact_dir/ahap-codex-runner.mjs" --ro-bind "$codex_bin" \
  -- /usr/bin/python3 "$PWD/tests/native/v1_codex_stand.py" \
  --core "$artifact_dir/herder_native_stdio" --bootstrap "$artifact_dir/ahap-owner-bootstrap" \
  --node "$artifact_dir/node" --adapter "$artifact_dir/ahap-codex-runner.mjs" --codex "$codex_bin" --execute
```

## Read-only диагностика исходного UNKNOWN (08.11)

- Исходные сохранённые Codex `logs_2.sqlite`: `logs=0`; `state_5.sqlite`: `threads=0`; каталог `codex/sessions` отсутствует. Лог попытки содержит только успешный preflight и общий `create not confirmed`; native app-server запускался с `stderr=DEVNULL`. Эти данные не дают содержимого native RPC или точной ошибки и не доказывают отсутствие side effect.
- Точный сохранённый результат Task: `structuredContent.create.effect="unknown"`, `structuredContent.prompt.effect="unknown"`, `diagnostic.code="outcome_unknown"`, `diagnostic.retry="forbidden"`, `diagnostic_ref=null`, `receipt_ref=null`. Сопоставление с исходной authority/Task выполняет владелец.
- В **точном опубликованном** `fixture/ahap-codex-runner.mjs` (SHA-256 `700ce628c790a0703f1d0c5fb91ba47b7d2e994af8b680f2e4482844af1485f7`) и соответствующем source `d66c9c0729fe`: `CodexAppServerAdapter.createSession` передаёт `thread/start` через `request`; перед записью transport вызывается quota guard, если модель не начинается с `zc/` или `glm...`. В сохранённом fixture `config.toml` модель `herder-test`, provider `fixture`, endpoint — localhost. Если create пришёл без явно переопределённой модели, этот путь не попадает в исключение quota guard. Его default policy на неизвестную квоту — block; quota проверяется через `account/rateLimits/read`. Какая модель фактически попала в запрос и каков был ответ quota в исходной попытке, сохранённой диагностикой **не подтверждено**.
- `src/ahap-codex-runner.ts` source `d66c9c0729fe` перехватывает ошибки `createSession` и возвращает общий `Codex adapter call failed` с `outcome=unknown`; само исключение не сохраняется в этом ответе. Core запускает adapter с stderr в `/dev/null`, поэтому из этого набора нельзя отличить quota refusal до transport write от native RPC ошибки/таймаута и других сбоев. Это ограничение видимости; source строки quota и отсутствие threads не устанавливают, какая ветка сработала для данной попытки.
- Вывод: вероятный диагностический кандидат — quota guard на fixture model; **доказанной первопричины или adapter bug для этого исходного Task нет**. Adapter source не менялся. UNKNOWN и запрет повторения сохраняются; никаких новых app-server, create, send, ключей и schema-generation при этой диагностике не выполнялось.
