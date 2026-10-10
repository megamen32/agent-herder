# Herder: падение при чтении метрик Codex

Владелец source/runtime: Codex55. Зафиксирован реальный V8 heap OOM PID3212253 в07:09:12Z, автоматический restart07:09:15→3247358, kernelOOM0. Это до второй успешно принятой broker canary, не её failure. Лимиты сервисного RAM1/2GiB и CPU4/Tasks512/swap512MiB/IO50 сохранены.

Подозреваемый путь подтверждён отдельным ограниченным RED: реальный установленный CodexAdapter.readSessionMetrics читает весь47MiB native rollout плюс split array. В изолированном дочернем Node с heap64MiB он завершилсяSIGABRT/V8heapOOM; service не трогался. Runner c99c548909cbea2e83127674bb193dd3, peak100446208B/swapOOM0/cleanup. Два initialprivatecase75 сохранены, payload не запускался; точно исправлены private600/ownparent700 без изменения runner.

Исправление: последовательное чтение JSONL по одному record; сохранены model/count/token/duration и обработка частичной строки. Не хранится весь file+linearray; память зависит от текущего record, не полного rollout. Это не абсолютный cap record: отдельная огромная строка остаётся ограничением. Новые2fastunits — метрики CRLF/final line и реальный missing-file error/stream cleanup, expected1/max10s. Следующий шаг: relevant units, backend compiler в прежнем bounded runner, same real file приheap64GREEN, независимый review, sourcepublish, jobs0→controlledbackend-onlyapply и реальный metadata/read consumer. Старые broker/native inputs не повторяются.

## Проверки исходного исправления — 10:32 МСК

Пять relevant local tests PASS, receipt5357d556bdf34895b79889eb72048417/peak156004352B/swapOOM0/cleanup. Старое archive expectation ENOENT было несовместимо с уже опубликованным native fallback: default includeMetrics:false не входит в изменённый metrics метод. Проверка согласована с текущим native sameID/idle и raw transcriptnull; первая4PASS/1RED сохранена. Независимые initial+delta review: noHIGH/MEDIUM; продуктовая native fallback/STOP логика не менялась.

Тот же реальный47MiB native rollout в новом source-only candidate при том же child heap64MiB: exit0,523messages, heapUsed10644912B. Receiptdd5dcc4e943ec7a8e16b863d568af005/peak116396032B/swapOOM0/fullcleanup; прежний compiled метод SIGABRT/heapOOM. Это discriminating RED→GREEN именно для метрик, не доказательство всей причины предыдущего service crash и не deployed acceptance. Временный isolated module собирался установленным TypeScript, fullproductioncompiler остаётся единственным у43; retained setup failures symlink/rootDir/module-format не считаются sourceGREEN. Избыточная OWNsymlink удалена; globalguard/caps не менялись.

Изменённые4пути source/test/tracker проверены; следующий шаг — scopedpublication55 →43 ONE общий backend compiler с независимым due deadlineguard →reviewedpublishedpacket→55 jobs0 apply→настоящий установленный metadata read. До этого runtime stability ещё не заявляется. Memory O(maxrecord), отдельная огромная строка остаётся пределом; расширение record policy не входит в это исправление.
