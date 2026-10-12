# Аренда S21 в Herder

`GET /api/resources/s21-lease` и MCP `s21_lease_status {}` только читают
существующую аренду на `roomhacker-server-100`. Телефон не становится новым
узлом fleet; нет операций claim, renew, release или управления устройством.

Ответ: `resource: s21`, `resourceHost`, `status: free|held|unavailable`,
`actor`, `expiresAt`, `remainingSeconds`, `observedAt`, `message`.
`actor` содержит `type: agent|system|legacy`, `task`, `purpose`,
`harness`, `sessionId`, `sessionUrl`, `systemUnit`, `invocationId`.
Неприменимые поля равны `null`. Capability `lease_id` не передаётся.
Ссылка строится из точных harness + SID, а не из сохранённого URL.

UI показывает «Телефон свободен», «Телефон занят» с задачей/владельцем или
«Проверка телефона недоступна». Legacy-владельцы имеют подпись
«Сессия не записана»; system actor содержит настоящий unit вместо ссылки
на выдуманную агентскую сессию. Ошибка чтения не означает свободный телефон.
Запросы имеют конечный deadline, `no-store` и повтор через 30 секунд;
размонтирование компонента отменяет запрос и таймер.

Источник и правила acquire принадлежат
[ServersAdministartion](https://github.com/megamen32/ServersAdministartion/tree/main/infra/android-s21).
Read-only CLI ограничен 5 секундами и 16 KiB; с другого существующего
Herder-хоста используется штатный SSH к server-100 с проверкой hostname.

Проверки: `tests/s21-resource-ownership.test.ts` (fast unit, expected1s/max30s)
и `tests/s21-resource-http-mcp.test.ts` (focused integration, expected2s/max30s).
Они не обращаются к телефону и не создают production lease. Root выполняет
установку Herder и окончательную headed-проверку UI отдельно.
