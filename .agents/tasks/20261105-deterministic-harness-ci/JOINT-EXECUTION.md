# CI: ближайший полезный выпуск совместно с новым Herder

Уточнение владельца07.11.2026. Основной scope этой сессии остаётся CI+ChatGPT/Z.ai; её текущая работа и прямые запреты сохраняются. Пять целевых адаптеров общей очереди: OpenCode, ChatGPT, Z.ai, ZCode, Codex. Общий продуктовый порядок: ../20261107-herder-native-mcp-breaking/JOINT-EXECUTION.md. Прогресс: ../20261107-herder-native-mcp-breaking/QUIET-COORDINATION.md.

## Уже работающая основа

L100: изолированный bundle1f1cfcd8, реальные Codex0.167.0/OpenCode2.1.3, по2 сессии,3страницы,search,по2 model calls,7.252s. L45: ZCode3.17.2 с лжемоделью,2сессии,8+8страниц,26.6s. L92: установленный ChatGPT transcript12events/3pages. L98: установленный Z.ai30events/3pages. Сохранить эти drivers, fixtures, canary refs и права; не повторять уже принятые sends ради нового отчёта.

## Ближайшая очередь

1. CISHARE (5–10мин): передать в plan evidence manifest существующих runner/launch/model/receipt входов для пяти harness. Указать source commit, точный допустимый argv/профиль, что candidate и что installed. Ссылки без секретов. Не новый тестовый framework.
2. CIGATE (10–15мин): подключить уже работающий candidate suite к существующему release pipeline одной точкой вызова. Сначала OpenCode плюс имеющийся Codex baseline; добавить имеющийся ZCode driver. Отсутствующий обязательный lane → INCOMPLETE/nonzero, не PASS. Искусственный сбой fixture должен блокировать принятие сборки; network/model isolation сохраняется.
3. CIINSTALLED (10–15мин на известный объект): разрешить точный оставшийся вопрос: как штатный установленный Herder обращается к собственной тестовой сессии через уже поддержанный маршрут. Использовать рекомендацию L102, read-only первичную проверку capabilities и существующий session/instance selection. Не менять рабочие настройки, не строить запрещённый отдельный test route. Если штатный маршрут отсутствует — один воспроизводимый пробел/конкретная минимальная product правка для Terra; не серия новых fingerprint audits. Без этого installed PASS запрещён.
4. L101 (10–15мин активной работы, естественное ожидание отдельно): ChatGPT running→idle→одно continuation→HumanStop в уже делегированной тестовой сессии. Использовать backoff, не новые чаты ради ожидания, не повторять UNKNOWN. Эта операция идёт параллельно CLI pipeline при независимых файлах.
5. L99: Z.ai security-check refresh проверяется только при естественном появлении. Это waiting external event, не причина держать весь CI/пять adapters. Имеющийся source shield сохранить. Редкий transcript timeout — отдельный открытый defect с receipt, не скрывать и не расширять всю матрицу из-за него.
6. CIGATEINSTALLED (10–15мин после маршрута): release acceptance запускает тот же suite на действующем installed instance и записывает runtime revision+session IDs. Candidate green без installed green оставляет release unaccepted. Сначала dev/разрешённый тестовый scope, затем штатный release; не новая раскатка всего флота для каждой микроправки.

## Граница нового core

CI не пишет новый adapter и не владеет Rust Cargo/lib. Luna владеет AHAP consumer wrapper, использующим существующую лжемодель. Новый core проходит тот же business contract через параметр runner/entrypoint; старый CI продолжает быть полезен текущим пользователям. Термины candidate bundle, isolated installed bytes и действующий installed PID не смешивать.

Расширение на остальные harness и дополнительные attestations не входит в ближайшую волну пяти; старые обязательства/баги не удалять. Для текущего критического пути нужны надёжный existing suite, реальный installed route и release gate. Сроки15мин задают размер конкретного шага; неизвестный installed route сначала отдельный research результат.

Обычные сообщения Astra выключены: писать leaf/result/evidence/next. Срочное решение/ownership collision — одно адресное сообщение. Не ждать ACK или разрешения на следующий уже назначенный шаг. Полный CI Done: обязательный pipeline работает, проверяет реальный установленный consumer, исходные применимые критерии и открытые баги закрыты или явно отложены человеком.

## Точный handoff и полнота gate

Канонический CI: /home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261105-deterministic-harness-ci. Канонический Herder: /home/roomhacker/agents-projects/agent-herder/.agents/tasks/20261107-herder-native-mcp-breaking. Все C* и L101 записывает CI lead. L102/L103 уже ведутся: CIINSTALLED принимает их evidence, не второй оператор/второй create. QCHATCASE выполняет browser worker после явного exact scope handoff в CISHARE; один target с L101 используется последовательно под существующим lease. Нет scope — только этот live case waiting.

CIGATE сначала выпускает полезный CLI-only этап с явным scope. Полный gate пяти читает FIVE-ADAPTER-ACCEPTANCE.json из Herder плана: все пять harness, candidate/installed identity и create/deliver/read/transcript/isolation/restart/no-replay/HumanStop. Отсутствующий browser installed receipt, старый несовместимый core или candidate вместо installed дают INCOMPLETE/nonzero. Обычная ссылка на старый PASS недостаточна. Включить эти три отрицательных fixture в существующий gate, без повторных native sends. Полный AC01–AC18 не закрывается этим промежуточным выпуском.

CIGATEINSTALLED запускается только при положительном CIINSTALLED route proof; если research обнаружил gap, сначала добавляется точная fix dependency. Исследование с найденным пробелом может быть done как research, но не удовлетворяет runtime gate. L99 ждёт естественного события и не блокирует CLI-only выпуск; оно остаётся открытым для соответствующего полного acceptance.
