# OpenCode CWD filter leak

## Symptom

Live `GET /api/sessions?harness=opencode&cwd=%2Fhome%2Froomhacker` returned 23
rows, but only 16 had `cwd=/home/roomhacker`; 7 rows belonged to other CWDs.

## Smallest evidence

Observed on 2026-08-09 through the live Agent Herder API. Returned CWD counts:

- `/home/roomhacker`: 16
- `/home/roomhacker/openchamber-work`: 3
- `/home/roomhacker/.aionui-web/conversations/2026/07/18/codex-temp-02006fe4`: 3
- `/home/roomhacker/tmp/opencode-mac-mcp-from-100-20260629_210455/project`: 1

## Resolution

This is expected prefix-filter behavior, not a leak: `SessionSupervisor` uses
`session.cwd.startsWith(filters.cwd)`, and the API/UI documents CWD as a folder
prefix. The seven additional rows are descendants of `/home/roomhacker`.
No code change is required; retain this note as audit evidence and do not
promote it to work.
