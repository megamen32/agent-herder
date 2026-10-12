# ZCode: остановить новые автопродолжения, сохранить принятую работу

## Узкая source коррекция позднего отключения

В 05:41:44.274 UTC, после OFF05:39:53, native 0cce принял ещё один input
`queue_agent-herder:auto:eeca5ff1-8aec-4bd7-a6b5-60bc9f8d6a33`.
Journal того же parent подтверждает единый planner resume. Ввод сохранён.
`groupAdmissionAllowed` теперь повторно читает существующие semantic policy и
per-session override после awaited admission gate перед resume/send/create.
Recovery OFF остаётся независимым от разрешённого semantic Autopilot.
Нечитаемое разрешение откладывает действие. Это не native CAS и не остановка
уже принятого input или уже исполняющейся внутри адаптера отправки.

Три изолированные RED регрессии воспроизвели отправку после отключения во время
planner, resume и финального admission gate; после коррекции 3 PASS.
Focused integration: весь launcher36 PASS + tsc --noEmit, общий payload46.101s,
RAM peak553549824B, swap/OOM0, finite existing profile120s/CPU1/max1GiB/tasks128.
Контрольный тест сохраняет Autopilot при выключенном recovery.
Первые fixture/setup failures (старый /usr/bin/node12 и неправильный sessionId
в fixture) сохранены и не считаются RED доказательством самого дефекта.
Runner выдал cleanup_held с original cgroup population unknown, затем summary
completed; отдельный readonly systemctl подтвердил owned run-u188291.scope
inactive/dead без ControlGroup. Cleanup предупреждение не скрыто, повторного
payload и ручной остановки процессов не было.
Evidence: `.tmp/zcode-opt-out-regression/` — exact cases, bounded receipts/logs.
Source ещё требует Root review/install; работающий backend6b не менялся.

Владелец диагностики/source/4b consumer: Codex 01a12ddd-6233-7522-8a68-fa932c661d6d.
Владелец runtime/install: Codex 01a12740-96aa-7b93-9bef-679dcae60d84.

## Проверенный результат

12.10.2026 в 05:39:53 UTC через существующие API отключены только два
per-session переключателя, `autopilot` и `session-autostart`, для
`sess_c1400322-3bfd-4ef3-8789-7a366d039d35` и
`sess_0cce8843-51dd-44bd-adb4-6f58d7089dac`, cwd
`/home/roomhacker/PycharmProjects/TelegramAuto`.
Оба прежде наследовали enabled=true. Global/harness policy сохранены.
API setters сохраняют настройки; native stop/cancel/input/queue removal не вызываются.
Эффективные GET после PUT подтвердили enabled=false/source=session для всех четырёх записей.
Native snapshots до/после этих записей совпали; parent3774554/SDK3774779/CLI3966513 сохранены.

Receipt: `.tmp/zcode70a-recovery-20261012/tga-future-launch-pause-summary.json`;
исходные настройки и полные snapshots сохранены отдельно в `tga-future-launch-pause.json`.
Журнал parent3774554 подтверждает новые admissions от existing unified
unfinished-session launcher. Semantic mode проверяет `AutopilotSessionStore`,
обычное восстановление — `SessionAutostartStore`; одного переключателя недостаточно.

## Открытая граница и следующий шаг

При паузе c140 turn7707 уже completed (1791783465274), но native accepted queue639d
оставалась. У 0cce current turn89 сохранялись assistant progress и четыре accepted
inputs. Принятые очереди не удалялись и не отправлялись повторно.
Это не подтверждение idle и не разрешение остановить runtime.

Уже начатый planner pass мог прочитать разрешение до изменения настроек.
Пауза не является атомарным admission barrier. Последующий ограниченный readonly
контроль должен отдельно подтвердить отсутствие новых admissions и состояние
current turns/queues. Исторические pending tool parts сами по себе не доказывают
живую работу; учитывать exact current turn и реальный owned runtime.

Блокер backend install/4b consumer: текущая принятая TGA работа/очереди и неполное
existing-only SDK наблюдение; GET/list timeout нельзя объявлять idle или GREEN.
Root сохраняет backend6b и reviewed compiled candidateab140; frontendab140 уже
доставлен отдельно. После фактической границы Root выполняет единственную установку.
Затем исполнитель повторяет exact 4b crash guards и поддерживаемое восстановление
того же ID без повторного task prompt. 70a completed сохраняется.

## Source hazards, требующие отдельной регрессии

`src/adapters/zcode.ts`: cold ongoing-assistant evidence сейчас вычисляется в
ветке исторического error/cancelled turn; отсутствие подходящего terminal row
не доказывает отсутствие новой native работы.
`src/autopilot/unfinished-session-launcher.ts`: `hasPersistedAssistantAfterAdmission`
используется для `markAdmissionTerminal("turn.completed")`; progress/tool prose
нельзя считать доказанным окончанием exact turn. Повторные live queue additions
доказаны, но отдельная причинная регрессия этих source условий ещё не выполнена.
Runtime пауза устраняет новые разрешённые проходы, не объявляет эти source hazards
исправленными. Следующий source шаг — изолированный exact active-turn/queued-input
fixture и узкий admission guard, после приоритетной установки/recovery границы Root.
Нативное ядро, provider/model, business actions и существующие receipts не менять.
