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

Исторический receipt переиспользуется как доказательство fixture-сценария. Перед финальным PASS его нужно связать с новым source SHA, artifact digest, installed runtime и independent consumer readback.

## Gates

| ID | Gate | Состояние | Следующий результат |
| --- | --- | --- | --- |
| VS01 | Rust-owned delivery envelope/ingress | открыто | Rust принимает target/sender/inputId/message или доказанный typed mapping; ACL и owner identity проверены. |
| VS02 | Same-key replay | открыто | Повтор того же key возвращает прежний receipt и не делает новый native effect. |
| VS03 | Changed payload | открыто | Тот же key с другим payload даёт idempotency conflict до admission. |
| VS04 | HumanStop | открыто | Hold до admission блокирует отправку и переживает restart. |
| VS05 | Immutable installed consumer | открыто | Точный artifact/source/runtime identity связан с обычным MCP consumer. |
| VS06 | Independent readback | открыто | После restart читаются обе роли, export, search и projects без resend. |
| VS07 | Cross-host consumer | открыто | Remote target на server-44 или roomhacker-server-100 получает native receipt через обычный deliver. |
| VS08 | Common export | явно unsupported | Не считать ошибкой vertical slice; native export остаётся обязательным, common нужен отдельный normalized contract. |

## Порядок работы

1. Закрыть VS01 в Rust catalog/owner path и добавить focused Rust RED/GREEN.
2. Закрыть VS02–VS04 на том же durable intent store и fake native port.
3. Собрать один immutable artifact и выполнить VS05.
4. Запустить существующий OpenCode fake-model stand через обычный MCP и выполнить VS06.
5. Подключить второй node route и выполнить VS07.
6. Только после этого расширять capability matrix на следующий adapter.

## Время

Оценка для этого bounded slice: 3–5 часов рабочего времени при доступных двух нодах и готовом OpenCode binary. Source Rust envelope и negative gates могут идти параллельно с подготовкой consumer; build/install/readback остаются последовательными. Профильная или release-блокировка увеличивает срок отдельно и не считается выполнением source-only.

## Definition of done

Срез закрыт только когда один receipt содержит source SHA, artifact digest, installed runtime identity, native user/assistant IDs, request keys, resend_count=0, restart readback и independent consumer proof. Unit tests, tools/list, HTTP 200, исторический receipt или здоровый процесс сами по себе срез не закрывают.

## Не входит в этот срез

Массовый Rust rewrite, OpenCode V1, Go adapters, ChatGPT/Z.ai browser profiles, полная Linux/macOS matrix, legacy removal, UserIO migration и новый LHC plan.
