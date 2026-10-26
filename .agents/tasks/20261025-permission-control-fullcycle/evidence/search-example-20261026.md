# Поиск цитаты и открытие Codex-ссылки

Пользовательский пример: attachment `e17c2155-e362-48d5-9af1-efc2e7c1092e/Вставленный текст.txt`. Исторические команды и отправки в цитате не выполнялись повторно.

## Подтверждено живыми чтениями

- Native ID `01a134e4-c26e-7ae0-900c-f9be106dbc98` существует на Mac, заголовок «Собрать отток подписчиков каналов», cwd `/Users/user/Documents/Codex/2026-10-13/https-t-me-nos-chanel-https`.
- Codex app read_thread вернул исходный final answer с точной цитатой о пяти каналах, 149–158 просмотрах и тихих часах. Это доказательство найденной истории, не новая проверка действующего мониторинга.
- Local native store server-100 этого ID не содержит. Старый fleet read ошибочно представлял null как `fleet_session_identity_mismatch`.
- Worker проверил `agent_info` с `hostId=MacBook-Pro-User.local`: нужная сессия найдена. Два `session_search` с тем же hostId нашли точный assistant message `msg_081a6d7a9254645f016adeaa6783f087d2886ff60e1c52d801`, за 1,30 и 1,17 секунды. Покрытие Mac при этом частичное: положительный результат доказателен, отрицательный не доказывает отсутствие беседы.
- Живой MCP `agent_herder_search` с query «Опаленные войной 149 158 просмотров стартовый снимок пяти каналов почасовая проверка», limit4: exact351ms, semantic12816ms, total13167ms; полный MCP roundtrip18017ms. Exact вернул 0; четыре semantic результата относятся к другим сессиям.

## Причина и исправление исходников

`agent_herder_search` выполнял текстовый этап Qdrant, затем обязательный embedding+semantic этап. MCP ждал оба. Индекс читается на текущем Herder host, это не полный поиск по fleet. Без host-aware native чтения Mac-беседа ошибочно считалась недоступной.

Добавлены режимы exact/semantic/hybrid и явная отметка local-index/fleetComplete=false. Exact не вызывает embedding. HTTP и MCP принимают mode. Сохранён hybrid по умолчанию.

Отдельно исправлен реальный дефект Codex-индекса: современный `session_meta.payload.id` игнорировался, и в payload попадало имя rollout-файла вместо native UUID. Миграция checkpoint `codex-native-v2` переиндексирует такие записи и удаляет старый alias перед upsert. Миграция локальная, не включает историю Mac автоматически.

Codex `cwd` также переносится из session_meta в directory/project, чтобы фильтр по папке проекта не исключал все Codex-записи с прежним пустым project. Regression fixture проверяет оба поля.

Дополнительный read-only замер установленного модуля с fetch instrumentation, без запуска индексатора: text scroll318ms, embeddings19608ms, vector search46ms; total19992ms. Задержка этого запроса локализована в embedding gateway/model, не в Qdrant. Секреты/тела ответов не выводились.

Проверки: первоначальные 5 focused test files, 9 tests PASS; после независимого review добавлены проверки legacy alias migration/checkpoint и пропущенных timing, 2 targeted files/7 tests PASS. `tsc --noEmit` PASS. Установка этого нового изменения и повторная проверка установленного MCP ещё предстоят; прежний установленный backend — 4750249.
