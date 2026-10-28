# Сессии после перезагрузки — чтение состояния

Снимок: 2026-10-28T20:35:18.626Z. Команд продолжения, перезапусков и изменений настроек не выполнялось.

## Codex на server100

21 существующая локальная сессия проверена через details?limit=1&quick=1: **8 interrupted, 10 completed, 3 inProgress**. Все21 HumanStopHeld=false; индивидуальных session-autostart overrides для этих21 нет. Harness codex enabled=true; глобальная настройка enabled=false. Это разные уровни настройки, глобальный флаг сам по себе не доказывает запрет harness override.

Перезагрузка server100:23:00:04МСК. Native interrupted подтверждён точным turn; причинную связь с перезагрузкой timestamps не доказывают. Перед любым продолжением нужны свежие identity/admission/question checks; этот аудит не отправлял ввод.

### Native interrupted

| Сессия | Native session ID | Последний interrupted turn | HumanStop |
| --- | --- | --- | --- |
| Завершить сценарий ExManager | `01a17e2e-6dce-7870-b08c-89c092087fb5` | `01a18393-5af9-7fa3-9f2d-0954f4cfd2ba` | нет |
| Унифицировать подключение аккаунтов | `01a183d6-e4ff-7762-a3e2-45c3d96cd7e0` | `01a183d6-fa04-7bb0-90a3-4a2254026916` | нет |
| Обновить Airlock и демо | `01a182ff-be14-7171-9b7d-a4965f7363cd` | `01a183c3-e935-74e3-8a08-7aaac6367484` | нет |
| Реализовать план Cloud Telethon | `01a17463-b099-7f62-b6d8-3194ce73ffe9` | `01a18241-662a-7533-959b-48fbed3bab2d` | нет |
| AutoGramXAirlock | `01a182fe-39b5-7730-a84b-7c484e8fc412` | `01a1838e-1ce0-7d51-be04-9b6e19da4dda` | нет |
| voice exmanager notice place userio | `01a1653b-d774-73b3-9c0a-09cced76ea9e` | `01a18314-f356-7fe3-bc80-673bee7630b1` | нет |
| Установить Xerj для OpenCode и Codex | `01a18288-c9a6-7082-b943-ab583172b7a6` | `01a18399-b6cf-7a81-8b91-09a85afd9e89` | нет |
| Проверить сохранность данных при деп | `01a17e87-1fa4-7101-a7e7-3917461a0117` | `01a183dd-cf12-76d3-a978-404b4c70a251` | нет |

### Native completed — автоматически не продолжать

- Исправить UserIO: `01a18318-e153-7b01-927a-d151f0877087`, turn `01a18331-ded8-7092-8e4e-978b449ee9cc`.
- Исправить дашборд планов Agent Herder: `01a182b0-5520-7e81-8d75-51bbe361d85b`, turn `01a1839d-e483-7443-9922-b7978e766f0c`.
- Довести ExManager до рабочего MVP: `01a174a7-fa79-7d33-8bcb-0c3c2766a8a7`, turn `01a183d4-3a50-73f2-9210-5d0cddf8677a`.
- GrepMesh remote indexes and duplicates: `01a17763-c117-7f42-bc62-62d478d32a08`, turn `01a183d1-f27d-7ae2-98df-f1189fbf6ec5`.
- Никита — проверка пути интегратора: `01a183a9-7fc8-7163-abcc-13ba363a9a7b`, turn `01a183ad-2253-7030-b7c4-1f2c8b0cdfce`.
- ШТАТНО · health launch auth repair · 27.10: `01a17ea3-5600-7580-aba9-1badd2187dd5`, turn `01a183ba-fc2d-7dc1-b980-36e6fb519d7c`.
- Завершить план OmniRoute Z-code: `01a1748f-0acd-74b2-b495-05838ca4a070`, turn `01a183a2-f0fe-7282-a21a-69bff693cd1f`.
- server100_account_broker_io_20261028_sol: `01a18387-7dd8-7241-a6e2-ee830bf0a4c2`, turn `01a18387-9a10-71b3-a839-a1faa251446d`.
- exmanager-luna-callback-1028: `01a182c6-137c-7db1-bd62-2b96515e1089`, turn `01a18399-2319-72b0-a44e-c6c1dfd33104`.
- какие то проблемы с впнов и прокси , все ломается и отвалив…: `01a17e06-cc6b-72f0-8635-4514a25afc96`, turn `01a18391-b5ba-70b0-b846-116765612d94`.

Completed здесь означает завершённый ход, а не подтверждение бизнес-цели.

### Уже работают — не дублировать ввод

- Слушай, а у нас вот это вот разрешение, которое позволяет и…: `01a17db0-a213-7ab2-8da1-c90eb90793b4`, turn `01a18434-47a7-71e3-8ad7-9c8dc1da61d3`.
- Компактный интерфейс Автограммы: `01a183a7-7b14-74e1-a104-5534205ba3fb`, turn `01a18434-7e15-7152-a403-f70ff3e23275`.
- Собрать правки Agent Herder ↔ ZCode: `01a1754f-0228-7553-bea6-cc89e40b5187`, turn `01a18432-cc55-75d0-a1e8-521b5c69f42a`.

## Durable recovery state

- **100:**27 unfinished records, inventory0; среди них0Codex.10сегодняшних OpenCode state=active без exact terminal proof; это кандидаты для уточнения, не доказанные прерванные.17старых записей пересекаются с активным HumanStop; среди них2старых quota accepted_pending и2nonRetryableAdmission — не повторять.
- **44:** boot22:51:41МСК, unfinished records0, autostartfile отсутствует (APIdefault enabled=true), API6Codex. Durable record для автоматического восстановления отсутствует.
- **88:** boot13.10.2026, текущего rebootнет;1старый Codex record EquaFlow от18.10, не свежий кандидат после reboot100. API21Codex/12ZCode/23OpenCode. OpenCode harness enabled=true.

Полные отфильтрованные metadata, пути stores, flags, title/IDs/terminal/admission/STOP evidence — в inventory.json. Транскрипты и длинные lastMessage не читались/не сохранялись. Старые QA не запускались. Процессные/модельные настройки не менялись.
