# Airlock: исправление пропущенного продолжения

## Причина и поставка

AutoGramXAirlock `01a182fe-39b5-7730-a84b-7c484e8fc412` остановился на native continuation `01a18450-33e7-78b3-bafd-54e2587aac54`. В ходе не было нового user item; summary возвращал пустые items, хотя полный текущий ход содержал 58 событий и четыре commentary. Старый cold discovery требовал новый user item и пропускал эту сессию.

`be17e5915d331da739669c5f4443862205a8d728` добавляет доказанную native continuation boundary без подстановки старого user ID и устойчивый dispatch inputId. `43fcf5e711cf46f630374d31296f357db64b6dcb` учитывает штатный server page cap: максимум четыре страницы и 256 items суммарно, отказ при неполной выборке; затем повторная проверка latest/transport. Final, questions, STOP, новый активный ход и accepted/UNKNOWN сохраняют запрет повторной отправки.

Source: adapter 3 focused tests PASS; launcher 9 continuation cases PASS и 16 сопутствующих recovery cases PASS; TypeScript PASS. Для обоих срезов clean deployment inputs и assembled artifact checks 14/14. Это не утверждение чистоты общего checkout: посторонний WIP сохранён.

## Реальное автоматическое возобновление

- 29.10.2026 **03:08:28 МСК**: journal PID1611485 сообщает автоматическое продолжение именно AutoGramXAirlock.
- Durable `acceptedAt=2026-10-29T00:08:28.796Z`, native turn **`01a184fc-967f-7311-9b9e-e8a867b5400a`**, admission `in_progress`.
- Независимый native items readback: новое commentary «Проверю сохранённые изменения, отчёты и тестовый стенд…», два commandExecution, два mcpToolCall и reasoning. Не только HTTP200 или admission.
- Ручных resume/send от root и исполнителей: **0**. Повторного продолжения этой принятой отправки нет.
- Окончательный runtime100: **43fcf5e**, PID1699196, начало **03:09:32 МСК**, hardpinned ExecStart на соответствующий release/dist/index.js. Canonical installer exit0. Второй install не остановил native Codex-сессию.
- Fingerprint окончательного assembled transport bundle: `57b627c2a124cb8b7eec4d969668b5c4f5338e342c6671d415b5ccdbfe161ff1`.
- Другие установленные узлы и сохранённые настройки: `airlock-linux-install.json`, `airlock-mini-install.json`. M1 не менялся: прежний отдельный unknown socket owner blocker остаётся.

## Остальные недавние Airlock-корни

По project-filtered inventory `/home/roomhacker/airlock-internal`, codex, окно48h:

| Сессия | Проверенное состояние | Действие |
| --- | --- | --- |
| AutoGramXAirlock `01a182fe…` | Оборванный continuation без нового ввода | Herder автоматически продолжил; реальные инструменты работают |
| Обновить Airlock и демо `01a182ff-be14-7171-9b7d-a4965f7363cd` | Native interrupted `01a183c3…`, final с questions | Не обходить вопрос запуском нового хода; отдельная задача доставки вопросов ниже |
| Довести CRM-связку `01a17e8d-a8eb-7c20-9eb9-fdc30c50d4dd` | Native completed; последнее прямое человеческое поручение — «всё, пауза» | Не отменять человеческую паузу автоматикой |
| Подключить AutoFindClient к AirLock `01a16939-ae62-7852-ab74-0b13f96246dc` | Native completed 27.10 18:07:44Z, assistantFinal=true, pendingQuestion=false | Это не оборванный ход; не запускать заново по crash recovery |

Ограничение inventory: общий API по умолчанию возвращает100, а project-filtered limit500 дал95 из144 из-за byte budget. Все четыре корня последних48h находятся в новом префиксе; исторические Oct18 helper-сессии не объявляются работающими или незавершёнными. Завершённый Airlock ZCode25Oct находится вне48h. Native completed не означает приёмку бизнес-цели.

## Отдельный остаток доставки вопроса

У `01a182ff…` Human Request `bfd790f2-c08d-4bd2-b2ee-c2dd96a792f1` pending; noticeDelivery=unknown, claim `908f48f0-a8a3-4c61-afb0-9e30899a18fc`. Notice MCP question_result вернул not found; это не доказательство отсутствия внешней доставки на canonical writer. Не повторять карточку вслепую и не отвечать за человека.

Эту область владелец ранее выделил native сессии **`01a18444-4ce2-70d2-a7f0-65e9fe1cbbef`**. Её latest continuation содержит224 items, но native API отдаёт по100. После pagination fix независимый adapter читает полную boundary, pendingQuestion=false/final=false, без поддельного user ID. Её автоматическое продолжение и точная передача unknown reconciliation проверяются отдельно; новая сессия и параллельный исполнитель доставки не создаются.

Полная пересылка/ответ Telegram и снятие человеческой CRM-паузы здесь не объявляются выполненными.
