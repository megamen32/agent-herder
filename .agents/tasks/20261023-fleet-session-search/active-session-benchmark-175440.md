# Три последовательные проверки активных сессий — 23.10.2026

Режим: только чтение; без исправлений, перезапусков, новых сессий и отправок. `running` не смешивался с needs_input или статусом FTS-индекса. Измерения perf_counter включают сетевой вызов, получение и разбор ответа; длительность логической проверки также включает промежутки между вызовами и интерпретацию.

| Проверка | UTC начало → конец | МСК начало → конец | Время | Результат |
| --- | --- | --- | --- | --- |
| 1. Все пять компьютеров | 17:54:40.224414 → 17:55:15.275606 | 20:54:40.224 → 20:55:15.276 | 35.051 с | Herder показал11 running на100; точное число UNKNOWN из-за неполноты |
| 2. Отдельно Mac M1, после проверки1 | 17:55:38.142697 → 17:55:44.153539 | 20:55:38.143 → 20:55:44.154 | 6.011 с | Herder вернул0, но complete=false/limited=true: число UNKNOWN |
| 3. Физический runtime и рабочие контексты | 17:56:30.705500 → 17:58:04.789906 | 20:56:30.705 → 20:58:04.790 | 94.084 с | M1 native GUI подтверждён;23 started не означают23 реально работающих |

Проверки шли строго последовательно. Внутри1 и начальной физической фазы3 узлы запрошены параллельно. Время между проверками не приписано вызовам. Время до первого измеренного I/O неизвестно; это не оценка длительности всего пользовательского запроса.

От первого измеренного I/O17:54:40.224UTC до конца проверки3 прошло204.566с. Сумма трёх логических проверок135.146с; межпроверочные промежутки69.420с. У проверки1 измеренные попытки7.546с, промежуточная обработка27.505с. У проверки3 измеренные request-фазы приблизительно7.702с, оставшиеся86.382с — orchestration/интерпретация, не доказанная задержка сервера.

## Проверка1: контракт и время каждого узла

Первый попытка 17:54:40.224414–17:54:40.560942UTC заняла337мс: `/api/fleet/nodes`404 за114мс; запросы list_agents(limit1000) отклонены схемой до исполнения, фактический максимум100. Ошибки не превращены в нули. Поскольку текущий nodes route отсутствовал, использованы ранее проверенные пять configured host IDs; живое повторное открытие конфигурационного списка не доказано.

Явно отмеченный повтор с допустимымlimit100:17:55:08.066374–17:55:15.275606UTC,7209мс. Запрос каждого узла: root100 HTTP MCP `/mcp`, tool list_agents, arguments `{hostId:<точный узел>,status:"running",limit:100,includeLastMessage:false}`.

| hostId | total/sessions returned | complete | limited | unavailable | Время запроса |
| --- | --- | --- | --- | --- | --- |
| roomhacker-server-100 | 11/11 | false | true | [] | 7207мс |
| server-44 | 0/0 | true | false | [] | 1426мс |
| roomhacker-server-88 | 0/0 | false | true | [] | 2538мс |
| mac-mini-2012.lan | 0/0 | true | false | [] | 1973мс |
| MacBook-Pro-User.local | 0/0 | false | true | [] | 7180мс |

Пустой unavailable[] не отменяет неполноту complete=false.11 — наблюдённое число строк, не доказанный точный размер флота. Запросы100/M1 определили длительность параллельного прохода. Отдельные внутренние native/transport стадии MCP не измерялись.337+7209мс — длительности попыток;27.505с — промежуток валидации/интерпретации и запуска повтора внутри общей проверки.

Найденные100: десятьCodex, одинZCode. СемьCodex имеют meta.nativeLastTurn.status=inProgress:01a169a2-e8bd-7c43-957e-8b3bc990c75f,01a169e1-9214-7e82-8a24-7080514c4cc2,01a16938-5314-7150-a996-2168c80471e3,01a16939-ae62-7852-ab74-0b13f96246dc,01a169d4-3fa4-76f3-b8f0-5ef201943346,01a169d9-cefe-7ad0-af52-b3856b115e5b,01a16987-f6fd-7351-b61d-a3647396a867. Ещё три running Codex subagent:01a169c3-3f10-7c23-8aa8-f7cb3fbcc4e0,01a1693a-4ca2-7853-8b7b-c8778e8e0f10,01a169ad-a73f-7581-9fe3-0624616991e8 — без nativeLastTurn в ответе; отдельная активная генерация каждого не подтверждена. Это сообщения реального adapter transport codex-app-server, а не FTS.

ZCode session_b38b92e45be8939782ee5863251407b4 показан running, одновременно meta.persistedTaskStatus=completed,discoverySource=tasks-index. Это существенная неоднозначность busy, не доказательство работающей генерации. Во время замера не исправлялась.

Происхождение семи Codex nativeLastTurn=inProgress: поля метаданных реального ответа Herder list_agents через codex-app-server adapter; отдельных direct native thread/read для семи сессий не было. Поэтому это семь adapter-reported native turn states, а не семь независимо доказанных текущих исполнений. ZCode противоречие выше также сохранено как evidence существующего consumer ответа, без предположения о выполнении старой completed задачи.

Рабочие CWD100: семь AutoFindClient, одна airlock-internal, две agents-projects, одна TelegramAuto. CWD сам по себе не доказывает физическое место исполнения.

## Проверка2

Тот же root MCP запрос только к MacBook-Pro-User.local, statusrunning,limit100. Ответ: `{complete:false,unavailable:[],total:0,limited:true,sessions:[],filters:{harness:"all",status:"running",limit:100,hostId:"MacBook-Pro-User.local",includeLastMessage:false}}`.6011мс. Это повторный последовательный, потенциально прогретый путь; равенство состояния с проверкой1 не предполагается. Ответ не даёт истинного нуля.

## Проверка3: прямые источники и физическое размещение

Начальная фаза5узлов1433мс; wall по transport/local subprocess:100433мс,44422мс,88392мс,Mini1426мс,M1465мс. Измеренное выполнение native probe внутри хоста:100369мс,4475мс,8897мс,Mini288мс,M185мс. Разница включает SSH/запуск/сериализацию, её отдельные компоненты не измерялись.

Физические identities:100/44/88 Linuxx86_64 с соответствующими hostname; Mini mac-mini-2012.lan/Macmini6,2/x86_64; M1 MacBook-Pro-User.local/MacBookPro18,2/arm64. M1 проверен через durableSSH2222. Настоящий Mavis GUI M1 PID5359 `/Applications/MiniMax Code.app/Contents/MacOS/MiniMax Code`, helper5404 и собственный nativeAPI18791. Это не серверный GUI и не контейнер на100.

Native100 Codex PID79966: executable standalone0.162.1, cgroup codex-managed-runtime.service, cwd/home/roomhacker, mountnamespace4026531841. ZCode PID1201478: own3.16.3runtime, systemd com.zhipu.zcode.server.ce62699d.service, cwd video_watching, тот же hostmountnamespace. Отдельный Codex PID4086444 также физически100. Наличие процессов на44/88/Mini зафиксировано, но число процессов не приравнивалось числу активных сессий; для пустых неполных списков истинный count остаётся UNKNOWN.

M1 readonly native SQLite `/Users/user/.minimax/v2/sqlite/runtime-state.sqlite`:23 status=started,1119idle,71aborted,26error,4interrupted. Строк со значением status=running нет; нельзя трактовать это как0активных. Все23started отдельно прочитаны через реальный nativeAPI, у всех status_type1. Семь одновременно содержат error: три50150rate limit и четыре50113timeout/connection/compaction. Это демонстрирует, почему status_type1 не является доказательством текущего исполнения.

Рабочие контексты этих23кандидатов:16 `/Users/user/Documents/ServerAdministartion`;2его `.worktrees/fork-502c79b177e3-79573c55db424e36b6b3fbc18d78c298`;5 `/Users/user/Documents/intergation.media`. APIworkspace совпал с nativeDB, не с псевдоHerdercwd~/.minimax.

LHC mvs_92b7a29fcb6147ae848063c2e62bf864: native started/status_type1 вместе со старой50113timeout. При этом последние native сообщения и tool records продолжаются вплоть до17:57, то есть error/status метаданные отстают. Последние tool states2 сами по себе не доказывают наличие активного текущего tool execution. Реально прочитан bounded latest history, без выполнения команд. Recent bash records содержат SSH и серверные пути `/home/roomhacker/agents-projects/LastHumanCommit-mavis-1444`, `/home/roomhacker/agents-projects/agent-harness-fleet`; локальный staging также встречается `/Users/user/Documents/ServerAdministartion/.tmp/lhc-audit`. Точный destination SSH из ограниченной безопасной проекции не установлен: executiontarget UNKNOWN, а не выведен из названия или пути. Физический GUIhostM1 подтверждён отдельно.

M1 чтение23nativeAPI+latest8history заняло3149мс, из них1722мсhistory; отдельные API8–1358мс при параллельной группе8. Последующие ограниченные process/read-history projection фазы~1.862с и1.258с wall. Большая часть94.084с проверки3 — orchestration/интерпретация между вызовами, не SQL или inference. Местоположение облачного inference не измерялось и не угадывалось.

## Итог границ

Точные текущие running counts флота иM1 не доказаны существующим неполным consumer ответом. Наблюдение11reportedrunning100 и23nativeM1started — разные определения; складывать их нельзя. Ошибки, неполнота и неоднозначный busy сохранены. Никакой дефект во время трёх замеров не исправлялся. Файл — единственная запись этой measurement leaf; commit/push не выполнялись.
