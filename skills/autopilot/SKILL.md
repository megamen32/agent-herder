---
name: autopilot
description: Enable, inspect, or disable Agent Herder autopilot for the current Codex session when the user invokes /autopilot or explicitly asks for autopilot.
---

# /autopilot

Use the bundled script immediately. Do not merely explain the command.

Interpret the first argument as `on`, `status`, or `off`; default to `on`.
Run:

```bash
bash "${SKILL_ROOT}/scripts/run.sh" <on|status|off>
```

The script uses Codex's `CODEX_THREAD_ID` for the exact current task. Return its
Russian status line to the user. When enabled, the existing Stop hook invokes
the judge after this task stops; `continue` stays in this Codex task, while an
uncertain decision goes to NoticePlace as contextual buttons.
