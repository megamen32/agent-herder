---
name: autopilot
description: Enable, inspect, or disable Agent Herder autopilot for the current Codex or Claude Code session when the user invokes /autopilot or explicitly asks for autopilot.
disable-model-invocation: true
allowed-tools: Bash(bash:*)
---

# /autopilot

Use the bundled script immediately. Do not merely explain the command.

Interpret the first argument as `on`, `status`, or `off`; default to `on`.
Claude Code executes this command directly and returns its output:

!`bash "${CLAUDE_PLUGIN_ROOT}/skills/autopilot/scripts/run.sh" "$ARGUMENTS"`

In Codex, run `bash "${SKILL_ROOT}/scripts/run.sh" "$ARGUMENTS"` with the
available shell tool and return its output.

The script uses Claude Code's `CLAUDE_CODE_SESSION_ID` or Codex's
`CODEX_THREAD_ID` for the exact current task. Return its Russian status line to
the user. When enabled, the native Stop hook invokes the judge after this task
stops; `continue` stays in the same task, while an uncertain decision goes to
NoticePlace as contextual buttons.
