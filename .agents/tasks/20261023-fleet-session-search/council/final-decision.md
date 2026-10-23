# Решение: защищать общую мутацию, оставлять подготовку параллельной

Статус: архитектурный контракт после узких исправлений независимого REVISE; реализация production guard не заявлена. Основания: Sol + native MiniMax-M3.1-Flash, синтез Astra, `recheck.md`, `experiments/recheck-results.json`. Это уточнение выбранного Lead направления, не новый совет и не разрешение менять чужие проекты. Исходные предложения и receipts сохранены.

## Практический протокол

1. **Обычная работа сразу.** Чтение, поиск, сборки, unit tests и собственные временные окружения не требуют новых hooks, claims, heartbeat или LLM-обсуждений. Тест, меняющий общий runtime/config/DB/порт, использует существующий защищённый seam этого ресурса либо изолированную fixture. Нет общей очереди на весь цикл.

2. **Конфликт исходников — свой Git worktree.** Продолжать от известной основы, переносить только собственные commits/patches. Не stash/reset/откатывать/временно затирать чужой WIP, не копировать смешанный dirty checkout. При непересекающихся owned paths отдельное дерево не обязательно. Уже доставленное правило LHC не требует повторного согласования или рассылки.

3. **Один владелец общей установки.** Расширить существующий release controller, а не создавать registry всех сессий. Он хранит монотонную installation revision, operation ID, digest канонических аргументов, target/provenance/config requirement, owner-reference, in-flight phase, observed identities и receipt. Herder показывает эти сведения по запросу из существующего источника; нового truth store нет.

4. **Idempotency до CAS.** Сначала lookup operation ID. Те же canonical arguments возвращают receipt либо UNKNOWN для сверки; другое содержимое с тем же ID отклоняется. Для новой операции проверяются expected revision и фактическое состояние. UNKNOWN не запускает мутацию повторно: прочитать ту же операцию и реальные identities, продолжать лишь доказанно идемпотентный шаг. Exactly-once не обещается. Недоступный журнал запрещает новую consequential mutation этой установки, оставляя диагностику и подготовку доступными.

5. **Короткий protected commit.** Hash/build/tests/подготовка manifest снаружи. Под guard — повторная проверка revision/artifact/config, durable intent/in-flight и pins, короткое изменение pointer/refs. Restart/readback снаружи filesystem lock; in-flight сохраняет исключительность перехода данной установки. Другой promote получает понятный busy/conflict, current revision и operation ID сразу, без busy-wait. Разные установки независимы, кроме короткого commit действительно общего ref-store. Durable означает проверенный порядок fsync/rename/recovery, не обычную запись JSON.

6. **GC входит в тот же контракт.** Finalize публикует immutable candidate с durable pin до допуска GC; незавершённая сборка находится в отдельном staging. Все ref-writers общего artifact store участвуют в guard. Финальный reachability-check и unlink выполняются вместе; при медленном удалении под guard ставится durable tombstone/rename, запрещающий новые ссылки, затем удаление идёт снаружи. Finalize/admission отвергают tombstone. Активные desired/observed, in-flight/UNKNOWN и pinned payloads сохраняются. Временный минимальный вариант — не удалять автоматически именно управляемые candidates, не отключая чужой GC всего хоста. Expiry не снимает pins.

7. **Config не защищается двумя отдельными CAS.** Для coupled изменения нужен уже поддерживаемый immutable versioned config pointer либо единый короткий commit с реальными config-writers. Manifest может разрешать schema/диапазон совместимости, точная revision нужна не всегда. Если seam отсутствует, первый guard не обещает coupled config safety и исключает конкурентные config-writes из своего покрытия. Новый config-store не создавать.

8. **После конфликта — интеграция поведения.** Нельзя лишь заменить expected revision у устаревшего кандидата. Прочитать актуальные desired source/provenance и receipt, интегрировать своё в своём дереве, пересобрать и выполнить затронутые regression checks. Ancestry служит сигналом; cherry-pick/backport допустимы. При неизвестном происхождении спорного поведения — адресный вопрос владельцу, без общего re-review. Crash/partial сверять по компонентам; takeover требует executor fencing либо доказанной остановки прежнего исполнителя, одного lease недостаточно.

## Что доказано и что нет

Независимая fixture действительно сохранила чужие staged/unstaged/untracked/index при работе и commit в отдельном Git worktree. Детерминированная модель воспроизвела dangling при valid CAS и отложенном GC unlink; исправленная tombstone-модель отвергла admission. ABA отвергнут монотонной revision. Отдельный config precheck воспроизвёл несовместимый результат. Поэтому уточнения выше необходимы, не факультативная бюрократия.

Это доказательства конкретной Git-операции и модельных контрпримеров, не гарантия реального controller. Время fixture 150.98 ms не измеряет production latency. Не проверены все production writers, crash/power-loss durability, реальные consumer identities и нагрузка. Прямая запись тем же UID обходит протокол; обнаружение drift не предотвращение. OS-разделение прав — отдельный возможный scope. Нельзя объявлять guard реализованным по Markdown, CAS-тесту или coordination-hook: существующий hook передаёт контекст, не ограждает executor.

## Scoped внедрение и критерий завершения

- **Controller Worker:** сначала точная карта существующих activate/rollback/finalize/GC/config writers, storage и executor seams. Затем только эти adapters и tests: revision, operation digest/readback, durable in-flight, pins и атомарная GC exclusion. Не создавать четыре публичных API только потому, что они названы в синтезе.
- **LHC:** использовать уже доставленное правило WIP/worktree; дополнить только отсутствующую ветку runtime conflict/UNKNOWN. **Herder:** UI менять лишь если существующая карточка не показывает resource/owner/receipt. Нет нового mandatory context packet или regex enforcement.
- **Проверка:** независимая короткая перечитка исправленного решения; затем fault-injection и конкурентные activation/GC/config tests на настоящем controller в изолированной установке. Проверить ID-reuse, crash windows, stale-client отказ, все известные обходы, consumer readback. Измерить latency относительно baseline и ноль новых LLM-раундов обычного прохода. Production rollout и приёмка остаются отдельным назначенным scope; до их доказательства обещать только покрытие реально проверенных маршрутов.
