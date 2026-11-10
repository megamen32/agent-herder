# Независимая Astra: рекомендация по Herder V1

Дата: 07.11.2026, проверка около 22:01–22:05 МСК. Вердикт: **REVISE**. Повторное использование прежних адаптеров поддерживаю; готовность пяти сред и срок пока **NEEDS_EVIDENCE**.

Полномочия этой сессии: исследование и рекомендация; единственная запись — этот файл. Никаких назначений, изменений кода, запуска native sends, сборки или установки не выполнено. Предложения ниже — вход для ведущей Astra, не уже принятые назначения. После синтеза нужна отдельная критика его итоговой версии.

## Рекомендация

Оставить новое Rust-ядро единственным публичным MCP и владельцем policy, Tasks, durable intents, идентичностей и разрешений. Под ним использовать существующие TS adapter classes через узкие AHAP wrappers, без запуска старого монолита и его автоматизаций. Это shortest path, поскольку OpenCode уже доказал такую вертикаль. Но нельзя называть её готовым универсальным подключением: текущий публичный OpenCode запрещает отдельный deliver, export не подключён, projects ещё не имеют публичного действия, а остальные среды не включены в owner profile.

Не переписывать протоколы, не удалять legacy сейчас, не строить новый scheduler, не ждать LHC parentwake. Главная работа — закончить composition и read surfaces, а не «доделать CI». CI не сможет исправить отсутствующий публичный метод fixtures-ами.

Дедлайн остаётся **08.11 00:38 МСК**, а не три часа после этого совета. На 22:01 оставалось 157 минут. Ниже условный путь на 135 минут с 15 минутами резерва при старте не позднее 22:08. Это жёсткая вместимость, не доказанный прогноз: особенно рискованны Codex bridge, deliver OpenCode и browser account verification. Если первые эксперименты не проходят, нельзя просто переносить обещание ещё на три часа или выдать 3/5 за 5/5.

## Что проверено

- При продолжении файла astra.md ещё не было. Текущий worktree чистый, HEAD `5274170d`; локальный main canonical — `b3655904`. `git ls-remote origin refs/heads/main` вернул `7c7434f58449ce13dbd6ba0cdf3a3d3450090fcc`. Canonical содержит существенный чужой WIP. Чтение source в worktree не заменяет artifact/runtime proof; diff HEAD→origin/main по crates/herder и трём AHAP runners пуст на этой проверке.
- Прочитаны действующие GSD PROJECT/REQUIREMENTS/ROADMAP/STATE. Они описывают прежнюю продуктовую историю; новый срок и scope берутся из прямого поручения и `20261107-herder-v1-core/plan.md`, а не из прежней очереди. Новый план пока содержит только P00; автоматический прогноз окончания P00 не является прогнозом готовности V1.
- `20261107-portable-native-ci/LEGACY-ADAPTERS.md` фиксирует новый split: CI — старые adapters/fixtures; продукт — core/thin hookup. Старый `CI-CONSUMER-CONTRACT.md` местами назначает adapters Herder; при реализации следовать более позднему split, а не двум владельцам одного файла.
- `src/ahap-{opencode,zcode,browser}-runner.ts` действительно импортируют старые классы. OpenCode/ZCode METHODS не содержат raw transcript/list/projects; browser содержит listSessions, но не raw transcript/projects.
- `crates/herder/src/bin/herder_native_stdio/scoped_profile.rs` допускает только codex/opencode, включая origin/main. `owner_launch.rs` для Codex использует Rust CodexCreateControl/CodexReader. Поэтому заявление «все пять уже на прежних адаптерах» неверно; Codex требует отдельного тонкого bridge либо явно согласованного исключения. Рекомендую bridge, не скрытое исключение.
- `owner_opencode.rs` явно возвращает unsupported/effect:none для Deliver. `src/adapters/opencode.ts` v22 допускает лишь один initial Start в новой сессии; это ограничение глубже wrapper. В v2 другая семантика; нельзя молча переключить семейство протокола.
- `crates/herder/src/search/index.rs` уже имеет session-scoped FTS, ACL allowlist и coverage. Новый поисковый движок не нужен, нужна public composition и ingestion из прочитанного transcript.
- `src/adapters/{codex-app-server,opencode,zcode,browser-chat}.ts` имеют getRawTranscript; listProjects есть у ZCode/browser, у Codex/OpenCode в просмотренных классах его нет. Пустой массив от BrowserChatAdapter при отсутствии driver.listProjects не доказывает, что проектов нет.
- `B83-GREEN.md` и commit `23df966f` подтверждают scoped fix builder и пять сохранённых тестов: candidate не меняет current/config. Это не новый live build и не installed acceptance.
- Сохранённый OpenCode artifact `ahap-qocjoin-1d89d04d` доказывает initial send/read/reopen по CI-CONSUMER-CONTRACT; не повторять этот результат как новый. FIVE-ADAPTER-ACCEPTANCE.json имеет status INCOMPLETE и pending receipts: это шаблон, не готовый gate.
- Shared AgentMemory вызван с project scope; полезных релевантных результатов не вернул. Локальная историческая память использована лишь как подсказка разделять exact-turn adapter proof и MCP proof; ключевые выводы выше сверены с source/документами.

## Единый продуктовый контракт

Один entrypoint: установленный `herder-native-stdio --trusted-owner-profile <protected profile>` через обычный потребительский MCP; точное имя binary/путь — из manifest. Сначала tools/list и advertised capabilities, затем те же команды для candidate и installed. Если обычный клиент требует уже имеющийся translator, его проверка входит в installed gate; собственный JSON-RPC скрипт не доказывает интеграцию клиента.

1. Identity: node + instance + harness + native session; для browser дополнительно проверенный account/context/page. Scope не выводится из «последней вкладки», cwd или совпавшего session ID.
2. Create: создать новую сессию с устойчивым request_key; initial prompt — отдельный наблюдаемый эффект. Deliver: отправить второе сообщение в ту же сессию поддержанным явно названным mode. Initial prompt не заменяет deliver. Нет общего обещания queue/current/steer, если native capabilities различаются.
3. Read и export: вернуть эту сессию и полный transcript с pagination/snapshot/completeness. Обрезка/таймаут — partial, не complete. Для большого transcript — ограниченные страницы/артефакт, не безлимитная AHAP-строка.
4. Search: искать доступные сессии в локально индексированных transcript; указывать coverage и время снимка. Проверить попадание маркера и отсутствие закрытой сессии. Не обещать account-wide completeness после индексации одного чата.
5. Projects: рекомендуется одно typed действие `discover(action=projects, instance_ref, ...)`, сохранив 14 tools. Это предложение новой schema, сегодня такого действия нет. Возвращать native project IDs для browser/ZCode; для Codex/OpenCode — только подтверждённые workspace/project associations с source=workspace и coverage. Нельзя выдавать cwd за native project или unsupported за пустой успешный список. Если владелец требует именно native projects во всех пяти средах, нужен явный пересмотр объёма, а не такая нормализация.
6. Receipt: request_key, core operation/task ID, adapter operation/input ID и native message/turn ID — разные поля. Accepted означает admission, completed — проверенное завершение. UNKNOWN сохраняется и сверяется read-only; restart/retry не запускает отправку заново. Нельзя синтезировать nativeInputMessageId из runner inputId.
7. Core stop/hold запрещает дальнейшие мутации и переживает restart. Это не равнозначно native cancel уже выполняющегося хода. Если публично обещан native cancel, проверить отдельно либо показать unsupported; не объявлять HumanStop полностью выполненным только по core hold.

## Что сохранить и убрать с критического пути

Сохранить Rust authority/store/gates/Tasks, типизированный каталог, existing FTS/transcript domain, TS adapters, три existing runners, durable receipt stores, build fix23df966f, готовые CI scenarios и source/native evidence. Сохранить историю, old checkout и чужой WIP.

Убрать из этого трёхчасового пути: новые native adapter implementations, массовое удаление legacy, новые scheduler/queue/очередь LHC, новый UI, переписывание translator, решение LHC parentwake, универсальную матрицу всех ОС и fleet rollout. Это рекомендуемое ограничение V1, не автоматическое закрытие прежних обязательств. Linux/macOS и остальные исторические требования остаются отдельно незакрытыми, пока их не доказали или владелец явно не изменил scope.

## Файлы и владельцы

| Область | Предлагаемое сохранение ответственности |
|---|---|
| Rust public composition/profile/catalog/read/export/search/projects, authority и receipts | Основная Astra: `crates/herder/src/bin/herder_native_stdio.rs`, подкаталог `herder_native_stdio/`, `mcp/catalog.rs`, `application/scoped_stop/`, `search/`, domain/store по необходимости |
| Thin AHAP wiring и Codex facade | Продуктовая Astra: `src/ahap-opencode-runner.ts`, `src/ahap-zcode-runner.ts`, `src/ahap-browser-runner.ts`; при выборе bridge — один новый `src/ahap-codex-runner.ts`; `crates/herder/src/adapters/ahap*.rs`. Нативную логику сюда не переносить |
| Прежние adapters, native client defects, fixture/config/report | CI: `src/adapters/*` и точные вызываемые legacy helpers; CONFIG/REPORT, `deploy/fleet/build-release-candidate.py`, existing candidate runners. Не трогать product composition ради зелёного теста |
| OpenCode public stand/export regression | Luna: существующие `tests/native/ahap_opencode_stand.py` и связанные stand tests. Общие tests/native не считать монопольным владением всего CI: сохранять конкретный split |
| ZCode native observation fix | Уже назначенный ZCode worker, его exact paths сохраняются; CI не редактирует их параллельно. Это не второй исполнитель AHAP wiring |
| Build/install/pointer и окончательная приёмка | Один явно назначенный интегратор основного плана; CI строит immutable candidate, но не переключает current. Эта советующая сессия не принимает эту роль |

Главная Astra может распределить непересекающиеся hookup-файлы уже работающим исполнителям в рамках своего мандата. В расчёте ниже не считаются ещё не нанятые/не запущенные агенты. Нельзя блокировать core на завершение всего CI: зависимость — конкретный manifest/fixture/API method.

## Исполнимые листья до 15 минут

Каждый лист заканчивается артефактом/наблюдаемым решением. Если работа не поместилась, сохранить конкретный RED и пересчитать критический путь; не превращать лист в многочасовой скрытый контейнер.

| Лист | Владелец, вход | Действие и критерий выхода |
|---|---|---|
| C0, 15 мин | Astra, этот совет + текущие catalog/profile | Зафиксировать exact contract выше, semantics projects и deliver; проверить эксперименты E1–E3. Выход: пять строк capabilities и точные blocking methods; решение по v22 |
| C1, 15 мин | Astra, C0 | Подключить existing ZCode/browser runners через protected profile/launch. Выход: public startup/read на трёх типах с correct instance/account; иначе отдельный RED на каждый неготовый тип |
| C2, 15 мин | Astra, C0 | Тонко вызвать существующий CodexAppServerAdapter через AHAP; вынести в public composition. Выход: реальный legacy Codex constructor, scoped create/read и точные native IDs. Не писать Rust native handlers |
| C3, 15 мин | Astra, C1/C2 | Вывести existing getRawTranscript через wrappers и public export. Выход: маленькая и многостраничная история, complete/partial различены, без синтеза потерянных сообщений |
| C4, 15 мин | Astra, C3 | Подключить existing FTS ingestion/search. Выход: обычный search на известном маркере, deny соседнего scope, честная coverage |
| C5, 15 мин | Astra, C0/C1/C2 | Подключить согласованный projects action и native/workspace provenance. Выход: schema и пять честных ответов; unsupported не заменён [] |
| C6, 15 мин | Astra, C1/C2 + CI fixes | Закрыть deliver/receipt mapping для реально поддержанных modes; crash/hold/no-replay регрессия. Выход: отдельный второй input с receipt либо точный blocker; если требуется новая native семантика, это не leaf-sized hookup |
| C7, 15 мин | Интегратор, C3–C6 | Собрать immutable candidate через исправленный builder; зафиксировать source/adapter/runtime/schema digests, current неизменён; Luna делает финальную delta проверку на этом manifest |
| C8, 15 мин | Интегратор + Luna, зелёный C7 | Установить один проверенный candidate штатным путём и readback через реальный клиент; receipt current/runtime и пять результатов. Rollback только task-owned pointer по штатной процедуре |
| I0, 15 мин | CI, независимо с C0 | CONFIG: реальные paths/native versions/изолированные scopes, без hardcoded server44, без secrets в report. Выход: manifest валидируется и читается существующим runner |
| I1, 15 мин | CI, независимо с C0 | REPORT: candidate и installed раздельны, PASS/FAIL/UNKNOWN/UNAVAILABLE/UNSUPPORTED не схлопываются. Required unavailable блокирует release |
| I2, 15 мин | CI, I0 | OpenCode E1: подтвердить поддержанный native deliver или зафиксировать stop-condition. Принятый initial send не повторять; новая отдельная операция только в fresh fixture |
| I3, 15 мин | CI, browser resource | Проверить сохранённый ChatGPT cooldown/idle receipt read-only, воспроизвести точный RED при необходимости. Выход: root cause + regression либо конкретная external/native блокировка |
| I4, 15 мин | CI, browser resource | Проверить Z.ai account pinning/empty-list и transcript pagination. Не менять browser target на чужую страницу; существующий page7 остаётся у CI |
| I5, 15 мин | ZCode worker/CI, свои paths | Завершить назначенный native observation fix и receipt mapping на exact package; не создавать вторую задачу того же файла |
| G1–G5, по 15 мин | Luna, готовность каждой lane | Выполнить нижеописанный consumer gate отдельно для OpenCode, Codex, ZCode, ChatGPT, Z.ai. Начинать по мере готовности, без ожидания всего CI; browser actions согласуются по ресурсу, не параллельно на page7 |

**Критический путь:** C0 → C1 → C2 → C3 → C4 → C5 → C6 → C7 → C8 = 135 мин, без предполагаемого параллелизма одной Astra. I0/I1 и native fixes идут независимо существующими владельцами. G1–G5 выполняются постепенно, но обязаны закончиться до переключения; последний изменённый source/fixture требует delta rerun на финальном manifest. Если все G начать лишь после C7, прибавится до 75 мин и срок заведомо сорван. Расписание условно ещё и потому, что C1/C2/C6 могут не вместиться в 15 минут; первые эксперименты должны снять именно этот риск.

Рекомендуемый ранний cutoff — **22:23 МСК**: если хотя бы одна среда не имеет проверяемого public launch/read маршрута или OpenCode deliver требует нового протокола, ведущая сообщает владельцу конкретное несоответствие срока и объёма, продолжая независимые листья. Не прятать это до 00:38. Последние 15 минут до дедлайна оставлять на installation/delta failure, а не новую функцию.

## Минимальный честный consumer gate пяти сред

Один сценарий/формат evidence, пять обязательных lanes: Codex, OpenCode, ZCode, ChatGPT, Z.ai. Для каждой — exact source SHA, artifact hash, installed identity, native version, fixture/scenario SHA, instance/account/page scope. Никаких внутренних adapter calls в качестве final PASS.

Для каждой lane: обычный client discovers capabilities → create → дождаться Task/native admission → получить ответ на первый уникальный marker → **отдельный deliver второго marker в ту же сессию** → read обоих inputs/ответов → full export с проверкой границ/пагинации → search marker с заявленной coverage → projects с точными IDs/provenance → перезапуск собственного core процесса и readback той же сессии без новой отправки. Старые accepted/UNKNOWN effects только сверять по их IDs; не replay ради доказательства.

На общей границе authority дополнительно: неверный instance/account отвергнут до native mutation; duplicate request_key не даёт второго native сообщения; конфликт key/payload отвергнут; потерянный ответ после admission остаётся UNKNOWN и после restart не повторяется; hold запрещает новую отправку. Эти инварианты проверяются на общем core, а несовместимые receipt shapes/start/queue semantics — отдельно для каждого adapter. Browser минимум проверяет смену account; синтетический общий fixture не заменяет account verification.

Готовность 5/5 = все обязательные действия всех пяти lanes прошли на финальном candidate и установленные lanes подтверждены обычным клиентом. Установленный read-only smoke может переиспользовать уже созданные candidate sessions/receipts при доказанной привязке того же immutable artifact и live native instance; если конфигурация/adapter/runtime изменилась, нужен новый изолированный сценарий. Unsupported export/projects/deliver — красная ячейка контракта, не допустимый PASS. Synthetic LLM fixture доказывает native integration, но сам по себе не доступность платного production provider; в отчёте эти claims раздельны.

## Двойные scheduler и receipts

Нельзя запускать src/index.ts целиком как «старый adapter bridge»: это может поднять прежний registry, automation, deferred delivery и watchers рядом с Rust authority. Использовать конкретные adapter imports. Проверить их init/constructor side effects; отсутствие второго монолита ещё не доказывает отсутствие внутренней очереди.

Не удалять legacy receipt journal ради «единственного ledger»: он может защищать от дублей. Установить один owner бизнес-решения dispatch/retry (core), а legacy journal оставить транспортным доказательством. Request key детерминированно связывается с adapter inputId и native IDs; reconciliation не планирует повторный dispatch.

Конкретные несовпадения source: Codex queue означает главным образом ожидание completion, browser queue влияет на waitForCompletion, OpenCode v22 требует Start, ZCode использует собственный Queue и automation-prefix inputId. Один boolean queue или только ok=true не годится как нормализованный контракт. Wrapper OpenCode хранит attemptedStartSessionIds в памяти; durable защита после restart обязана оставаться в core/native receipt path, а не в этом Set.

## Малые эксперименты, способные опровергнуть план

| Эксперимент | Стоимость / действие уполномоченного исполнителя | Что меняет решение |
|---|---|---|
| E1: «OpenCode уже умеет send» | 5–10 мин: на существующем isolated stand проверить tools/list и отдельный deliver; затем read-only receipt. Source уже показывает unsupported в owner_opencode и initial-only v22 | Если второй input невозможен в pinned native family, это native functional gap. Нельзя обещать полный send или решать сменой family без доказательства |
| E2: «все старые адаптеры подключаются одинаково» | 5–10 мин: protected profile validation + initialize/capabilities/read для пяти manifests, без send. Codex path трассировать до TS class | Reject zcode/browser или Rust Codex route опровергает готовность универсального bridge; C1/C2 становятся реальным критическим путём |
| E3: «receipt всегда native user ID» | 5 мин: сравнить сохранённые exact ответы Codex/ZCode/browser с AhapOpenCode admission parser, который требует nativeInputMessageId | Если adapter возвращает только turnId/inputId, нужна typed mapping/reconciliation. Нельзя подставить строку и отметить PASS |
| E4: «wrap init не запускает второй dispatch» | 5–10 мин: source trace constructor/init и isolated process trace; fault injection после одного принятого send, restart core/runner, read-only счётчик native messages | Два native inputs или самопроизвольный wake отменяют reuse без policy separation. Не проводить на живой пользовательской сессии |
| E5: «полный export и projects — простое пробрасывание» | 5–10 мин: сохранённая многостраничная история и реальные project/workspace ответы каждой family, включая пустой account | Missing pages, [] вместо unsupported или synthetic cwd вместо native ID требуют точного контракта до тестов, иначе REPORT будет ложно зелёным |

E1–E3 являются обязательной ранней проверкой обещания срока; E4/E5 — final correctness gates. Эта советующая сессия эксперименты с мутациями не запускала. Внешний browser challenge, provider refusal или отсутствие account scope нельзя лечить подменой evidence или пересылкой старого PASS.

## Основания и границы вывода

Главные локальные источники: новый plan.md; portable CI LEGACY-ADAPTERS.md и B83-GREEN.md; прежние SPEC.md, CI-CONSUMER-CONTRACT.md и FIVE-ADAPTER-ACCEPTANCE.json; перечисленные source paths на проверенном Git-состоянии. Это независимый source/evidence review, не запуск live consumer. Установка LHC1.17.1 и провал parentwake приняты как контекст поручения; их ремонт не включён в Herder critical path.

Поддержать reuse-архитектуру можно сейчас. Подписать обещание полного 5/5 результата за остаток срока можно только после E1–E3, с согласованными projects/deliver semantics и именованным единственным интегратором. Если итоговый синтез снова обозначит отсутствующую wiring как «CI потом проверит», мой вердикт останется REVISE.
