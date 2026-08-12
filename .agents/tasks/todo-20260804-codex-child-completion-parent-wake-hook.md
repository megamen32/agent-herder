# Wake parent Codex task when a child completes

## Symptom

An idle parent Codex task is not resumed after all of its children complete.
`wait_agent` can synchronously block an active parent turn, but it is not a
durable parent wake after that turn ends.

## Smallest evidence

Codex DB has `thread_spawn_edges(parent_thread_id, child_thread_id, status)`.
Agent Resume only watches PID/timer and resumes a frozen parent session; Agent
Herder can forward a chosen immutable resume target but owns no child-completion
event. Current child completion notification reached the UI but did not produce
an Agent Resume wake receipt for the parent.

## Required owner/design

The Codex multi-agent completion producer (or a dedicated coordinator directly
attached to it) must emit child completion with `parent_thread_id`, resolve an
immutable parent resume target, make an exactly-once claim, and call Agent
Resume/Agent Herder. Do not implement this as parent-PID polling.

## Blocker

Need identify the writable Codex multi-agent completion hook/API and prove its
event semantics before selecting the integration owner and implementation path.

## Status

Todo.
