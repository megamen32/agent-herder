# Флап fleet-узла из-за systemd-oomd: бюджет памяти юнита

Дата: 2026-10-24. Лист L44. Узел: roomhacker-server-88 (`agent-herder-fleet.service`, systemd --user).

## Что это за флап

Юнит `agent-herder-fleet.service` на узле 88 периодически исчезал и поднимался заново.
Панель на 100 в это время показывала 88 как «недоступна / не подтвердил» — честный факт
применения ломался.

## Причина (измерена, а не предположена)

Инициатор — **`systemd-oomd`**, а не kernel OOM и не код herder:

```
2026-10-24T16:01:08+0300 roomhacker-server-88 systemd-oomd[2015377]: Killed /user.slice/user-1000.slice/user@1000.service/app.slice/agent-herder-fleet.service due to memory pressure for /user.slice/user-1000.slice/user@1000.service being 71.02% > 50.00% for > 20s with reclaim activity
2026-10-24T16:01:08+0300 roomhacker-server-88 systemd[4273]: agent-herder-fleet.service: systemd-oomd killed 8 process(es) in this unit.
2026-10-24T16:01:08+0300 roomhacker-server-88 systemd[4273]: agent-herder-fleet.service: Main process exited, code=killed, status=9/KILL
2026-10-24T16:01:08+0300 roomhacker-server-88 systemd[4273]: agent-herder-fleet.service: Failed with result 'signal'.
2026-10-24T16:01:13+0300 roomhacker-server-88 systemd[4273]: agent-herder-fleet.service: Scheduled restart job, restart counter is at 14.
```

Проверено и **опровергнуто** распространённое заблуждение: `ExecMainCode=0`, `ExecMainStatus=0`
в `systemctl show` описывают состояние **текущего** (уже перезапущенного) запуска, а не
предыдущего. Реальный код завершения предыдущего запуска — `killed`, сигнал 9.

Пять убийств oomd за день: 10:31:07, 11:52:47, 12:36:46, 15:11:09, 16:01:08 (MSK).
Два остальных убийства в тот же день достались чужому `repair-sidecar-75.service`.

## Почему жертвой выбирался именно fleet-узел

1. **Свой лимит ниже рабочего набора.** При `MemoryHigh=384M` фактическое потребление юнита
   доходило до 433020928 B, то есть **выше** собственного `memory.high`. Юнит троттлил сам
   себя: счётчик `memory.events high` вырос с 15138 до 39807 за две минуты (16:06:04 →
   16:06:50). Именно эта reclaim-активность и была триггером для oomd в scope.
2. **Он был лучшей жертвой по score.** В scope `user@1000.service` юнит был **единственным** с
   конечным `MemoryHigh`; у всех остальных `memory.high=inf`. Для systemd-oomd score кандидата
   считается от `memory.high`, поэтому конечный лимит делал узел лучшей жертвой в scope.

Проверено измерением по всем cgroup scope `app.slice`: `MemoryHigh` конечный только у
`agent-herder-fleet.service` (`402653184`), у остальных `high=inf`.

`MemoryMax=768M` при этом ни разу не сработал: `memory.events max=0`, `oom=0`, `oom_kill=0`,
`dmesg` по OOM пуст, свободно 83 ГБ, swap 0. Убивало **не** превышение лимита юнита.

## Что сделано

Бюджет памяти узла поднят решением владельца:

| Параметр | Было | Стало |
| --- | --- | --- |
| `MemoryHigh` | 384M (402653184) | 1G (1073741824) |
| `MemoryMax` | 768M (805306368) | 2G (2147483648) |

- Юнит на 88: отдельный drop-in `~/.config/systemd/user/agent-herder-fleet.service.d/30-memory.conf`.
  Прежние drop-in'ы (`20-common-settings.conf`, `75-native-sqlite-file-budget.conf`,
  `95-automation-disarm.conf`) не тронуты; перед правкой сделан бэкап каталога
  `agent-herder-fleet.service.d.backup-20261024T160718`.
- Репозиторий: `deploy/fleet/linux-node.service` (шаблон юнита) и новый drop-in
  `deploy/fleet/30-memory.conf` — оба несут одинаковый бюджет.
- Регресс-тест: `tests/test_fleet_memory_budget.py` — падает на старом бюджете
  (проверено: `402653184 not greater than or equal to 536870912`) и проходит на новом.

Правка применена через `systemctl --user daemon-reload` **без остановки сервиса**:
cgroup подхватил новые значения вживую (`memory.high=1073741824`, `memory.max=2147483648`).
Окно недоступности узла — 0 секунд.

## Почему не `ManagedOOMPreference=omit/avoid`

Фактическая эффективность измерена, а не предположена:

- `user@.service` несёт `ManagedOOMMemoryPressure=kill` и `ManagedOOMMemoryPressureLimit=50%`
  (штатный `/usr/lib/systemd/system/user@.service.d/10-oomd-user-service-defaults.conf`).
  Глобальные настройки oomd **не менялись** — они действуют на весь user-scope с чужими
  процессами.
- Проба с отдельным юнитом `l44-oomd-probe` (`ManagedOOMPreference=omit`) показала: cgroup
  принадлежит `roomhacker:roomhacker`, **не root**, и xattr на нём **не появился**
  (`getfattr` пуст). По man `systemd.resource-control(5)`: «systemd-oomd will ignore these
  extended attributes if the unit's cgroup is not owned by the root user». Двоичный
  `systemd-oomd` на узле содержит строки `user.oomd_omit` / `user.oomd_avoid` и
  «Failed to set oomd_omit flag on control group %s, ignoring: %m» — то есть отказ проходит
  **молча**, без записи в журнал.
- Итог: на user-cgroup `ManagedOOMPreference` — **инертный** рычаг. Рассчитывать на него нельзя.

Альтернатива «снять конечный MemoryHigh» (тогда score считается от `MemoryMax`) — это
**решение владельца**, а не техническая мелочь: она снимает с юнита ограничение сверху и
меняет бюджет памяти узла. Не применялась молча.

## Проверка отсутствия утечки

Тренд памяти снят по 15-секундным выборкам (cgroup `memory.current` и RSS процесса):
значения колеблются в диапазоне **207–268 МБ**, нижняя граница стабильна (207–226 МБ),
монотонного роста нет. `memory.peak` рос только вслед за кратковременными пиками
(433020928 B) и не показывает утечки. Вывод: **утечки в herder-узле нет** — флап был
побочным эффектом давления памяти в scope, поэтому чинится конфигурацией, а не кодом.

## Правило для будущих fleet-узлов

1. `MemoryHigh` юнита fleet-узла должен быть **выше** фактического рабочего набора
   (для 88 измеренный пик — 433020928 B ⇒ запас 1G). Иначе юнит троттлит сам себя и
   генерирует reclaim-активность, которую oomd читает как давление в scope.
2. Конечный `MemoryHigh` во user-scope делает юнит лучшей жертвой oomd: score считается от
   `memory.high`, а у соседей он `inf`. Если нужен ноль-риск по жертве — это снять конечный
   `MemoryHigh` (решение владельца), а не `ManagedOOMPreference` (на user-cgroup не работает).
3. `ExecMainCode=0`/`ExecMainStatus=0` в `systemctl show` — **не** доказательство «вышел кодом 0».
   Истина о прошлом запуске — только в журнале (`code=killed, status=9/KILL`).
4. Пустой `journalctl --user` на узле 88 — **не** «журнал недоступен»: журнал пишется в
   системный (`/var/log/journal`), фильтры `_UID=1000` и `_SYSTEMD_USER_UNIT=` работают.
