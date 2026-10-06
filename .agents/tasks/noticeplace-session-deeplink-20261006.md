# Notice Place session deep links

Status: published and accepted through the final native browser path.

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

Acceptance after deployed Herder code9a7299a: canonical planner URL
https://agent.bezrabotnyi.com/#/session/codex%3A01a1103b-803f-7d60-9748-bff6fe3cdc62
selected exactly that key after the quick-list refresh. The settled heading was
health_orchestrator_100_38fcda58a68b; inspector showed Codex, gpt-5.6-sol and
idle state; the actual assistant plan JSON rendered. The owned browser closed.
Screenshot: /home/roomhacker/agents-projects/noticeplace/.tmp/session-links-20261006/native-planner-exact-chat.png.
The old user-reported message5607 also opened its exact historical chat through
the legacy alias, independently of active-list membership.

Notice native incident inc_ee4ade42399b4a39bf91c1f7c8673512 / Hub
72c67c6642dfd803a059b8ffb64522cd completed with three plans. Telegram
messages5638/5639 actually contain the canonical URL in text; button5639 has
the same planner URL. Receiver-side read succeeded through the authorized
Careviolan account; primary private-group resolution remains a separate access
condition. The current active account was restored. No phone proof is required.

Launch-policy web controls showed Codex/ZCode checked, preferred Codex,
models gpt-5.6-sol and account:zai-individual-coding-plan/GLM-5.3-Flash$high.
One unchanged Save displayed 'Настройки сохранены'; GET returned the identical
persisted policy. Screenshot: /home/roomhacker/agents-projects/noticeplace/.tmp/session-links-20261006/launch-policy-saved-controls.png.
No preference flip, automation toggle, extra native chain, build or restart
was performed during this acceptance. No task-owned source work remains.
