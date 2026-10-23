# Доступ к Mavis через Herder
Исполнитель: repair-mavis-access-20261023. Режим quickfix.
Цель: штатное обнаружение, чтение, одно нейтральное обращение и чтение ответа.
Проверено: mesh_discover сообщает native_discovery_failed; основной GUI работает на host :77/API :18792, контейнер отдельный sandbox. Локальный адаптер читает 12 сессий за 1.184s. Общий deadline snapshot 2s разделён очередью трёх workers; проверяется starvation позднего провайдера.
Чужой WIP сохранён. Голос/телефоны вне scope. UNKNOWN отправки не повторяются.
Следующий шаг: RED regression, минимальный fix, GREEN, scoped публикация и installed consumer canary.

## Исходный fix
RED: tests/harness-mesh-local.test.ts late MiniMax; первые три провайдера зависают, поздний MiniMax пропущен. GREEN: параллельный finite inventory. Deadline reason отделён от adapter exception.
Timeout user correction: default30s, env100..300000ms; direct/HTTP snapshot +5s, per-read aggregator +10s, весь discover +20s. Максимум12 peers параллельно, partial сохраняет готовые результаты.
Store5124 sessions > enumeration4096: newest Oct23 выпадал. RED newest enumeration test, fix reverse dated traversal в adapter+observer. Старые активные сессии ранжируются внутри bounded window; полного обхода не добавлено.
Проверки:116/116 восьми файлов+tsc; затем whole-discover дополнительный test15/15 gptadmin+tsc.
Историческая очередь появилась18fbd252; MiniMax добавлен4674688b. Доказанного нового regression commit нет.
