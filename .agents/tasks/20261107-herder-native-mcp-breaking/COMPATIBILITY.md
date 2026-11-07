# Удаляемый MCP-транслятор — решение владельца 07.11.2026

Прямое решение владельца заменяет прежний полный запрет legacy bridge: неизменённые старые клиенты подключаются через отдельный translator, внутри Herder остаётся native MCP 2026-07-28. Codex не форкать. Не возвращать старый Herder daemon, jobs API или второй Task store.

## Граница

Legacy client → отдельный herder-compat → публичный native MCP Herder.
Новый клиент → native MCP Herder напрямую.

Отдельный crate/binary и launcher/config entry в этом репозитории. Ядро не зависит от legacy crate; общий контракт можно импортировать в translator в одном направлении. После удаления compatibility package и его конфигурации native сборка и сценарий продолжают работать. Точную SDK-зависимость translator закрепить маленьким compile/wire gate, не писать свой MCP стек при готовом официальном SDK.

Старый endpoint объявляет только проверенные wire revisions (первая проверка — наблюдавшаяся у Codex 2025-06-18); upstream работает на закреплённом новом wire. Это явный endpoint/config, не скрытое понижение протокола native endpoint. Отдельный Hub fork не нужен: существующий Hub может направлять к compatibility endpoint, если пропускает обычные legacy tools/resources. Его фактический путь проверяется своим consumer gate.

Translator переносит стандартные MCP методы и полученный upstream каталог. Не писать отдельный обработчик перевода для каждого инструмента Herder и не зашивать Codex в правила: 14 — текущее число native tools, а не 14 копий бизнес-логики. Продуктовые handlers остаются в Herder.

## Отображение возможностей

| Возможность | Старый клиент | Native Herder |
|---|---|---|
| 14 предметных инструментов | Обычные tools/list и tools/call, строгие схемы | Те же предметные операции, один application boundary |
| Долгая операция | Ответ о принятии с непрозрачным Task ref; не объявлять завершённой | Единственный durable стандартный Task |
| Управление Task | Временный `compat_task` с отдельными ветвями get/answer/cancel | Стандартные Tasks get/update/cancel |
| Skills | Временный `compat_skill` list/get и доступное чтение содержимого | Стандартные Skills и resource read; чтение не означает activation |
| Изменения | Legacy resource notifications, если поддержаны; иначе `compat_changes` read/wait с ограниченным ожиданием и cursor | Настоящие subscriptions/listen и snapshot/resync |

Три compat-инструмента существуют только на compatibility endpoint. Native каталог остаётся из 14 инструментов. Их схемы ограничены собственным назначением, произвольного execute/kwargs нет. Где стандартные legacy ресурсы обеспечивают тот же сценарий без дополнительного вызова, переиспользовать их. Упрощение не должно скрывать способ получить Task, ответить на input или отменить его.

Translator — настоящий клиент upstream Tasks/Skills/subscriptions, поэтому объявляет реализованные им capabilities. Он не утверждает, что downstream Codex поддерживает их нативно. Session/caller capabilities, effect semantics и поддержка последнего шага видны отдельно. Полная невидимость разницы невозможна для model-visible injection/push; доступные способы чтения и восстановления должны быть понятны в описаниях.

## Состояние, права и эффекты

- Единственные durable Task/intents/receipts/holds находятся в Herder. Никаких proxy jobs, второй очереди отправок или собственного scheduler.
- Legacy caller привязывается к подтверждённому principal/session. Translator не выдаёт всем один привилегированный upstream identity. Task/resource refs защищены ACL; opaque ref не заменяет авторизацию.
- Request key сохраняется сквозным; потерянный ответ или UNKNOWN сверяется с исходной квитанцией. Повтор upstream send после разрыва запрещён. Если legacy клиент не даёт устойчивой identity/request key, мутация отказывается с точной инструкцией вместо угадывания.
- Cancel означает запрос отмены, а не гарантированную остановку эффекта. HumanStop и принятый native input сохраняют семантику.
- После перезапуска translator Task читается по origin ref. Буфер подписки ограничен; при потере курсора/буфера возвращается необходимость snapshot/resync, а не ложная полнота событий. Инъекция в контекст модели не имитируется чтением ресурса.
- Диагностические ошибки, effect/retry/receipt и redaction проходят через оба протокола.

## Приёмка

1. Официальный неизменённый Codex по обычной legacy MCP конфигурации видит предметные инструменты и compatibility helpers.
2. Он вызывает операцию, получает Task ref, читает состояние, отвечает на input и отменяет; upstream trace подтверждает стандартные методы. Первую wire проверку можно делать на изолированном native probe; это не продуктовая приёмка.
3. С реальным native Herder сохранён один Task через restart translator; два caller не читают чужие результаты; повтор не создаёт native input.
4. Skill доступен для чтения; изменения доступны после reconnect/resync. Нативная activation/push не заявляется без доказательства.
5. Native endpoint не принимает старый wire; удаление translator оставляет native build/read/create/deliver работоспособными.
6. E001/E002 дают ранний real adapter сценарий через translator; T013/V097 и финальные consumer gates подтверждают целый installed путь.

V003 остаётся историческим отрицательным доказательством прямого Codex пути. Решение владельца снимает архитектурный тупик, но реализация compatibility должна пройти собственные T-листья. Fork Codex и поддержка собственного Codex release не входят в план.
