# Task: Agent Herder (Flint/Sing) UI complete business path

Status: work
Cycle: Full
Role: L

## Original request

Сделать так, чтобы Agent Flint/Sing/Саид имел всё, что заявляет: сейчас интерфейс ничего не показывает, не работает и некрасив. Все вкладки должны показывать рабочее состояние; skills должны быть видны и поддерживать добавление и включение. Нужны обязательные Adviser и context-free Tester; крупные блоки не принимаются без полного пользовательского бизнес-пути, пройденного тестировщиком без контекста. Каждый малый блок коммитить.

## Objective

Довести Agent Herder до подтверждённого реальным пользовательским путём состояния: видимые и честные состояния всех вкладок/поверхностей, управляемые skills/capabilities, аккуратный UI, рабочие backend seams и свежий независимый Tester gate.

## Business canary

Без вводного контекста открыть реальный Agent Herder web surface; увидеть текущие harness/session состояния; перейти по каждой доступной вкладке; открыть skill/capability catalog; добавить skill; включить/выключить его; убедиться, что состояние и ошибка/успех отображаются; выбрать сессию и выполнить заявленное действие; обновить страницу и убедиться в сохранённом фактическом состоянии.

## Confirmed scope

- Canonical repo candidate: `/home/roomhacker/agents-projects/agent-herder`.
- Web UI, its HTTP/API seams, capability/skill registry seams, tests, docs needed for truthful UX.
- Small vertical-slice commits on the existing delivery branch unless branch policy requires main merge.
- Independent Adviser, Reviewer, Critic, and mandatory fresh context-free Tester.

## Explicit exclusions

- No invented provider/security/ACL/database/backup/observability architecture.
- No unrelated runtime or repository cleanup.
- No claim of live deployment or restart until the exact consequential action is reached and explicitly authorized.
- No Tester context, parent history, desired verdict, or narrowed click script.

## Estimates (active minutes, immutable initial)

- Initial optimistic / likely / pessimistic: 120 / 360 / 900.
- Revision log: none yet.

## Stop and abandon

- stop_when: business canary passes with durable evidence, all selected slices reviewed, Tester passes, final commit/hand-off complete.
- abandon_when: canonical consumer is not Agent Herder, required capability has no supported seam, or user declines a material consequential boundary.
- forbidden_without_explicit_user_request: restart, deployment, rollback, destructive changes, security/ACL/secret/PII/database/backup/observability work.

## Child packages

Pending: Adviser and Explorer task files are created immediately before dispatch and each child receives only its role plus absolute task-file path.
