# Agent Herder — текущий OpenCode vertical slice

Дата среза: 15 ноября 2026 года.

Рабочая спецификация: AGENT-HERDER-SPEC.md.
Исторические LHC leaves и plan.json не являются этим checklist и не могут перевести его gate в done.

## Цель

Один OpenCode instance с существующим AHAP TypeScript adapter и loopback fake model должен пройти через Rust core и обычный MCP consumer:

    create/register -> deliver #1 -> native receipt -> readback
                    -> deliver #2 -> native receipt -> readback
                    -> export/search/projects -> restart -> readback без resend

После этого тот же delivery contract проверяется на второй ноде.

## Уже есть и переиспользуется

- scripts/test-model-server.py — loopback deterministic model с ответом HERDER_TEST_MODEL_OK, Responses/Chat Completions, streaming и request counter;
- tests/native/ahap_opencode_stand.py — изолированный OpenCode stand;
- acceptance/contracts/opencode.md — native OpenCode 2.2.4 route evidence;
- .agents/tasks/20261107-herder-v1-core/evidence/finish-20261108/opencode-78-result.json — исторический positive receipt: две доставки, native export, search, projects, restart/no-resend;
- src/mcp/session-tools.ts и src/mesh/ — публичный TypeScript exact delivery envelope и alias routing;
- crates/herder/src/mcp/catalog.rs — Rust typed catalog и durable action-based delivery/read contracts.

- .agents/tasks/20261107-herder-v1-core/evidence/vertical-slice-20261115/summary.json — текущая receipt-сводка VS01–VS07;
- .agents/tasks/20261107-herder-v1-core/evidence/vertical-slice-20261115/local-mcp-consumer.json — local ordinary MCP consumer;
- .agents/tasks/20261107-herder-v1-core/evidence/vertical-slice-20261115/remote-server44-mcp-consumer.json — live server-44 ordinary MCP consumer.

Исторический receipt переиспользуется как доказательство fixture-сценария. Перед финальным PASS его нужно связать с новым source SHA, artifact digest, installed runtime и independent consumer readback.

## Текущий acceptance receipt

15 ноября 2026 года новый receipt закрывает VS01–VS07. Source identity — f5e30722; Rust core был собран из 7633fafa, а изменение f5e30722 добавляет только host/sender параметры fixture. Manifest SHA-256: 89738d73951358f73363434ebc7f9f26def3aa88c592dabbb761d35e340bcad4. Core SHA-256: 93e32ec0ee987433e09c6484bd49e8c88953aa5a83234b3751fe0da382332251.

Local и server-44 receipts подтверждают action-less deliver envelope, sender в durable native receipt, same-key replay без нового fake-model request, changed-payload conflict с effect=none, HumanStop до admission и после core restart, native user/assistant readback, native export, search, project provenance и resend_count=0. В remote receipt target имеет hostId=server-44, sender имеет hostId=roomhacker-server-100, а hostname remote probe равен server-44. Это candidate artifact acceptance; production rollout в этот срез не входит.

## Gates

| ID | Gate | Состояние | Следующий результат |
| --- | --- | --- | --- |
| VS01 | Rust-owned delivery envelope/ingress | закрыто | Action-less envelope принят обычным Rust MCP consumer; target owner/ACL проверены, sender сохранён как attribution. |
| VS02 | Same-key replay | закрыто | Повтор того же key вернул прежний Task/receipt; fake model request count не изменился. |
| VS03 | Changed payload | закрыто | Тот же key с другим message вернул idempotency_conflict до admission; native effect отсутствует. |
| VS04 | HumanStop | закрыто | Hold до admission заблокировал обе попытки и сохранился после restart. |
| VS05 | Immutable artifact consumer | закрыто | Обычный MCP consumer прошёл против manifest-pinned candidate artifact/source/runtime identity. |
| VS06 | Independent readback | закрыто | После restart прочитаны обе роли, native export, search и projects; resend_count=0. |
| VS07 | Cross-host consumer | закрыто | Live server-44 consumer получил native receipt с target server-44 и sender roomhacker-server-100. |
| VS08 | Common export | явно unsupported | Не считать ошибкой vertical slice; native export остаётся обязательным, common нужен отдельный normalized contract. |

## Порядок работы

1. VS01–VS07 закрыты receipt-backed acceptance; не переоткрывать их историческим LHC plan.
2. VS08 остаётся отдельным контрактом: Common export сейчас возвращает explicit unsupported_format с effect=none.
3. Следующий adapter можно подключать только отдельным срезом после сохранения этого consumer proof.

## Время

Оценка для этого bounded slice: 3–5 часов рабочего времени при доступных двух нодах и готовом OpenCode binary. Source Rust envelope и negative gates могут идти параллельно с подготовкой consumer; build/install/readback остаются последовательными. Профильная или release-блокировка увеличивает срок отдельно и не считается выполнением source-only.

## Definition of done

Срез закрыт только когда receipt содержит source SHA, artifact digest, candidate runtime identity, native user/assistant IDs, request keys, resend_count=0, restart readback и independent consumer proof. Unit tests, tools/list, HTTP 200, исторический receipt или здоровый процесс сами по себе срез не закрывают.

## Не входит в этот срез

Массовый Rust rewrite, OpenCode V1, Go adapters, ChatGPT/Z.ai browser profiles, полная Linux/macOS matrix, legacy removal, UserIO migration и новый LHC plan.
