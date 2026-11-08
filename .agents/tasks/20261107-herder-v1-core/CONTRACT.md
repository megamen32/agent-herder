# Herder V1: Rust core и прежние TypeScript adapters

Решение владельца 07.11.2026; срок **08.11.2026 00:38 МСК**, отсчёт с21:38, включая планирование. Этот план заменяет очередь20261107-herder-native-mcp-breaking; её исходники, receipts, незавершённый Rust adapter WIP и история сохраняются. Это не новый срок после кворума.

## Единственный маршрут

MCP consumer → Rust core → существующий AHAP JSONL → прежний TypeScript adapter → native harness. Старый daemon/index.ts не запускается внутри bridge. Новые Rust реализации native protocol не входят в V1; существующие сохраняются для следующего выпуска. Функциональное ядро и императивные внешние вызовы разделяются без переписывания работающих классов ради стиля.

Core владеет node/instance/session addressing, caller identity, permissions/HumanStop, durable operation/request keys, Tasks и public read/search. Adapter владеет native вызовами и native receipts. Существующие транспортные journals сохраняются; второго решения повторить UNKNOWN/send не возникает. Core request_key детерминированно связывается с adapter inputId и native message/turn IDs; преобразование ZCode сохраняется, read/restart не генерируют новую операцию. Native IDs не синтезируются из request_key.

## Границы файлов

- Astra: crates/herder/src/bin/herder_native_stdio.rs, owner_launch.rs, owner_opencode.rs, scoped_profile.rs, mcp/catalog.rs, launcher_scoped_profile tests; окончательная интеграция.
- Singer: crates/herder/src/adapters/ahap_opencode.rs, tests/ahap_v1_reuse.rs. Общий клиент AHAP, не новый harness adapter.
- Ampere: src/ahap-{opencode,zcode,browser,codex}-runner.ts, optional ahap-legacy-read.ts, соответствующие runner tests. Только экспозиция существующих TS методов.
- Archimedes: новый owner_reads.rs и inline tests. Public reads с существующими authority/index.
- CI: src/adapters/**, packages/agent-resume/**, existing native fixtures/config/report/build/install. Luna сохраняет ownership своего stand; общие tests/native файлы согласуются внутри CI. CI — единственный installer.
- Независимые Astra/Kuhn: critique, без реализации. GLM5.3 принят native, но provider.auth failed; его мнения нет.

## Контракт подключения

Штатный запуск: herder_native_stdio --trusted-owner-profile <protected profile>. Путь binary, runner и digest из immutable manifest. Profile owner: principal,node,instance,kind,executable,ahap_script,code_home,cwd; ahap_base_url сохраняется для OpenCode; дополнительный ahap_env содержит только разрешённые настройки выбранного adapter. Никаких угаданных browser targets/accounts. Разные экземпляры одного harness имеют разные instance и конфигурации.

AHAP0.1 initialize возвращает фактический harness, methods, deliveryModes/controlCapabilities. Существующие методы: init/createSession/sendMessage/getSession/getSessionMessages/listSessions/getRawTranscript/listProjects. Последние два объявляются только при реальной реализации. Не вводим новый RPC-протокол. Raw export wire: bytes_base64, complete, source, timestampCoverage, limitations; false/unknown completeness не повышается до true. Лимит frame сохраняется, слишком большой результат даёт явную ошибку; будущее потоковое расширение не маскируется готовым full export.

Публичные14tools сохраняются; projects — discover(action=projects,instance_ref). Common/native export явно различаются: native bytes не выдаются за нормализованный common. Search использует существующий индекс с ACL и указанием покрытия; projects идут из native/подтверждённого registry, не из CIconfig. Profile trust не означает произвольный доступ к чужим session IDs.

## Приёмка

Пять lanes OpenCode,ChatGPT,Z.ai,ZCode,Codex. Одинаковый обычный consumer для candidate и installed: capabilities → create → initial response → **второе отдельное deliver в ту же сессию** → read обоих input/reply → export с полнотой → search marker с coverage → projects с provenance → restart собственного core и readback без новой отправки. CLI использует настоящий harness с лжемоделью; browser использует выделенный live scope. Source/tests/candidate/installed — разные доказательства.

Общий negative gate: wrong instance/principal отвергается до native call; повтор key не повторяет mutation; другой payload с тем же key конфликтует; потерянный admission остаётся UNKNOWN без resend после restart; HumanStop запрещает новую отправку. Обязательная unsupported операция делает lane незавершённой.

## Исполнимый остаток и предел срока

Листы по15мин, три параллельных writer и Astra-интегратор. Целевые окна: до23:10 bridge/read/launch; до23:25 согласованный candidate;23:25–23:55 consumer lanes;23:55–00:10 только найденные дефекты;00:10–00:25 установка;до00:38 readback/cleanup/отчёт. Это контрольные сроки, не обещание PASS независимо от результата. CI работает по своему20261107-portable-native-ci; этот план хранит ссылки на evidence, не запускает дубль его исполнителей.

Уже выявленные риски срока: OpenCode v22 initial-only ограничение находится и в legacy adapter; Codex/ZCode/browser receipts имеют разные поля; full transcript может превышать frame; запуск всех пяти ещё не доказан. Контрольная отметка22:23 не пройдена: universal launch пока не принят. Продолжаем разрешённую работу, полный5/5 не заявлен.

Не входит в критический путь: новая система scheduler/hooks, переписывание LHC, новый plugin framework, перенос всех adapters на Rust, глобальное удаление legacy, общая миграция флота. Выпуск не отменяет эти прежние цели, но владелец выделил их из V1 своим последним уточнением.

## Поправки независимого recheck

INSTALL разрешён только для окончательного immutable digest с принятой5/5+NEG матрицей. Если FIX меняет bytes, CI пересобирает manifest и повторяет affected lanes/NEG; неизменные доказательства переиспользуются только с явным matching component/config digest. Завершение карточки с gaps не разрешает установку.

V1 обязательный full export использует format=native и точные native bytes/completeness. Common остаётся отдельной неготовой нормализацией, не используется для подмены full. Приёмочный sample включает многостраничную историю; frame overflow возвращает явную ошибку и не считается прошедшим sample.

Wire examples: listSessions params={options:{limit:200}} → массив legacy AgentSession с native id/harness/cwd; getRawTranscript params={id:"exact-native-id"} → {bytes_base64:"...",complete:true,source:{kind:"native-api",location:"...",format:"json"},timestampCoverage:"native"}; listProjects params={} → native adapter project array. Необъявленный метод даёт unsupported, а не []. Projects workspace registry имеет отдельный provenance от native-provider project ID.

OpenCode verified v2.2.4 на текущем CI artifact использует family=v2 /api/session; CI сообщил два последовательных prompt одной session, completedreadback, ровно2modelrequests. Это снимает native second-send риск v2, не доказывает v22. Новый public core всё ещё требует своего consumer proof.

Фиксация R2/R3 — по3мин уже собранных receipts, не отдельные15мин разработки; FIX условные15мин с re-gate. CI исполняет lanes по своим фактическим resource/executor назначениям; эти карточки — приёмка результатов, не дубли native запусков. Без подтверждённой ёмкости срок остаётся рискованным.

## Уточнение владельца 08.11: восстановление браузера

Ремонт и штатный перезапуск managed browser/gateway разрешены для завершения приёмки. Astra ошибочно распространил запрет повторной model send на browser repair; этот запрет снят. CI — единственный владелец browser recovery, включая точный clientroute по canonical runbook, backup/CAS, с сохранением persistentprofile, login/history и чужих drafts. Свой пустой testtarget можно перезагрузить/восстановить; при потере identity создать однозначно owned testtarget. Нельзя угадывать чужие вкладки или удалять профиль. Для исходных UNKNOWN model operations проверить фактический результат по сообщениям и квитанциям. Подтверждённые эффекты использовать; подтверждённое отсутствие эффекта позволяет новую разрешённую попытку. Неизвестность одной операции не запрещает независимые проверки и восстановление. После восстановления нужны actual target/account/QAclaim и весь обычный consumer scenario. Deadline00:38 пропущен, не заменён новым.

Ротация секрета не была разрешена владельцем: прежнее утверждение Astra о прямом поручении ошибочно. После уже произошедшей ротации владелец выбрал «Оставить текущее значение». Задача остановлена; новые изменения токенов, откат и связанные рестарты не выполнять. Самописное ежечасное поручение отменено, wait_e723c3fd8f962a05cf041563a252e0c9 имеет state=cancelled; новых часовых таймеров не создавать.

## Граница UNKNOWN и новых изолированных CI-прогонов

Запрет Accepted/UNKNOWN no-replay относится к конкретной операции и её возможному внешнемуэффекту. Он не запрещает новый независимый регрессионный CI-прогон после исправления в отдельной disposablefixture с новым HOME/authority/nativeinstance/requestIDs и локальнойлжемоделью, изолированной отproduction и прежних instances. Такой прогон не продолжает старую UNKNOWNoperation под новымID и не меняет её исторический результат. CLI lanes OpenCode/Codex/ZCode можно проверять параллельно существующими исполнителями без ожидания browsermilestone. До мутации сохранить originalIDs иretainedstate; реальныеquota/admissionrefusals не обходить. Прежний blanket no-replay в самописном часовом тексте не является прямым запретом владельца на сообщения или проверки. Действует проверка фактического исхода; история сохраняется, подтверждённые эффекты не дублируются.

## Уточнение владельца 08.11: архивирование тестов

После AI-проверки сохранять transcript/receipt и архивировать только свой тестовый
чат штатной native операцией. Новый public action: session/archive с session_ref и
request_key; AHAP archiveSession. Native archive предпочтительнее удаления,
ошибка cleanup сохраняется отдельно. Unsupported archive не подменяется delete.
Текущее распределение: интегратор01a1bb0c — Rust/browser/sole V1 installation;
Terra01a1b77b — CLI archive seam. Старое назначение CI installer выше заменено
прямым поручением владельца интегратору завершать самостоятельно.


## Два профиля Chrome: уточнение владельца и launcher 08.11

Один процесс Rust core обслуживает несколько существующих AHAP адаптеров.
Повторяемый аргумент `--trusted-owner-profile <protected-file>` добавляет
экземпляр адаптера, а не процесс ядра. Все профили этого локального owner-входа
имеют одного principal и разные instance; account/home/authority остаются
привязаны к своему экземпляру. Ordinary `herder-compat` передаёт эти аргументы.
Адресация задач и session_ref сохраняется после restart по существующим receipts.
Маркер ChatGPT-вкладки содержит account scope; два legacy marker одного provider
не дают права закрывать соседнюю вкладку. Direct CDP понимает default Chrome
context и восстанавливает пропавший target по своему account marker внутри
настроенного browser context. Избыточные scoped tabs дают явную ошибку.
Source/fixture тест двух аккаунтов не заменяет живую проверку и установку.
