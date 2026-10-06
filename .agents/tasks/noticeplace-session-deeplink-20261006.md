# Notice Place session deep links

Status: focused tests pass; publication and live UI acceptance pending.

A real Notice Place link selected another active chat. The producer used the
legacy #harness/session route; the React UI expects #/session/encoded-key.
Even canonical links were cleared by loadSessions when the completed diagnosis
was absent from the quick active list. Preserve explicit linked selection on
refresh; continue fetching its details independently. Accept old delivered URLs
as aliases so existing buttons remain useful. Invalid escapes fail safely.

Own main.tsx, session-list.ts, session-selection.test.ts and this record.
Do not disturb the parallel completion/grants commits or README edits.
Publication/deployment is coordinated with session
01a10b3f-b648-74d0-8265-023d1ae85312. Only the frontend needs deployment;
no Codex daemon or Herder backend restart belongs to this fix.

Budget: one serial focused Vitest process (maxWorkers=1, 60-second timeout),
then one Vite frontend build with NODE_OPTIONS=--max-old-space-size=512 and a
120-second timeout. Existing session guard remains 6/8 GiB soft/hard RAM,
1 GiB swap, eight CPUs and 4096 tasks shared by the harness; no parallel heavy
work, GPU or quota changes. Dist output is bounded to 32 MiB and browser proof
uses one tab/two renderers, closes after acceptance, and stays in project .tmp.
Backend measured 292 MiB/11 tasks under its separate 1/2 GiB, four-CPU,
512-task service ceiling. No backend rebuild or restart is needed.
