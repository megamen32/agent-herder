# Terra: матрица финальной приёмки Herder V1

**Дополнение: candidate 82b91db9.** Manifest SHA-256 `cff8e8dd19dd61358d0df1a4ec9d94f1fef0431f8af91f3b40eef74f437cd6b1`. Все core/bootstrap/node/compat и CLI adapter hashes совпали с 3d, aa и 5ff; принятый владельцем NEG 3d переносится только на проверенные fake-AHAP случаи по идентичному core. Browser adapter изменился; browser PASS не переносится. Package verifier 82b PASS только для локальных package/initialize checks (`package-82b-result.json`); это не browser consumer proof. ZCode archive остаётся **не подтверждён до raw receipt**. Installed остаётся **INCOMPLETE**, установленный consumer не проверен. Детальные full hashes: `reuse-82b91db9.json`.

Ниже исторический срез aa111101; частичные browser-данные относятся только к нему.

Срез 2026-11-08T15:15:57.541460+00:00; только анализ существующих файлов. **Общий gate не пройден, установка не выполнена.**

Source: `aa1111019d77503eabd05b8ac8bb1b826148c774` — provenance манифеста, указанное вызывающей стороной для prebuilt inputs, само по себе не доказывает происхождение каждой сборки. План сообщает source/unit и browser targeted tests; это не consumer или installed proof.
Candidate: `/home/roomhacker/herder-artifacts/releases/herder-v1-aa111101-browser/manifest.json` SHA-256 `bb4fdcb05e69fd3684274b6d2adcfe4f98a05ae11e85813e1d3c60300019bde1`. Базовый 5ff manifest `9fc6f17e7b5c43b1a9208a2a60edc461d5d38c6357e19946892dbded50af1dfb`. Хеши фактических файлов обоих манифестов проверены: все перечисленные компоненты совпали со своими манифестами.

| Harness / аккаунт | create | deliver | read | export | search | projects | restart | archive |
|---|---|---|---|---|---|---|---|---|
| opencode | R | R | R | R | R | R | R | R |
| codex | R | R | R | R | R | R | R | R |
| zcode | R | R | R | R | R | R | R | P? |
| chatgpt-profile-0 | — | — | — | — | — | — | — | — |
| chatgpt-profile-1 | частично | — | — | — | — | — | — | — |
| zai | частично | — | — | — | — | — | — | UNKNOWN |
| compat | R | R | R | R | R | R | R | R |

R = candidate-доказательство 5ff перенесено по идентичным packaged bytes для того же fixture/config; это не новый запуск aa111101. `—` = полного proof нет; `P?` = план/FINISH заявляют PASS, но сырая квитанция archive не найдена; это не FAIL. `compat` — дополнительный ordinary legacy MCP → OpenCode consumer, не шестой harness. Во всех строках **installed: не установлено / все восемь критериев не проверены**.

CLI receipts: `opencode-5ff-result.json`, `codex-5ff-result.json`, `zcode-5ff-result.json`, `compat-5ff-result.json`; контрольные SHA-256 и данные по каждому критерию — в соседнем JSON. OpenCode/compat зафиксировали archive confirmed, Codex — archive_test_chat PASS; ZCode сообщает PASS основного сценария. В `zcode-5ff-result.json` и `zcode-5ff-run.log` отдельного вызова/квитанции archive нет; текстовые вхождения archive в log относятся к общим инструкциям окружения. Указанный в `zcode-5ff-command.json` retained root `/home/roomhacker/herder-artifacts/ci-runs/zcode-5ff02215-63bcf20f` отсутствует: launcher сохраняет его только при ошибке, при успешном завершении удаляет. Текущий исходник stand выдаёт PASS после restart без archive-вызова. План/FINISH заявляют archive PASS, но сырой receipt не найден; отсутствие поля не означает FAIL. Хеши log/command и путь записаны в JSON.

Перенос допустим для OpenCode, Codex, ZCode и ordinary compat в пределах их исходных тестовых условий: у 5ff и aa111101 совпадают core, bootstrap, node, compat и соответствующие CLI adapters; SHA-256 четырёх receipts совпали с `cli-aa111101-exact-reuse.json`. Для aa111101 сознательно применяются те же исходные CLI argv/config inputs, с заменой путей manifest/components и ожидаемого digest manifest; рассмотрены четыре сохранённые команды 5ff и `cli-aa111101-exact-reuse.json`. Отдельного receipt запуска aa111101 или независимого config digest нет, запуск не утверждается; перенос относится к исходному fixture/config, не к произвольной конфигурации. Common export явно unsupported; V1 требует native bytes и полноту. Projects CLI имеют ограниченный provenance зарегистрированных авторизованных сессий, не глобальный реестр.

Browser adapter изменился: 5ff `35e24a53e3a7146f82e4ee80b53f0abd08659310ce4631a53d415eb285f76031` → aa111101 `78f8b7cc8626429ae0910b6f191822cbe421537ec7178462ce632eb03742572b`; старые browser receipts не переносятся на candidate.

Активные receipts — незавершённые снимки: `multi-chatgpt-aa111101-1803/receipt.json`: discovery одного core PASS, profile-0 timeout/BLOCKED, profile-1 create и первый prompt подтверждены, сценарий UNKNOWN; `zai-aa111101-1806/receipt.json`: исход отправки UNKNOWN, archive UNKNOWN. UNKNOWN не повторять: сверить существующие task/receipt и фактическое состояние. Исторический `multi-chatgpt-5ff-receipt.json`: account profile-1 первый turn и archive PASS, полный сценарий INCOMPLETE; это не proof нового browser adapter.

Осталось: полный candidate consumer для обоих ChatGPT accounts и Z.ai, включая native полный export с многостраничным sample, search coverage, projects provenance, restart без повторной отправки и archive; сырое доказательство ZCode archive; принятый NEG 3d переносится по идентичному core с указанными ограничениями; затем отдельные установка и installed readback после принятия общего gate. C13/C14/FIXZ — только bookkeeping gap, не активная разработка.

AgentMemory: project recall вернул одно историческое наблюдение без относящегося к задаче решения; локальный fallback не использовался.

**NEG multicore.** `multi-core-regression.log` (SHA-256 `101501dcb539c5a6873a1ac59df35d1dd2baf7fc9706e52c29de3346b60f5e4d`) фиксирует 19 launcher tests PASS, один real SDK test ignored. По названиям тестов и текущим assertions source/fake-AHAP покрыты: отклонение чужого instance до отправки и spoofed identity; повтор key без повторной отправки и конфликт payload; UNKNOWN после restart без resend; HumanStop; изоляция двух профилей, совпадающих native ID и ключей, восстановление tasks/read и archive первого профиля; отдельный fake archive key не повторяет вызов. Есть также проверки profile/authority. Это source/fixture evidence: log не связывает тест с digest exact aa111101 и не заменяет candidate NEG. Старые NEG от 5ea/805/78 относятся к другим core bytes и не переносятся автоматически. В двухпрофильном сценарии явно не доказаны все негативные случаи между аккаунтами: чужие principal/session и duplicate/conflict/UNKNOWN/HumanStop на multicore-маршруте; необходимы их точные candidate receipts или иное соответствующее доказательство.
