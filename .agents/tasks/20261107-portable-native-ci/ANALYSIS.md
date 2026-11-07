# Перезапуск CI: проверенные причины затягивания

Исследование начато 2026-11-07 18:13:17 UTC. Это анализ, а не доказательство готового CI.

## Что произошло

1. **Не был замкнут один пользовательский путь.** Старый CI успешно проверял candidate Codex/OpenCode/ZCode, но установленный Codex не позволял выбрать отдельный native instance с тестовым provider. `CIINSTALLED` завершён как исследование пробела; `CIGATEINSTALLED` остаётся blocked. Исследование ошибочно превращалось в очередную подготовку релиза.
2. **Проверка привязана к конкретному серверу.** `tests/native/zcode_candidate_remote.py` содержит SSH target `roomhacker@192.168.2.5`, путь к вне-репозиторному runner и версии ZCode. Зависимости берутся из live current; новый runner невозможно восстановить только из опубликованного CI source/config.
3. **CI и релизная проверка разошлись.** `.github/workflows/fleet-session.yml` запускает build/core и Vitest. Native suite вызывается сборщиком и rollout, а не workflow. Кандидат возвращает scoped PASS при release INCOMPLETE; это корректная оговорка, но не завершённая цепочка принятия релиза.
4. **Проверяли не тот инвариант сборки.** `assemble()` сохраняет node-config.json, но безусловно переключает current. Воспроизведено во временном каталоге: a→b без rollout. Повторная сборка текущего SHA переносит его каталог в trash и заменяет содержимое активного пути. Bug `B83d137dd9a3e43ae87c1` в продуктовом плане; не новый внешний blocker.
5. **Не отделили portability от platform support.** `launch.py` требует Linux unshare/bwrap; `candidate_stand.py` использует /proc и ip. Это допустимый Linux backend, но не доказательство macOS/arm64. Конкретные CLI/runtime версии, ОС/архитектура и capabilities должны быть входами и частью отчёта.
6. **План перестал управлять работой.** В старом плане 84 done, 11 blocked, 13 pending, 2 queued, 1 deferred и 1 legacy без status; сохранённые 49 ревизий не сняли дубли и старые обязательства. В журнале этой сессии на момент разбора 145 assistant final_answer; последние повторно пересказывают один blocker. Это не измерение полезной работы или счёта за токены.
7. **Новый продукт пока не покрывает исходный контракт.** Оркестратор подтвердил обычный вход `herder_native_stdio --trusted-owner-profile <profile.json>` (MCP stdio), но export возвращает unsupported/effect:none, search не принят, отдельного списка проектов нет. Обход через внутренние классы или старый HTTP API не может доказать новый MCP.

## Что сохранить

- Детерминированный HTTP model fixture с Responses/Chat Completions, streaming и tool call. Для основного CI он не требует GPU и платной модели. Gemma 4 остаётся отдельной проверкой понятности инструментов и модельного поведения, с явно настроенным endpoint.
- Старый реальный 3-lane suite (~50 секунд в сохранённом receipt) и transcript/search validators. Их исторический PASS не переносится на другой SHA/профиль.
- OpenCode AHAP consumer `tests/native/ahap_opencode_stand.py`, stand commit b440b37c; продуктовый immutable artifact 1d89d04d. Реальные create→initial message→read/reopen подтверждены; export отдельно признан unavailable.
- Existing release lease/CAS/rollback; запрет повторять UNKNOWN. Существующий Mac Mini transport, выделенный ChatGPT page7 и account scope; browser account/profile не подменять.

## Проверенные источники

- Старый план: `../20261105-deterministic-harness-ci`, leaves CIINSTALLED, CIGATEINSTALLED, L102, CIERROR, CIGUARD, JOINT-EXECUTION.md.
- Product plan: `../20261107-herder-native-mcp-breaking`, QCONTROLINSTALL, QOCEXPORT, QMACREUSE; `evidence/QOCEXPORT/native-export-case-receipt.json`.
- Published origin/main 4489c69b на момент fetch. Проверенные builder/ZCode runner байт-в-байт совпадают с опубликованными версиями.
- Собственный rollout: `/home/roomhacker/.codex/sessions/2026/11/05/rollout-2026-11-05T18-27-51-01a1ac52-d25c-7050-a65d-3fca32642c26.jsonl`; анализ метаданных и последних finals без повторных model sends.
- Оркестратор `01a1b2b2-5685-7b52-a2bb-05eb931cafa4`: exact session_info после delivery `ci-astra-replan-20261107-v1`, ответ 18:20:49 UTC.

## Согласованные границы

CI владеет builder, конфигурацией runner, проверками и единым отчётом. Rust launcher/profile/core и адаптеры остаются у продуктового оркестратора. Один реальный MCP consumer contract; не новый test-only API. Не выполнять fleet rollout ради каждой правки. Browser page7 остаётся за CI до явной последовательной передачи.

## Решения для нового плана

- Переносимость означает неизменный сценарий плюс заменяемая конфигурация runner: executables/versions, transport, capabilities, artifact, отдельный профиль. Для неподдержанной платформы — точная причина, не ложный PASS.
- Каждый обязательный сценарий имеет отдельный результат: send, session read с last user/assistant, полный transcript, поиск других сессий, projects. Unsupported/missing/timeout любого обязательного сценария не разрешает принятие полного обновления.
- Fast checks на PR; реальные CLI с deterministic fixture на release candidate; browser lanes на разрешённом авторизованном runner; после установки тот же контракт через действующий consumer. Изменение версии внешнего инструмента запускает compatibility job, не бесконтрольное обновление флота.
- Два приёмочных результата: CI правильно обнаруживает нынешние недостающие функции; позднее исправленный продукт проходит их на точном установленном артефакте. Первый полезен оркестратору сразу и не выдаётся за второй.
- Никаких самостоятельных фоновых fetch к ChatGPT. Автопилот сохраняется: UI/hooks штатных запросов, интервал не чаще пяти минут, backoff при 429. Live browser checks serial в exact test scope.
- Успешный перенос на второй настроенный runner без правки scenario source — практическое доказательство hardware independence в пределах проверенных ОС/архитектур.

## Минимальная матрица, по которой проверять сам CI

| Ситуация | Обязательный результат |
|---|---|
| Все обязательные сценарии подтверждены на точном артефакте | PASS для указанного scope |
| Отсутствует CLI или неподходящая версия Node | BLOCKED с именем отсутствующей capability до create/send |
| Export обнаруживается в tools/list, но возвращает unsupported | UNSUPPORTED для transcript; общий release не принят |
| Нет публичного projects list | Явный пробел projects, не подмена содержимым fixture config |
| Ответ получен, но другой session/account/input | FAIL без второй отправки |
| Потеря ответа на send | UNKNOWN, исходный request/receipt сохранён, автоматического resend нет |
| Пропущена страница transcript или повторился cursor | FAIL; нет частичного успешного экспорта |
| Новый SHA использует старый успешный receipt | Отказ по identity mismatch |
| Candidate PASS, installed receipt отсутствует | Кандидат проверен; принятие установки INCOMPLETE |
| Есть установленный файл, но нет обращения к работающему consumer | Installed acceptance не доказана |
| Browser cooldown/429 | Отдельная отложенная browser проверка с backoff; CLI продолжает работу |
| Runner перенесён, конфигурация изменена | Те же scenario files, новый host/runtime fingerprint в receipt |

Каждая среда использует собственный model fixture и профиль: сценарий tool-call сейчас выбирает первый HTTP request счётчиком сервера; один общий сервер для параллельных независимых lanes нарушит этот порядок. Сервер на lane сохраняет уже существующую детерминированность без нового model gateway.

Полный запуск не обязан совпадать с каждым unit-test push: быстрые unit/contract проверки идут на PR, обязательный native compatibility job — на release candidate и при смене версии native dependency. Изменение runner/CLI version также требует совместимости перед принятием обновления. Post-install запускается один раз на конкретной установке; failure запрещает расширение rollout и использует существующую процедуру rollback там, где подтверждена регрессия. Недоступный внешний browser сохраняется как незавершённая приёмка, а не повод слепо откатывать рабочую версию.
