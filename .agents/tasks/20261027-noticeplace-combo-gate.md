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

## Установленный результат

Source main `45fbd0b9774b166fa3be984a2ff82fddcef02e0b`; immutable runtime
на server100 PID2197008, start21:45:26MSK (18:45:26Z), NRestarts0.
Bundle SHA256 `e3dcecf56c804ae5d279ac8fa802954ddb06654c42c274877562bd256c4e35fb`.
TypeScript/build/plugin/package и pinned manifest прошли. Модуль gate —
единственное изменённое продуктовое поведение относительно Codex-tier release.
Native Codex/другие runtime не перезапускались. Новые инциденты/turns не создавались.

Одно согласованное activation сохранило policy до/после рестарта
(ETag `88407dc783f0cf1744bfbb9d55027d2f`), settings hash и события:
persisted23641124 → live23641138. Текущее policy до рестарта уже отличалось
от прежнего Codex-tier receipt; root его не менял и не откатывал.
Peer-synced credential присутствует в initial environment процесса; canonical
env уже преобразован штатным SettingsStore в fingerprint. Его truncated SHA256
совпадает с credential процесса; raw значения нигде не выводились.
Receipt `.tmp/noticeplace-combo-gate-20261027/auth-readback.json`.

Exact HTTP contract: POST `/api/automation/project-launch`, purpose
`noticeplace.health-analysis`, отдельный NOTICEPLACE_HEALTH_LAUNCH_TOKEN,
harness opencode, model `omniroute/minimax-combo-m3.1` (либо точный bare ID),
непустой стабильный operation_id. Сохраняется GLM combo и остальные прежние
source/project/no-replay проверки. Root не вызывал launch endpoint.

Public static pin45fbd0b совпадает с backend; infra commit7d897d6a,
rollback20261027T184704Z, managed diff без расхождений. Все четыре static файла
побайтно совпадают с принятым ct27 интерфейсом48626f86, поэтому существующая
приёмка Normal/Fast сохранена без новой кампании. Отдельный текущий readback
fleet после refresh подтвердил100/44/88ready.

Бизнес-приёмка одного нового QA incident остаётся за01a17ea3. Root поставил
gate+auth, но не объявляет этот внешний E2E выполненным. Дополнительных
перезапусков не требуется; новый bearer/токен root не выдавал.
