# Agent Herder: кабинет для всего флота, 10.10.2026

Статус: реализация открыта. Один принятый маршрут 88→100 не означает готовый fleet cabinet.

## Результат пользователя

На 100, 44, 88, Mac Mini и Mac M1 работают собственные Herder с локальными native sessions. Общий кабинет показывает сессии всех доступных узлов, фильтрует их по машине и создаёт сессию по выбранным машине и harness (Codex, ZCode, OpenCode). Недоступность M1 отображается явно; существующие reverse SSH сохраняются. Основной адрес agent.bezrabotnyi.com принадлежит 100; отдельные адреса остальных уточняются по существующему ingress.

Уточнение человека: как GrepMesh, а не через поисковый MCP GrepMesh. Сначала оценить переиспользование уже работающего mesh core GrepMesh/GPTAdmin; общий слой выделять только при доказанном совпадении ответственности. Не связывать native session control с поисковыми инструментами.

## Владение

Исполнитель Herder mesh: native Codex 01a121d1-1aaf-71b2-8d0e-fbba3d8866ca в уже разрешённом worktree agent-herder-harness-mesh-20261009. Интеграция, размещение и реальный кабинет: 01a11755-69a6-7c33-8475-349da94d0f77. Каноническую infra изменять с её владельцем после фактической проверки. UI main.tsx/styles/composer и opencode.ts содержат чужой WIP; перед пересечением установить владельца, не стирать.

## Проверенные факты

09.10 опубликован source meshSender main 1e121b2. Реальная native доставка 88→100 принята единожды; job b8d643fe9a0d4fa5b90ce57ec5493efb, повторять отправку нельзя. Это не acceptance пяти узлов, UI или remote session creation.
10.10 01:47 МСК активному mesh исполнителю доставлен новый пользовательский объём через native steer, turn 01a122d8-53ee-7ff2-ace4-d54c062d4c04, admission=true.

## Следующий шаг и acceptance

Сопоставить GrepMesh core и существующий Herder mesh, согласовать минимальный общий seam; найти владельца текущего UI WIP. Затем отдельные bounded local nodes, общий список/фильтр и выбор host+harness при создании. Каждый реальный поддержанный маршрут проверяется через кабинет, с source/runtime identity и сохранением auth/локальности; неподдержанные harness на узле показываются явно. Отдельно проверить offline M1 без потери сессий. Тесты и build конечные, release fast ≤180s; по каждому узлу записать измеренный бюджет, backup/rollback и receipt. Личные браузеры, ключи, чужие daemon/SSH и принятые отправки сохранить.

## Предварительная проверка размещения (10.10, 01:52 МСК)

Все пять узлов доступны. 44: server-44/x86_64, 88: roomhacker-server-88/x86_64; на обоих agent-herder.service отсутствует, Codex/OpenCode установлены. Mac Mini: mac-mini-2012.lan, LocalHostName Mac-mini-roomhacker, Macmini6,2, 8GiB. M1: MacBook-Pro-User.local, MacBookPro18,2, arm64, 32GiB, reverse2222; Codex/OpenCode/ZCode доступны. Пробу наличия процессов Node нельзя считать полной инвентаризацией: PATH Mini не интерактивный. Никаких runtime изменений пока не выполнено.

agent44/agent88/agent-mac-mini/agent-mac-m1.bezrabotnyi.com уже разрешаются в 95.165.165.65. У agent100 существующие wildcard TLS и GPTAdmin cookie-auth. Отдельные vhost/upstream ещё не опубликованы.

## Существующая общая основа

GrepMesh src/gptadmin.rs использует реестр GPTAdmin /mcp-relay/agents и child /server/<id>/mcp, ограниченные deadline/число узлов, запрет redirect и чужого relay origin. topology.rs предпочитает direct с relay fallback. topology_cache.rs сохраняет host/generation/fetched/expires/error и не продлевает TTL пропавшего узла. Это внутренние Rust-модули, а не готовая межъязыковая библиотека. Нельзя переносить grepmesh-fleet credential/tools в Herder: общий transport/registry сохраняет авторизацию каждого сервиса и пользователя. Reuse seam передан mesh исполнителю; выделение общей библиотеки требует действительно общего контракта и owning GrepMesh участия.

У current root coordinator 01a11b43-e667 запрошены точные владельцы UI WIP и nginx/fleet boundaries; native admission turn 01a122db-99b2-7a50-8b38-433f0547109a. Это предотвращает пересечение, а не запрос повторного разрешения.

## Принятая граница OpenCode WIP

Владелец 01a11747-c694-7340-be48-f973e3c4e568 передал единственное владение integration/publication/deploy трёх OpenCode paths и tracker этой сессии. Исторический focused receipt: 21 PASS, 2.61s, 144MiB, swap0/OOM0. Это не PASS новых зависимостей: перед публикацией нужны текущие focused проверки; handlers/named-session и UI не возвращать к историческим целым файлам. Packet: .tmp/opencode-directory-20261009/owner55-integration-handoff-20261010.json.

UI e944 подтвердил завершение своего опубликованного slice и передал свои seams; текущие dirty UI bytes принадлежат M1 mavis mvs_03faeb0f1aa74d1093d6b2088b16a421 по Root12170. Запрошено согласованное freeze/handoff; новые fleet files исполнителя независимы. При подключении host selector сохраняем current outbox stable inputId, admission/cancel/reconcile и delivery-mode; идентичность remote сессии включает host+harness+nativeId, старые entries не перенаправляются на другой хост.

01:58 МСК: существующий Herder100 active PID1559007, memory794693632 bytes, tasks11. Его действующие пределы: RAM1/2GiB, swap512MiB, CPU4, Tasks512, IOWeight50. Это бюджет существующего сервиса, не переносимый по умолчанию на другие хосты. MacMini имеет 8GiB RAM и swap use1906.5MiB: перед запуском нового daemon нужен свежий trend/reserve и малый измеренный процесс, без browser/model fan-out.

## Критерий общего core

Переиспользуем единый существующий реестр/relay GPTAdmin, а не GrepMesh search API и не новую копию списка хостов. Общие обязанности: идентификатор узла, capabilities, ограниченное обнаружение/проверка, direct/relay route, generation/TTL/offline cache. Локальный исполнитель, native sessions, auth/profile и mutable session state остаются у соответствующего продукта/пользователя. Rust GrepMesh implementation и TypeScript Herder adapter используют общий wire contract; вынос кода в отдельный package имеет смысл только с двумя фактическими consumers и сохранением acceptance работающего GrepMesh.

GrepMesh current dirty tree содержит src/ocr.rs чужого владельца; topology/gptadmin/cache только прочитаны. Никакой extraction/rebuild/restart GrepMesh не выполнен. Native plugin registry Claude указывает установленный пакет LHC1.2.4, Codex cache своего package пока не обнаружен; legacy store не использован.

## Текущий source keeper и переданные пути

Keeper54 явно освободил 7 UI paths: main/styles/codex-theme/composer/json-rendering и два outbox/json tests. Сохранённые bytes переданы sole55 для review, интеграции и scoped publication; whole candidate ещё не accepted. OpenCode3paths также handed off. Новые Fleet components/backend делает01a121d1, подключения main/server.ts делает55.

Root43 передал55 только новые4 nginx-vhost/enable/refresh outputs и соответствующие inventorycards. Existingagent/auth/airlock не переданы и сохраняются. nginxctl refresh→enable→check→scoped push→timer siteapply и фактический deployedSHA/publiccanary.

Актуальные owning Herder/infra инструкции не требуют LHC bootstrap; старый Claude plugin прочитан как справка, но новыйscope ведёт существующий native GSD. Пустой legacycache не blocker.

НаM1 localhost18787 действительно SSHPID36261, forward100; его не трогать. Для нового локального узла предложен свободный18789, worker должен подтвердить runtime seam прежде применения. Mini18787/88/89 свободны.

## Текущая bounded проверка OpenCode (10.10)

Назначение: сохранить project-directory isolation после текущего published ограниченного discovery. Категория fast unit; ожидаемо3s, max120s, существующий herder-delivery-focused100: CPU1/RAM512MiB–1GiB/swap0/tasks128/temp64MiB/IO10. Первый run RED20/21: fixture ожидал отсутствие options, но currentAPI передаёт limit20. Исправлен только owned regression assertion: cwd передаётся OpenCode, другим harness только limit; folderlessOpenCode сохраняетlimit20.

Последующий точный run GREEN21/21, 2files, 2.87s, peak157409280 bytes, swap0, OOM0, same-generation cleanup=true. Receipt .tmp/herder-fleet-20261010/source-check/result-0b070be49d0dd41f362a6a161b737db6.json. Это local logic proof, не acceptance native runtime или всего mesh. Исходный RED receipt сохранён.

OpenCode adopted source e9f9a5edccbcdd76184698243eba8b64006a3fb8 опубликован; commit только3ownedpaths, источник deploy ещё не менялся.

UI review обнаружил реальную потерю fenced-code в Mavis draft: некapturing split удалял целые завершённые/streamed блоки. Pure splitSystemBlocks перенесён в json-rendering.ts,3регрессии сначалаRED25/28, затем capturing-delimiter fix. Current focused units GREEN28/28 (renderer15+outbox13), peak98000896 bytes, swap0/OOM0, cleanup=true; receipt source-check/result-935ffc82b7077ec0c1f467eebf070526.json. Это не UI/native acceptance, source ещё интегрируется. STOP/no-replay сохранены.

## Auth wiring investigation

Существующий защищённый MCP consumer pointer ZCode100: ~/.zcode/cli/config.json → mcp.servers.gptadmin, tenant URL u-f1102930.t.gptadmin.bezrabotnyi.com/mcp и configured opaque bearer (значение не записано). OpenCode100 использует тот же tenantURL без статических headers (native OAuth). GrepMesh credential не используется.

Проверена cookie-auth /check реализация:204 возвращает X-GPTAdmin-User, но existing nginx agent auth snippet лишь gate, не передаёт этот проверенный identity upstream. Fleet backend должен валидировать имеющуюся cookie через existingloopback18991 /check (или поддержанный bearer через Hub) и привязать user/profile. Не доверять user/profile полям тела или клиентским X-GPTAdmin-User, не добавлять owner-token для всех пользователей. Контракт этого authenticated hook принадлежит55.

Transport seam подтверждён существующим ZCode consumer config без mint/копирования ключей: protected tenant MCP facade tools discover/schema/execute/job. Прямые guessedwhoami tools были unknown (не acceptance); supported schema(hub)→execute(hub,access_clients,actionwhoami) реально вернул client_id=zcode,admin=false,access_mode=full. Schema payload wrapped response. Root wiring ограничивает existingSSO roomhacker ↔ configuredconsumer; другие пользователи не наследуют этот bearer. Реализация generictransport принадлежит01a121d1, request auth/factory/hook55.

Fresh facade registry identities: shell:server-44; shell:roomhacker-server-88; shell:roomhacker-server-100; shell:mac-mini-2012.lan; shell:MacBook-Pro-User.local. Child AgentHerder существует только100; два HarnessMesh child100/88. Mac runtime native hostname и registry canonicalMac identity совпадают сейчас. Virtual shell kind=virtual_shell, не shell. Не использовать ошибочный roomhacker-server-44 alias.

## Подключение к основному продукту

55 добавил narrow main import/«Машины» modal без замены локального outbox/session keys; Node MCP factory добавляет fleet_node_info, существующие mesh_snapshot/create_session сохраняются. WebDependencies включает optional authenticated Fleet handler. Новый web/fleet-wiring.ts читает bounded existingZCode config, проверяет SSO cookie through current18991/check либо exact existingbearer, проверяет Hubwhoami clientzcode, сохраняет user+logicalclient journal acrosscredentialrotation, а MCP transports получают immutableheaders отдельной credentialgeneration. UI API defaultHost определяется из allowlisted publicalias, не из клиентского тела. Backendsource01a121d1 ещё должен быть reviewed/интегрирован перед type/build.

Новые4 публичныхentry будут иметь настоящее локальное Herder UI/upstream, а /api/fleet/* переиспользует central100 scopedmanager. Это не требует копировать protected100 bearer на другие узлы. GrepMesh search не используется и не меняется.

Root hooks/fleet-wiring saved; source keeper note93410fca updated with exact owned paths. Основные snippets existingagent100/auth/Airlock не менялись. Producer dependency modules пока в егоworktree, поэтому основной candidate ещё не type/build/deployed. Не считать UI button «Машины» или typings runtime readiness.

## Реальный read до применения runtime

72 integrated local units PASS9.49s, peak194273280 bytes; staged type/frontend build PASS27.14s, peak543993856 bytes, swap0/OOM0/cleanup=true. Candidate собран в ignored lease, runningdist не тронут.

Compiled API real auth/read затемRED503 для existingconfiguredcaller (forgedheader401 и invalidcookie403 прошли), без native/business mutation. Producer независимым реальным transport read доказал, что3s/default undersized: discover2.284s, schema3s timeout;5s reads реальноPASS discover3.855/schema2.792/snapshot3.837, всего10.487s. Применяем narrow5s/read +30s aggregate repair; currentcandidate не runtimeaccepted, invalidSourceArtifactне deploy. Новый wiring scope включает tenantorigin+logicalclient+user, journal сохраняется при credentialrotation; safeenum diagnostic включён без rawresponse/headers.

Auth bind теперь также schema-first(hub) перед actualaccess_clients/whoami, как verifiednative поддержанный маршрут; tenantorigin включён в immutableprofile scope. Read-only snapshot/source profile на других узлах не создаётся.

Independent review MEDIUM: currentHubwhoami не раскрывает effective policyprofile. Выбран cheapest failclosed current-approved-singlecaller, без Corefork/tokenmanager: sourcebinding проверяет exact existingcredential-generation pin beforeanyreads, accessmodefull only, scope tenantorigin/client/user. Изменение credential не переинтерпретирует существующийjournal и не получает автоматическийдоступ; нужна фактическая проверка effectiveprofile передявнымadoption/rotation. Pin безопасный SHA хранитсяprivatereceipt, secretvalues не копируются. Broader multi-profile isolation/runtime-global migration остаютсяOPEN; single-operator cabinet не выдаём за ихacceptance.

Current pinned-source build первоначально held exit75: short aggregate max capacity exhausted. Payload не стартовал, текущие чужиеQA/leases/caps не трогаем. Повтор существующимrunner ждётslot до60s; не обходить SSHscope/другимprofile. До source-pin build/realread GREEN никакихdeploy/configactivation. Safe independent native inventory: 44Codex/OpenCode available, ZCodebinary не найден;88 ZCodepayload+OpenCode есть;MiniCodex/Node есть, OpenCode/ZCode отсутствуют;M1wrapperZCode есть, directagentpath отличается. Shared Codexsocket нужно брать actualmanagedpointer, guessed ~/.codex/{app-server,sockets} отсутствуют.

Slot освобождён штатнымwait: pinnedsource buildPASS, peak548806656 bytes/swap0/OOM0/cleanup. RealpinnedAPI опятьRED503/gptadmin_deadline; причиналокализована к firstbind, не auth/user scope. Фазовый realdiag с10s: initialize290ms, initialized572ms, schemaHub1125ms, total1996ms; whoami738ms реальноzcode/full. Initialbind включает3sequentialrequests, его boundeddeadline10s; peerreads5/global30неувеличены, retries/mutations0. Нужна новая actualcompiledAPI read передprod.

Sharednativecontrolsocket44/88/Mini доказан actualexists+socket+symlinktarget .codex/app-server-control/app-server-control.sock. M1 этотpublishedpointer отсутствует, поэтому не запускать competing native app-server; требуется actualsupported existing socket или установка fleet approvedcontrolseam, не выдаватьwrapperpresence за nativecreate-ready.

## Проверенный кандидат перед публикацией (10.10)

Интегрированы reviewed fleet5a61c00 + latency05442ab, OpenCodee9f9a5e и переданные семь UI paths. Current ordinary relevant checks:77 fast units PASS, staged TypeScript/frontend build PASS; combined active payload <60s (hard release window180s). Последний build peak546025472 bytes, swap0/OOM0; exact159 input SHA matches current source. Build lease bounded-cajpl0_p/candidate, receipt23d1ecff002af8f585b65544c7478529.

Реальное чтение compiledAPI через существующий tenant/auth: existingconfiguredcaller200, forgeduser401, invalidcookie403, bodyuser/profile injection400, changedcredentialpin503 beforeupstream. Five displayed hosts пока unavailable: старыйruntime100 не раскрывает fleet_node_info, другие fullnodes ещё не установлены. Это auth/read acceptance, не nativecreate/fleetready. Receipt source-check/bounded-ffob8uso/real-api-read-receipt.json; peak53657600 bytes/swap0/OOM0/cleanup. Число business/native mutations0.

Следующий шаг: published exactsource + backup/finite unchanged100budget + coordinatedreload; затем nativeidentity, actualcabinet и ONE harmless sessioncreation. Remote44/88/Mini/M1 требуют локального Herder/controlseam и своих измеренных бюджетов. Source publisher/runtimeexecutor55; competingdeployment0. Parent sharedSTDIO/globalMCPmigration остаютсяOPEN.

## Runtime100 и candidate для Linux nodes

Publishedsource d6395ff2817800e72739845efbd4f019dcc2e6a3 установлен в existingHerder100, rollback .tmp/herder-fleet-20261010/runtime-100/dist-before. ActualPID296724, source manifest exact159inputs, nativefleet_node_info hostname/user совпали; codex/zcode/opencode advertised. RAMsteady480452608 bytes/tasks11, existing1/2GiB/swap512MiB/CPU4/tasks512/IO50 unchanged. Послеfreshrelayread100 READY,88 metadata_only,44/Macs ещё notregistered; independent laterread100 stale/fleet_read_deadline retainedIDs. Fresh latency proof underway producer, not missingidentity. Accepted businessinputs не повторялись.

New44/88 finite candidate: CPU1, RAMhigh384/max768MiB, swap0, tasks128, NOFILE4096, IOWeight10, V8heap512MiB; own temp128MiB + state64MiB watchdog, log16MiB hardfilelimit, artifact+two releases≤512MiB disk, required hostreserve4GiB/diskreserve2GiB. Fresh44:78.1GBavailable/UID54.6GB, PSI0/swap0;88:90.2GBavailable/UID39.5GB, PSI0/swap0. No model/browser/build starts there; reuse managedCodexsocket,88 existingOpenCodeserve4097/authinmemory.44 OpenCode serve notyetproved/ZCodepayload absent, advertiseonlyverified configured controls. Budgets are candidate until actualstartuppeak/steady measured. Linuxnode wrapper and unit source owned55.

Portable exactd6395ff package SHA a8605de7141c6ee498815b66655dfafa2aca3cf0ced4d8b447777eb6bedbdd86,20,068,744bytes,250 portableJS packages; nativeClaude optionalplatform packages excluded and adapterdisabled. Packagerpeak149770240 bytes, swap0/OOM0/cleanup. Mac native conversion/Claude notclaimed by this archive.

Actual88 install found two concrete delivery issues before acceptance: symlinked main argv didnot match index import.meta realpath, causing exit0 beforemain; ownbootstrap now resolvesentry beforeexec. Existingforeign18789 listener PID308053 preserved; node88 uses explicitfree18790, no same100/foreignthin identity substitute. Startup source wasnotGREEN; firstservice wasinactive and no nativeinputs sent.

## Текущая consumer проверка

Latency repair0fec736 integrated/published e62e6a3; actual100+88 fleetREADY read21.254s, three44/Macs still unregistered at that read.83 relevant fastunits PASS/peak179441664 bytes; stagedbuild555212800 bytes, swap0/OOM0/cleanup, ordinary payload<60s. CurrentportableE62 artifact abbd21b727c713b369af6230b86458241089fa8c3f6456a64617f39e6b1435da. Native44 localHerder started CPU1/RAM384–768MiB/swap0/tasks128, actualserver-44/roomhacker/Codex,steady85950464 bytes/tasks9; OpenCode/ZCode unavailable and not advertised. Registered88 actualchildschema46tools, fleet_node_info same88; registered44 newAgentHerder only, olddisabled/enabledMCP unchanged.

Agent88 publicingress source8f84fab and deployedGitSHA match; strictverifiedHTTPS302. Existingcert didnot covernewname; separateagent88cert HTTP01 issuedunder finite128/256MiB/CPU1/tasks64/swap0/wall120 rootunit, no nginxstop/globalcertmutation. SANagent88/notAfter2027-01-07. Nativeupstream21788 SSH88:18791 checked beforepublish.

HeadedMiniQA actualown t15 targetB324E20F7E8402DB1395D841CDBC3545 openedpublic100(titleAgentHerder) withSSOexistingprofile.14foreigntabs retained, creates0. BeforeFleetclick watchdogstoppedChrome:1719100KiB>1536MiB; CPU73%/hostfree3.9GiB, last-run resource_budget memory. ReportedRoot exactblocker. Freshinstalledwatchdog alreadymatchespublished cbb0257 and hasmoderatepressure loop, oldrunningPID hadnotactivatedit.9223 unoccupied, LaunchAgentnotrunning/no activeleasefilefound. ONEexistingLaunchAgentkickstart usesunchanged reviewedbounds/profile; noforeignpersonalbrowser, no capincrease/newbrowsercopy. On renewedrefusal preserveblocker/no restartloop.

Newremote publiccabinets also requirethe currentverifiedSSOowner gate beforelocal sessionexposure, not merelyanyloggedinuser. Narrow/api/fleet/access status-onlyauth hook prepared; no auth/tokenmanagerfork; existingrealmcookie/login reusable. Type/build/realstatusread requiredbeforedeploy.

Correction по QA: actualSSHprecondition9223-unoccupied отказалдоkickstart, поэтому55 НЕ запускал/перезапускалQAChrome. Root передалактуальнуюcanonicallease owner01a11b2a-750c.../valid_untilcaptured_finish/releaseR38; file .tmp/fleet-capacity-20261009/mini-autofind-lease-handoff.json. RuntimeownerR38 alreadyhandlespublishedguard/currentbrowser. No newMiniQAactionsuntilruntimeFINISH/newlease. ОтсутствиеleaseвprivateMiniпапке неявляетсяreleaseproof; предыдущая запись ONEkickstart былаintent, неresult.

## Owner gate result / current blocker

Status-only compiled/api/fleet/access realchecks PASS: forgedprincipal401, invalidcookie403, exactapprovedcaller204, POST405; mutations0, peak52379648bytes/swap0/OOM0/cleanup. Build owner-gate compiledcandidate bounded-qkdgv_s0 peak556711936bytes;83 priorintegratedlogicchecks stillmatch unaffectedmodules. Newremoteingress willauth_request thissameSSOowner gate, preservingexistinglogin/cookie and denying otherusers localowner sessionaccess. Parentmulti-profilebinding notclaimed.

Rootverified actualMiniQA ownerR38 recoveredSAMEprofile/currentChrome14528/9223, installedcbb0257/e84 moderate-only activated, warm30s≤1536MiB, nativecontrolreceipt. Currentlease2aPilot9ONLYROcapture+cleanup validuntilcapturedrelease;55 QAblockeduntilR38 newlease. Exactour oldtarget/session/URL handedR38 forrebind; no newtab/browserrestart/click/create. ContinueindependentfleetLinux/auth/ingress whilewaiting.
