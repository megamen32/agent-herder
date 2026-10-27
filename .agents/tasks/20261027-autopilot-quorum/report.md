# Автопилот до полной цели пользователя — исследование и кворум

## Поручение

Сравнить Codex, MiniMax Code и действующий Herder. Пользователь хочет включать
автопилот в отдельной сессии и получать достижение своей реальной исходной цели
со всеми уточнениями и доказательствами. Допускает больше расхода Codex, но
просит разумное кеширование и экономию без потери точности. Предсказанный
следующий промпт или отдельный бизнес-показатель не подменяют полную цель.

## Границы и процедура

Только исследование и архитектурное решение. Не менять продуктовый код,
runtime/config, model routes, включённость автопилота; не создавать Goal в
текущей сессии и не запускать тестовые пользовательские операции. Автоматические
tests/suite не запускать по developer instruction. Разрешённые модельные
обращения — непосредственно запрошенные участники кворума.

1. Установленный Codex + официальные docs; текущий Herder source/runtime
   read-only; переиспользовать проверенные MiniMax findings.
2. Два независимых предложения разных моделей по одинаковому исходному пакету.
3. Один cross-challenge, синтез Lead и свежая независимая проверка синтеза.
4. Финальное сравнение, решение, существенные возражения, непроверенные
   предположения и минимальный следующий вертикальный срез.

## Модели и квоты

19:08:40Z 27.10.2026: Codex Pro weekly used38%, allowed=true; secondary window
не представлен, не считается нулевым расходом. GLM used51% в5h и10%weekly.
MiniMax remaining35% в5h,81%weekly. Каталог Codex содержит gpt-6.1-sol и
gpt-6-luna. Оба разрешены frontier tier навыком council; выбран настоящий
двухмодельный кворум Sol+Luna. Два разных провайдера не заявляются.

## Проверенные исходные факты

- MiniMax Desktop3.1.6: после commit обычного пользовательского хода отдельный
  запрос той же модели/reasoning предлагает одну строку до120символов. Контекст
  последние3обмена,2000символов/сообщение, общий cap24000. Tools/reminders
  удаляются. Подсказка может отсутствовать; Tab/Right вставляют draft без send.
- Codex Composer Predictions: официальный текущий docs подтверждает current
  thread context, optional draft, no auto-send; beta generation не расходует
  Codexusage/credits. Реальный закрытый prediction backend/model prompt не
  опубликован. Локальный CLI0.162.1 сообщает thread/prediction/request
  not implemented; это не означает отсутствие Desktop-функции.
- Codex Goals: persisted thread-scoped objective + budget/lifecycle; event-driven
  idle continuation без очереди пользовательского ввода; no-tool suppression.
  Native continuation prompt требует сохранять всю цель, проверять исходные
  требования и доказательства, различать progress/live wait/no progress.
- Herder investigated source paths совпадают с deployed45fbd0b. Semantic Stop
  judge возвращает continue/done/human/choice, predicted_user_request и
  user_style_update; отдельные native delivery/Stop/HumanRequest guards.
- Stop judge evidence ограничен16KiB, включая до8KiB последнего ответа; нет
  гарантированного выделенного исходного goal ledger. Batch semantic path
  включает первый запрос+хвост, но packing может обрезать исходную цель.
- Verdict done/completed остаётся модельным JSON verdict; структурный полный
  coverage-proof по всем требованиям не обязателен. Существующие exact-native
  snapshot, idempotency/HumanStop/UNKNOWN guards должны сохраняться.
- Cache: durable receipt dedupe и user-style cache уже есть; Anthropic batch
  judge отмечает system ephemeral cache_control. Stop/OpenAI judge не задаёт
  явные cachebreakpoints и не сохраняет provider cached-token accounting.
- Read-only live: persisted semantic policy.enabled=false, recovery.enabled=false,
  watchdogEnabled=true, evidenceMessageCount200, judgeModel/autopilotJudgeModel
  glm-5.3-flash. Это не утверждение состояния каждого session override.

## Источники

- https://learn.chatgpt.com/docs/features/composer-predictions
- https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex
- https://developers.openai.com/api/docs/guides/prompt-caching
- src/autopilot/index.ts; src/autopilot/judge-request.ts;
  src/autopilot/user-style.ts; src/autopilot/background-stop.ts;
  src/autopilot/unfinished-session-launcher.ts; src/autopilot/session-store.ts.
- /opt/minimax-code/resources/app/node_modules/@mavis/local-runtime-v2/dist/
  service/turn-system/agent-host/runner/prompt-suggestion/.

## Настоящие участники и артефакты

| Этап | Модель / native collaboration task | Артефакт |
|---|---|---|
| Независимое предложение | gpt-6.1-sol / /root/quorum_sol | proposal-sol.md |
| Независимое предложение | gpt-6-luna / /root/quorum_luna | proposal-luna.md |
| Cross-challenge | те же две модели, один раунд | cross-sol.md, cross-luna.md |
| Синтез | Lead | decision.md |
| Свежая независимая проверка синтеза | gpt-6.1-sol / /root/quorum_recheck | recheck.md: REVISE → две правки → PASS архитектуры |

Оба независимых предложения выбрали эволюцию Herder с persistent goal/evidence
representation. После cross-challenge снята идея native Goals как пассивного
транспорта: его controller активен, поэтому интеграция исключена из первого
среза. Также ledger/verifier перестали считаться гарантией полноты: нужен
аудит первичных пользовательских сообщений и свежих доказательств.

Свежая проверка потребовала атомарного барьера входящих событий при completion
commit и инвалидации cached done при устаревании доказательств/полномочий либо
недоступности первичного материала. Оба контракта включены в decision.md;
delta recheck подтвердил PASS именно архитектуры. Сериализация, Codex
subscription adapter/auth, фактическая полнота, качество и стоимость остаются
непроверенными до реализации разрешённого ограниченного среза.

## Подтверждённые пути

- Herder Stop context: src/autopilot/index.ts:123,903;
  native receipt/dedupe и четыре исхода решения — там же.
- Batch artifact rule: src/autopilot/unfinished-session-launcher.ts:85;
  trimEvidenceChars:6089; OpenAI completion judge:7415;
  Anthropic cache_control в batch system:6918,7033.
- Settings read GET /api/autopilot/policy и /api/session-autostart — без PUT,
  токены/секреты не читались. Runtime45fbd0b; исследованные source paths совпадают.
- Local Codex native0.162.1:
  /home/roomhacker/.codex/packages/standalone/releases/0.162.1-x86_64-unknown-linux-musl/bin/codex.
  Подтверждены thread_goals, continuation deferrals, explicit-only goal tools,
  full-objective/evidence/progress embedded prompts. Отдельный evaluator backend
  и конкретная Goals KV-cache стратегия этим не доказаны.

Архитектура и стоимость не объявляются проверенным runtime результатом.
Нет новых целей, продуктивных продолжений, автопилотных переключателей,
provider canaries, tests/suite, deployments или сообщений пользователям сервисов.
