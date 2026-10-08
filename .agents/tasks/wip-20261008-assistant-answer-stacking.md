# Части ответа не объединяются в переписке

Запрос владельца08.10: ответы не стакуются. Screenshot/context: пользовательский список сессий и жалоба на раздельные ответы в Agent Herder.

Статус: источник исправлен, ожидается общая проверка и внедрение root. Исполнитель: answer-stacking. Root принимает и проверяет результат.

Проверить actual native message shape и текущий renderer. Итог: части одного ответа/хода последовательно отображаются одним читаемым ответом, без повторов и потери текста; сообщения разных ходов/пользователя не склеиваются. Не выдавать группировку unit-fixture за доказанную доставку/native continuation. Уточнение продукта направить root только если меняет следующий шаг.

Границы: helper группировки session messages и chat message rendering main.tsx (MessageParts/CollapsibleMessage/цикл details.messages), не трогать SessionList, create models/form, backend native adapters. Сохранять чужой WIP/main. Не создавать harness daemons и не перезапускать группы. Бюджет и shared locks как docs/web-ui-validation.md/current new-session tracker. Root отвечает за интеграцию commit/push/deploy и видимую проверку.

## Проверенный дефект и исправление

Root явно расширил ownership на `src/types/common.ts` и передачу native turn identity/phase в `src/adapters/codex.ts`; управление runtime/recovery не затрагивалось.

Реальная shape проверена на existing native Codex session `01a11b43-e944-7663-9ce8-d75df67c1167`: `response_item.payload.id`, `phase=commentary|final_answer`, `internal_chat_message_metadata_passthrough.turn_id`. Текст переписки/креды не выводились. В текущем compiled reader `dist/adapters/codex.js` контрольное чтение той же сессии дало 14 сообщений, 9 assistant, **0 сообщений с turnId**. Native rollouts содержат общий turn ID для частей одного ответа; старый mapper его теряет, renderer рисует отдельный article/header для каждого raw сообщения.

Новый mapper сохраняет native item ID, phase и turn ID; fallback только на явно наблюдаемый `turn_context`/`task_started`, сброс на `task_complete`/`turn_aborted`. В отсутствии доказанного turn ID сообщения остаются отдельными. Native metadata позволяет сохранить принадлежность даже при чтении bounded tail без начального turn_context.

`src/web-ui/message-groups.ts` объединяет только соседние assistant сообщения одного доказанного turn ID. Порядок текста/parts сохраняется; native item ID дедуплицируется с сохранением последнего snapshot; разные IDs с одинаковым текстом не удаляются; user/system/tool и неизвестные/разные ходы разделяют группы. `main.tsx` рисует одну подпись/время и один article на группу, сохраняя раздельные service note/expand controls и полный вывод последней части ответа.

По review root добавлен интервал между частями внутри одного article (`codex-theme.css`, только message-specific selectors), поскольку прежний `p:last-child` обнулял промежуток. Проверен poll merge в main: объединение по message ID. Старый fallback ID содержал `first|tail`/относительный line index и мог удваивать текст при смене окна. Новый fallback использует абсолютный byte offset JSONL record; UTF-8 и CRLF учитываются без timestamp/text-угадывания. `getFirstUserMessage` сохраняет LF/CRLF offsets при потоковом чтении; native payload IDs остаются приоритетными.

## Проверки и оставшийся следующий шаг

- `git diff --check` проходит.
- Подготовлены пять focused regression checks в `tests/message-groups.test.ts` и три сценария реального adapter→helper path в `tests/codex-message-turns.test.ts` (четыре проверки с учётом LF/CRLF parameterization). First/tail identity проверяется на UTF-8 с русским префиксом, byte offsets по фактическому содержимому файла, CRLF и LF, narrow 256 KiB cutoff внутри многобайтового filler и full window; размер history fixture меньше 300 KiB.
- Heavy tests не запускались исполнителем: shared lock занят общей canary root. Root получил точные файлы для одного общего bounded run.
- Только Vite/static deploy не обновит metadata у уже работающего backend reader. Root должен обеспечить safe deployment backend либо честно оставить live acceptance незакрытым.
- Root проверяет существующую сессию в browser: одинаковый native turn ID даёт одну подпись агента, разные ходы и user messages сохраняют границы, текст не пропадает после refresh/подгрузки истории. Не объявлять helper tests доказательством UI или live native delivery.

Failure shield: при жалобе «ответы не стакуются» сначала проверить payload native turn ID и передачу `SessionMessageView.turnId`, а затем article grouping. Ни одинаковый timestamp, ни последовательная assistant role не доказывают один turn.

Root integration:45 focused checks passed in5files (including9 new grouping/reader regressions and the36 existing UI/creation checks). TypeScript production compile to isolated candidate .tmp/new-session-fix/backend and Vite static build passed within reviewed1/2GiB scope and both shared locks. No live backend files changed. Pending actual compiled reader→same-native-session proof and safe production backend transition; old live reader still loses turnId, so production answer stacking is not yet closed.
