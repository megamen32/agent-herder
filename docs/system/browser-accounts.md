# Несколько браузерных аккаунтов

## Что система делает сейчас

Rust различает адреса по node, instance и native session; отдельный Z.ai reader закреплён за account scope: [zai/mod.rs](../../crates/herder/src/adapters/zai/mod.rs). Multi-owner требует разные instance и одного principal: [owner_multi.rs](../../crates/herder/src/bin/herder_native_stdio/owner_multi.rs). В checkout добавление нового owner в установленный selector штатным candidate-переходом не предусмотрено. Live-сценарий двух аккаунтов в этом проходе не проверялся.

## Проблема

Аккаунт B должен получить собственный instance и доступ к своему чату с сохранением истории и authority A. Перелогин A прерывает работу первого аккаунта. Расширение хранит одно подключение на провайдера внутри Chrome-профиля. Раздельные Chrome-профили уже дают нужное независимое подключение для каждого аккаунта. [Хранение подключений](../../integrations/chrome/agent-herder/options.js)

## Идеальная система

Два Chrome-профиля на 100 имеют независимые Z.ai instances A и B, собственные account scope, listener, token и защищённые owner authority. Оператор добавляет B через проверяемый selector transition с сохранением A.

## Идеальный конечный результат

Обычный клиент разрешает точный существующий чат каждого instance, читает историю и отправляет в свой чат до и после перезапуска. Добавление B сохраняет действующие адреса, хранилище и права A. Неверная привязка исключает запись только из соответствующего экземпляра.

## Анализ по ТРИЗ

Цепочка: один provider используется как ключ установки → новый аккаунт замещает старую привязку или не добавляется → работа A мешает подключению B. Техническое противоречие между общим адаптером и независимыми аккаунтами разрешается разделением по Chrome-профилю, instance и account scope. Общее поведение хранится в одном адаптере, а установка B дополняет список. Удаляется необходимость перелогина A для обслуживания B.

## Ресурсы

[owner-bootstrap](../../deploy/fleet/owner-bootstrap/README.md) создаёт новую изолированную DB, gate и generation, возвращая seed; он не выдаёт доступ к чатам. [session.register](../../crates/herder/src/bin/herder_native_stdio/owner_registration.rs) принимает точный instance и native ID и проверяет сессию через привязанный adapter. Специальный `existing_sessions` enrollment сейчас ограничен ChatGPT: [owner_enroll.rs](../../crates/herder/src/bin/herder_native_stdio/owner_enroll.rs).

## Спецификация

- Решение: B получает новый уникальный instance, приватный owner profile из seed и подтверждённый account scope; identity A сохраняется побайтно и по authority.
- Наблюдение: перед регистрацией проверить точный native chat через adapter B; `session.register` использует стабильный request key и возвращает durable receipt и session ref. Неизвестную регистрацию разрешать readback исходного ключа.
- Текущий `--browser-binding` индексирует привязку по провайдеру, а селектор допускает точную замену путей. Нужен один переход `добавить B`: индексировать действие по `(kind, instance)`, сохранить все текущие пути, добавить новый защищённый профиль, использовать штатный CAS и прежний селектор для rollback. [Candidate](../../deploy/fleet/process-leases-candidate.py) · [Rollout](../../deploy/fleet/process-leases-rollout.py)
- В текущем [owner_multi.rs](../../crates/herder/src/bin/herder_native_stdio/owner_multi.rs) `session.resolve` делегируется первому binding с расчётом на общий ACL registry. При независимых DB проверить этот путь первым. Если B по нему теряется, переиспользовать адрес из `session.register` для действий с session ref и точное чтение соответствующих owner-ов для discovery/resolve. При двух совпадениях вернуть конфликт адресов. Это изменение маршрутизации чтения внутри текущего процесса.

## План и приёмка

1. На изолированном стенде сделать два Chrome-профиля одного провайдера, привязать A и B через расширение и зарегистрировать по одному существующему тестовому чату через `session.register`. Проверить обычные resolve/read/send в обоих. На действующем узле bootstrap создаёт только B. При недоступности B операции A продолжаются.
2. Дополнить [process-leases-adapters-test.py](../../deploy/fleet/process-leases-adapters-test.py) проверками добавления B, отказа при подмене instance/authority и CAS, неизменности A и rollback; проверить маршрутизацию и историю в [test-v1-multi-browser-stand.py](../../tests/native/test-v1-multi-browser-stand.py).
3. На установленном артефакте подтвердить оба owner, квитанции регистрации, независимое чтение истории до и после рестарта, отклонение попытки обращения к чату другого аккаунта и сохранность A. Нативные изменения проверяются на выделенных чатах.
