# Выпуски и переключение runtime

Связанные контракты: [dev-release](../dev-release.md), [process leases runtime](../process-leases-runtime.md), [canonical release cutover](../canonical-release-cutover.md), [owner bootstrap](../../deploy/fleet/owner-bootstrap/README.md), [release implementation record](../implementation/process-leases-20261113.md).

## Что система делает сейчас

Кандидат собирается из зафиксированного чистого source tree; immutable manifest связывает revision, компоненты, профили и хеши. Owner bootstrap создаёт только новую изолированную authority и отказывается усыновлять уже существующее состояние. Он не устанавливает Herder и не мигрирует live database.

Установка проходит существующий release coordinator: admission/lease, rollback snapshot, подготовка состояния, CAS launcher/selector, restart, затем native и TS consumer receipts. Публичный child selector и default CLI selector различны. Компоненты composite release сохраняют собственное происхождение; верхний manifest не доказывает идентичность запущенного core.

Linux использует systemd entrypoint; локальный macOS supervision описан через launchd. Это не утверждает, что данный checkout уже установлен на конкретном узле или что live service сейчас соответствует ему. `dev-release.py` сокращает команды и направляет promote/rollback в штатный guarded rollout; green содержит fake/native candidate gate.

Для UNKNOWN, потерянного ACK, частичного switch, истёкшей admission или неожиданного PID автоматический restart/rollback не выполняется. Сохраняются checkpoint и rollback evidence; решение требует reconciliation и проверенного состояния.

## Проблема

Подтверждённой текущей поломки выпуска в этих источниках нет. Архитектурный риск: успешная сборка легко воспринимается как установленный runtime; composite manifest может скрыть разные версии компонентов, а два selector направляют разные потребители. Повтор команды после неопределённого результата может создать второй выпуск или повторить restart поверх частичного переключения.

Исторические baseline и PID в runbook — снимки на конкретные даты, не текущее live-доказательство.

## Идеальная система

Каждый release — неизменяемый набор артефактов и provenance. Один владелец release state фиксирует admission, expected hashes, checkpoints и consumer receipts. Чистая функция принимает решение о допустимом переходе по candidate и текущему selector snapshot; порты выполняют установку, CAS, restart и readback.

Owner bootstrap остаётся отдельной операцией первичного создания новой authority с отказом при занятом пути. Selector для каждого consumer изменяется CAS по ожидаемому digest; rollback восстанавливает только известные прежние bytes при подтверждённой admission и не откатывает общую базу или claims.

## Идеальный конечный результат

Одна команда проходит build → fake CI gate → guarded promote → restart → consumer readback и выдаёт связанный набор release receipts. Установленный процесс и оба селектора однозначно сопоставлены точным immutable компонентам. При UNKNOWN операция остаётся в одном checkpoint и продолжается только reconciliation; никакого второго build/install/restart автоматически не появляется.

## Анализ по ТРИЗ

Причинная цепочка: много компонентов и потребителей → несколько сборок/селекторов → частичное переключение или расхождение версий → исходники ошибочно принимаются за рабочий runtime. Упрощение выпуска одной командой может скрыть критические состояния, если команда автоматически повторяет побочные эффекты.

Противоречие: оператору нужна одна короткая команда, системе нужны точные отдельные переходы и evidence. Это техническое противоречие между простотой управления и наблюдаемостью транзакции.

Принцип разделения — по фазам и владельцам: одна команда оркестрирует уже существующие build, gate, guarded install, restart и readback; каждая фаза сохраняет свой receipt. Неопределённость отделена от повторного запуска и представлена как UNKNOWN с durable checkpoint. Rollback существует как явный переход по сохранённым байтам и текущему fence.

Проверяемая польза: каждый установленный процесс имеет точный artifact digest и consumer receipt; selector CAS отклоняет конкурентное изменение; потерянный ACK оставляет один checkpoint без второго install/restart.

## Ресурсы

- **Вещественные:** immutable candidate directory, owner bootstrap binary, launcher, selectors, systemd/launchd manager, release coordinator и rollback snapshot.
- **Информационные:** source revision/dirty status, per-component digest/provenance, base selector digest, admission token/fence, phase checkpoint, PID/config identity и consumer receipt.
- **Временные:** непрерывно удерживаемая rollout admission на mutation, deadline gate и restart/readiness window.
- **Полезные побочные:** fake model/native stand обеспечивает быстрый детерминированный интеграционный gate до установки; он не является live acceptance.
- **Обратимые:** selector/launcher bytes можно вернуть при точном совпадении ожидаемых hash; authority database и durable claims не являются rollback-копией.

## Спецификация

- **Владелец состояния:** штатный release coordinator и его durable checkpoint под canonical release claim. Селектор владеет выбором компонента для соответствующего consumer; OS service manager — фактическим процессом.
- **Чистое решение:** проверить чистый committed source, immutable manifest, component provenance, profile bindings, gate receipt, expected selector hashes, release fence и допустимую фазу; получить решение build/promote/reconcile/rollback.
- **Эффект через порты:** собрать артефакт; выполнить fake gate; эксклюзивно подготовить private state; CAS launcher и каждый selector; попросить systemd/launchd restart; прочитать process identity и consumer endpoint. Bootstrap создаёт только новую изолированную authority.
- **Одна проверка на правильной границе:** coordinator непосредственно перед первой mutation проверяет живую admission и базовые selector hashes; ту же admission удерживает до записанного terminal checkpoint.
- **Наблюдаемый результат:** manifest с digest каждого компонента; green gate receipt; durable phase/checkpoint; точные selector bytes; process executable/config identity после restart; native/TS consumer readback. UNKNOWN сохраняет checkpoint и не инициирует повтор.
- **Минимальные сценарии:** build из committed clean revision; fake gate отказ; selector изменён конкурентом; потерян ACK до/после CAS; restart с неверным PID/config; consumer schema отказ; успешный rollback по тому же release proof; owner bootstrap на новом и занятом пути; потребитель CLI и публичный child с разными selector.

## План и приёмка

1. Сохранять immutable artifacts и component provenance; отделять build receipt от installed process evidence.
2. Пропускать install и restart только через существующий guarded coordinator с CAS и rollback snapshot; одна команда должна передавать результат шага дальше, а UNKNOWN — завершать команду без побочного повтора.
3. После restart сверять точный процесс, launcher/config, оба нужных selector и обычный native/TS consumer readback. Не выводить live status из исходников, CI или старых PID.
4. Принимать выпуск, когда fake gate, guarded transition и consumer receipts связаны одним release identity; при ошибке/UNKNOWN исходный checkpoint читается и остаётся единственным. Установка и выкладка в рамках этой документационной спецификации не выполняются.

Для уже собранного recovery-релиза существует одна команда `herder-recovery-rollout` на контроллере. Она обновляет единственного локального владельца из плана. При явном выборе удалённого узла команда завершается до установки. Повтор команды сверяет ранее начатую операцию с текущим селектором и процессом. Если имеющиеся квитанции уже доказывают переход, он заканчивается без второго рестарта. [Репозиторный entry point](../../deploy/fleet/rollout-recovery) · [Использование команды](../../deploy/fleet/README.md#upgrade-native-recovery-owners)

Сборку и адресную браузерную активацию следует подключить к существующему driver-у там, где ему не хватает конкретного перехода, без параллельного скрипта установки. [dev-release](../dev-release.md) · [Порядок переключения](../process-leases-runtime.md)
