# ZCode: первое сообщение в созданной сессии

Владелец: Codex55; source/runtime/integration. Статус: исправление проверено локально, реальный consumer после доставки ещё требуется.

Собственная MCP-проверка в sess_52b0403b-3f67-4941-aff2-3451291a1f6a создана штатно, но первая native V4 команда fleet55-native-zcode-mcp-read-20261010-v1 отвергнута FOREIGN KEY constraint failed. Команда не повторяется; сессия/ошибка сохранены.

Причина подтверждена установленным zcode.cjs: immediate runtime draft не создаёт SQL session row, а V4 admitInputCommand обеспечивает её перед saveSessionInput только для deferred. Штатный native createSessionRecord также создаёт deferred. Адаптер теперь использует deferred без изменения STOP/noReplay/native ID/rename/auth/provider. Никаких прямых записей liveDB. Exact file SHA/byte offsets: .tmp/herder-fleet-20261010/source-check/zcode-deferred-source-proof.json.

62 relevant fast units PASS (receipt f14c302c, peak159629312bytes), TypeScript/frontend build PASS (4651daa, peak562184192bytes); swap0/OOM0/same-generation cleanup. Finite CPU1/512M–1G units и CPU1/1G–2G build, Tasks128/wall120s/temp64–256MiB/IO10; ordinary суммарно<180s. Unit purpose: native receipt/STOP/name regression; first-input defect acceptance: fresh supported native ZCode V4 input плюс реальный MCP discover, expected30/max120s. Fake checks не runtime proof.

Следующий шаг: scoped publication exact source, same artifact/budgets/rollback, новая собственная deferred MCP-canary с отдельной командой (не повтор старой), terminal native tool receipt. Старые fleet empty IDs и M1 UNKNOWN8e не трогать.
