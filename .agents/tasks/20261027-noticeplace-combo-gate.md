# NoticePlace: выбранная комбо в purpose gate

## Поручение и границы

Владелец передал от NoticePlace DRI01a17ea3 проверенный отказ: installed
NoticePlace DEFAULT_INCIDENT_MODEL и live Herder models.opencode используют
`omniroute/minimax-combo-m3.1`, а отдельный analysis gate пропускает лишь
GLM+MiniMax комбо. Нужно разрешить точный выбранный маршрут, сохранив GLM
и dedicated purpose bearer, source/no-replay guards и текущую model policy.

1. Worker меняет только src/automation/noticeplace-health-launch.ts: точный
   allowlist и qualification поддерживаемого bare model ID; без defaults.
2. Root проверяет diff, TypeScript/build, публикует main и устанавливает
   совместимый срез, сохраняющий Codex Normal/Fast и предыдущие receipts.
3. Ровно один новый QA incident/e2e принадлежит соседней сессии01a17ea3;
   root ничего не запускает повторно и передаёт installed receipt.

Конфиги профилей и credential синхронизированы peer в canonical herder.env;
значения не читать в контекст. По новому прямому сообщению root — единственный
executor одного последующего restart Herder, который активирует auth+gate.
Не менять другие сервисы, маршруты, глобальную автоматику, модель или токен.
Tests/suite не добавлять/не запускать по developer instruction. Отдельная
проверка root — compiler/artifact/installed readback; бизнес QA только peer.

Попытка доставить peer техническую границу через current-turn MCP не принята:
model_not_permitted_for_project (его Codex gpt-6.1-sol, project policy разрешает
только GLM combo). Доставка не повторялась, политика не обходилась.

Приёмка предыдущего Codex tier продолжается read-only browser worker; новые
native сессии/модельные ходы там запрещены. Это независимая проверка формы,
не дублирующий incident canary.
