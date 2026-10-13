---
status: fixing
trigger: "Доставленное сообщение выглядит отдельной карточкой под чатом"
created: 2026-10-13T10:30:00Z
updated: 2026-10-13T10:44:00Z
---

## Current Focus

hypothesis: composer-outbox includes terminal delivered entries; native history rendering never consumes them.
test: real screenshot, targeted delivery projection regressions, then deployed desktop/mobile browser with existing receipts and no repeat send.
expecting: confirmed user text appears in normal chat once; pending/unknown remain distinguishable.
next_action: focused checks and UI-only build/activation; preserve native runtime and old messages.

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
verification: pending focused checks and actual website acceptance.
files_changed: src/web-ui/main.tsx, composer-delivery.ts, delivered-chat.ts, tests/delivered-chat.test.ts
