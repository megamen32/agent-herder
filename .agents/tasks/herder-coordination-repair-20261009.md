# Agent Herder: доставка и экономная координация

Владелец/root: Codex01a12170. Прямое поручение пользователя09.10.2026.
Изолированный Git worktree: codex/herder-coordination-20261009. Canonical чужой WIP сохранён.

| Задача | Исполнитель | Подтверждено | Следующий шаг / оценка |
| --- | --- | --- | --- |
| Точная Codex discovery/delivery без global transcript reads | Native Codex01a12176 | list Codex28.5с/all31.9с; source path подтверждён reviewer | fix + focused checks25–40мин |
| Контекст/dedup/current cwd/обмен | Root01a12170 | tag mismatch, outside-launch paths discarded | source + regression30–45мин |
| Независимый совет | delivery_review/coordination_review; ZCodec140; FastAgent | ZCode guide rejected proto.sessionNotFound до admission | supported same-ID load/council10–15мин |
| Выпуск/реальный MCP consumer | Root | ещё не выполнен | integration/deploy/canary15–25мин |

Завершение: опубликованный main, реальные list/discovery и ZCode→Codex/обратно с тем же stableID и одним native input, bounded context/rate limit/current project. Accepted/unknown mutation не replay. AutoSell/покупки не изменяются.

## Проверки перед выпуском

Native worker завершил repairs; независимые reviewers/c140/FastAgent дали проверяемые findings. Все repairs закрыты пропорциональными checks: финальный общий прогон155PASS/1path-aliasfailure+однаsyntaxошибка; после исправления affected18PASS5.72s, receipt43PASS7.11s, context21PASS1.62s, hooksHTTP5PASS3.18s. Неповреждённые результаты не повторялись. Путь экспорта сохранён, assertions не ослаблены. Обычный финальный набор сsetup и backendbuild укладывается180s. Red/failed evidence сохранено отдельно.

Final backend tsc artifact: .tmp/coordination-repair-20261009/run-temp/bounded-pns4fqy9/backend. Native buildpeak549183488B/swap0/OOM0/cleanup complete. Frontend byte-identical livecopy. Source/runtime/nativeconsumer ещё различаются; rollout и canary следующие.

C140 подтвердил safe nativeclient handoff: внешнихunfinished действий нет, всеacceptedreceiptsсохранены; доrestartновыхне начинает. Root scopedrelease толькоHerder.

Внешняя зависимость: GPTAdmin schema childjob8d2755058c7191a3833477ab7a2bdcdc осталсяqueued после~40мин. Предыдущий owner01a11755 уже имелpublished dispatchfix; ровноодинnative continuation емуadmitted19:52MSK сэтимjobбезповторногоschema. Он отвечаетза actualGPTAdmin rollout/consumer; rootmainHerder не ждёт sourceисследованияи продолжаетсвойrelease.
