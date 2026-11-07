# Каноническое владение без MCP — v1, нулевая ревизия

Проектируемый контракт. Выбран простой вариант: один изменяемый owner JSON на ресурс и стабильный OS lock. Нет второй базы владельцев, prepared-транзакции между state.json и owner.json, собственного распределённого fencing framework или автоматического выбора нового authority.

Контракт всех ресурсов: RESOURCES.md. Канонический путь не зависит от project scope или текущего подключения телефона; owner хранится в одном месте.

## Адрес и файлы

При установке явные `storage_id`, `authority_node`, абсолютный `root`, схема и разрешённый local/SSH маршрут записываются в локальный manifest каждого клиента. Путь manifest известен из стартовой инструкции **до** обращения к MCP. Никаких секретов в manifest. Фактический host/root берётся из конфигурации установки, не зашивается в код; план не назначает инфраструктуру без её актуальной проверки.

```text
<root>/storage.json
<root>/projects/<id>/project.json
<root>/resources/<resource_id>/resource.json           # scope, identity, attachment
<root>/resources/<resource_id>/guard.lock
<root>/resources/<resource_id>/owner.json  # только при владельце
<root>/projects/<id>/snapshots/context.json           # необязательная проекция
<root>/RECOVERY.md
```

Инициализированный resource directory обязателен: его отсутствие не значит «свободно». Маркеры подтверждают storage/resource identity; project identity дополнительно для project scope. Успешное чтение маркеров и ENOENT **owner.json** означает свободную роль. Timeout, EACCES, отсутствующий mount, неверный ID, повреждение JSON — отдельные ошибки. Чтение отсутствия не выдаёт владение: нужен выигравший атомарный claim.

Owner содержит schema, storage/resource и scope, проверенного principal/session, случайный 128-bit claim_id, purpose и время. Claim ID — непрозрачная эпоха для сравнения на равенство, **не монотонный fencing counter** и не credential. Знание ID не даёт права. Guard inode никогда не заменяется; все MCP/CLI writers используют одну библиотеку на authority. Поддерживаются локальные файловые системы authority с проверенными flock/rename/fsync; NFS/SMB и копия root не объявляются authority без отдельного доказательства.

## Переходы без двухфазного файлового журнала

Под OS lock: проверить ACL/markers, перечитать owner, выполнить claim/renew/release с expected claim_id. Claim пишет полностью подготовленный temp, fsync файла, atomic rename, fsync каталога. Release проверяет текущий ID, unlink, fsync каталога. После kill виден старый или новый полный owner; orphan temp не является owner и удаляется только под lock. При fsync error outcome unknown, не false success. Нужны crash tests обеих ОС.

Клиент генерирует nonce claim_id до отправки. Повтор пока этот claim остаётся владельцем возвращает его; конфликт с иным owner не переписывает файл. Это **не вечная идемпотентность истории владения**: после освобождения старый claim нельзя автоматически повторять. После потерянного ответа CLI читает статус по прежнему ID; отсутствие owner означает отсутствие текущего владения, для новой попытки нужен новый nonce. Владение само по себе не запускает эффект. Дедупликация реального release долговечна отдельно, по effect request_key.

Checkout TTL — кооперативный сигнал. Потерявший владение клиент прекращает запись, но произвольный shell физически не блокируется. Чужой WIP сохраняется. Release не переходит автоматически по времени: явный takeover допускается только после проверки runner receipt/состояния; свободная роль без owner сразу доступна для claim. Ни отсутствие владельца, ни claim не назначают агента руководителем чужих проектов.

## Где действительно нужна защита побочного эффекта

Для каждого изменяемого deployment target существует **одна** обязательная точка выполнения (runner/существующий release entrypoint) и один локальный execution lock. Это граница гарантии; обходной shell не получает гарантию Herder. Не создаём distributed lock service.

Runner сначала берёт свой target lock, затем читает текущий claim на authority и сверяет expected deployed revision. Он записывает durable receipt с request_key/payload hash **до** spawn. Child/процесс, непосредственно выполняющий изменение, удерживает lock до выхода. Следующая операция снова берёт target lock и только затем проверяет текущий claim: задержавшийся запрос старого owner не выполняется. При потере authority новые эффекты не стартуют.

Смена owner во время уже принятого release не отменяет действие: target lock не даёт второму выполнять параллельно. Если изменение продолжилось во внешней системе после потери процесса/соединения, receipt остаётся UNKNOWN и блокирует новые конфликтующие эффекты на этом target до сверки. Повтор request_key возвращает receipt, а не выполняет команду. OS lock сам по себе не доказывает завершение внешнего изменения. Для двух разных runner, меняющих один объект, этот дизайн непригоден: конфигурация обязана свести их к одному target runner либо release остаётся неподдерживаемым. Проверка «target lock + повторная сверка owner + durable UNKNOWN» заменяет универсальную систему монотонных fences, а не убирает защиту.

## Независимый доступ и инструкция

Один поставляемый `herder` binary имеет offline `resource list|get|register|update|claim|renew|release` и `release receipt` режимы, не стартующие daemon, MCP, SQLite сессий или LLM. Не нужен отдельный herder-recovery executable/пакет. CLI и MCP вызывают ту же файловую библиотеку. Binary и локальный RECOVERY.md уже установлены на authority; SSH запускает точный фиксированный executable с аргументами, не собирает shell из недоверенного текста. ACL области global/project/node проверяется из manifest/policy и OS identity; общий SSH аккаунт не делает произвольный `--session` достоверным self. Где нет per-session attestation, записывается principal и unverified session, без impersonation.

Пример инструкции после установки: «Прочитайте локальный manifest по указанному пути. Подключитесь к authority и проверьте storage_id/resource и project для project scope. Если owner.json отсутствует, выполните resource claim с новым nonce. Продолжайте после успешного claim без вопроса о назначении владельца. Для release используйте объявленный runner и постоянный request_key. UNKNOWN сверяйте по квитанции, не повторяйте изменение».

Тот же исходник инструкции публикуется через MCP Skills и локально с версией/хешем. Context snapshot содержит creator/peers/workspaces/routes, generated_at/coverage, без закрытых текстов/секретов. Это устаревающая проекция, не owner authority и не receipt. Очереди отправки сообщений через файлы нет.

## Приёмка

- Выключенный daemon: свежий агент по локальной инструкции подтверждает storage, занимает свободный checkout/release без вопроса человеку; сессионная DB недоступна.
- Гонка MCP/CLI имеет одного победителя; рестарт MCP читает тот же owner. Wrong root, corrupt owner, EACCES и mount loss не дают свободную роль.
- Kill до/после rename/unlink/fsync: читается только полный owner или подтверждённое отсутствие; UNKNOWN не выдаётся за успех.
- Два release запроса, задержанный старый claim, смерть родителя и удалённый неизвестный эффект: максимум один одновременный эффект, UNKNOWN не повторяется.
- Старые Git/DB ownership writers отключены до активации нового writer; остановка MCP не включает их обратно. При откате writers не включаются одновременно.

Цена упрощения: после утраты authority новое исключительное владение недоступно; независимая работа продолжается. Автоматический failover authority и произвольные распределённые release runners исключены. Это явная граница, не скрытая потеря отказоустойчивости.
