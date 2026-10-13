---
phase: quick
plan: 1
mode: inline
---
# Управление удалённой сессией в текущем чате

Goal: same-origin remote session send/status/stop/resume through existing owner HTTP and native session, not another URL, fork or registry.

1. Extend existing selected-host transport/service/API with a bounded typed session request; preserve owner cookie, native identity, UDM inputId and no replay.
2. Upgrade RemoteSessionView using existing chat styling/message renderer/outbox semantics; cached history is read-only, session switches isolate requests and persisted outbox by full native address.
3. Focused route/identity/unknown regressions and build under existing finite profiles (ordinary combined max180s).
4. Reviewed scoped publish and coherent guarded activation; real authenticated site on44/88, own remote native fixture sends/stop/resume without URL change and independent effect/history proof.

Foreign release JS and native sessions/queues remain untouched. Browser only managed44/88. No subagents requested: run inline.
