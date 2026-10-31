# Вопросы агентов в Telegram

Цель: агентские native-вопросы и approval видны в Telegram сразу и после перезапуска, ответ возвращается ровно в исходный запрос. Только существующий Notice Place/UserIO; секреты через защищённую форму, тестовые звонки людям запрещены.

До: observer обрабатывал только permission.requested. После: typed blocking native input и persisted async questions доставляются отдельно; ответы собираются по всем sibling-карточкам и возвращаются исходному RPC либо в ту же terminal async-сессию.

Границы: не менять чужой reboot helper в codex-app-server.ts и tests/codex-app-server.test.ts до передачи ownership. Не делать массовый resume или параллельный runtime restart. Сохранять весь посторонний WIP.

## Plan

Цель: неотвеченные native-вопросы и разрешения приходят через Notice Place в Telegram, канонический ответ возвращается ровно в исходную сессию.
Что будет работать: новая и восстановленная после рестарта карточка, без повторения accepted/UNKNOWN и без ответа за владельца.
Декомпозиция: 2 листа · 1 параллельно · 2 волны · слотов: 1.

✅ L01: Подключить native-вопросы и точные ответы; оценка 30 минут, факт не измерено.
🔄 работаем L02: Установить и проверить реальную доставку и возврат ответа; оценка 20 минут, факт не измерено. Airlock доставлен и подтверждён UserIO; QA нашёл native empty-tail bug, исправление f020a4b опубликовано и ожидает единственной установки root.

## Подтверждённый результат

Human Request bfd790f2-c08d-4bd2-b2ee-c2dd96a792f1: stale Herder producer token исправлен через существующий source:agent-herder credential. До контролируемой доставки подтверждены authenticated canonical404 и независимый query-only mesh count0; source сохраняет row до Telegram send. Поэтому выполнена одна доставка прежнего ID с неизменным envelope fingerprint, а не слепой replay UNKNOWN. Exact201/sent → receipt-only reconciliation прежнего claim → accepted. Независимый UserIO read: Telegram message8483 в существующем чате/теме Herder. Канонический вопрос pending; ответа за человека и native resume Airlock не было.

QA не использует владельца: отдельный service actor8810909089 в существующей группе qa deusexcode. Единственный fixture01a18509-00e9-7492-863e-4ad93855d065; принятые native inputs и inject_items не повторялись. Реальный вызов request_user_input_async создал call_50dcbe6af03a4f45b71c87aa336d4350, за ним пустой agentMessage. Баг reader воспроизведён; f020a4b игнорирует только explicit empty tail, 9/9 source checks + TypeScript прошли. Установку100/44/88/Mini выполняет только root. Чужой WIP не включался в наши scoped commits.
