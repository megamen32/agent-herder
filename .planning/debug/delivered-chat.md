---
status: resolved
trigger: "Доставленное сообщение выглядит отдельной карточкой под чатом"
created: 2026-10-13T10:30:00Z
updated: 2026-10-13T11:15:28.559584+00:00
---

## Current Focus

hypothesis: composer-outbox includes terminal delivered entries; native history rendering never consumes them.
test: real screenshot, targeted delivery projection regressions, then deployed desktop/mobile browser with existing receipts and no repeat send.
expecting: confirmed user text appears in normal chat once; pending/unknown remain distinguishable.
next_action: current defect resolved; pins and compact context remain planned, not started.

## Symptoms

expected: delivered human message is an ordinary chronological chat bubble.
actual: green-bordered raw-text delivered card remains outside the chat, above a read-only composer.
errors: no delivery failure claimed; screenshot explicitly says delivered.
reproduction: delivered local outbox entry while native history is missing or delayed.

## Evidence

- User screenshot 2026-10-13: terminal card in composer, Markdown shown as raw asterisks.
- main.tsx renders all activeOutbox states in composer; normal chat uses native details.messages alone.
- SessionMessageView has no general inputId field. Presentation matching must not change native admission or replay sends.
- First bounded unit case refused exit75 before payload: current inherited original caps differ from historical runner contract. Retained in .tmp/delivered-chat-20261013/red; not a failing test run and not GREEN. Existing runner owner received the exact new task.

## Resolution

root_cause: terminal delivery receipt was never projected into the normal message timeline.
fix: delivered entries use the existing user-message renderer; only unfinished/failed entries stay in composer. Reconcile one-to-one against native identity/body/admission timing; preserve unknown states and receipts.
verification: focused regressions, full noEmit and Vite build PASS in38.015s; public authenticated desktop1440 and mobile390 on server44 PASS, including native-history deduplication and delayed-history browser scenario.
files_changed: src/web-ui/main.tsx, composer-delivery.ts, delivered-chat.ts, tests/delivered-chat.test.ts

## Actual delivery

- Herder source9f399f1, Admin public route988f36d9; old released assets retained.
- Public nginx static root, not backend dist, is authoritative for this UI. Initial dist-only apply did not reach public route; old-bundle screenshot retained before corrected route activation.
- Same Herder PID1072026/invocation16346a7b before/after frontend apply; native/backend restart0.
- Existing exact admission was copied into a private QA browser; message POST/resume/model0. Before: delivered card1. After: card0, original user bubble1. Delayed native GET scenario preserves bubble1; real history restoration stays bubble1.
- Mobile390 final chat visible/no horizontal overflow; earlier inspector-only screenshot is not acceptance.
- Independent source review SHIP. Full evidence: .tmp/delivered-chat-20261013/public-site-acceptance.json.
- Runner75 before payload and first Vitest --minWorkers failure retained separately; corrected release-v3 native helper0/585682944B/swapOOM0/same-generation cleanup.
