# Agent Herder web UI validation and resource budget

The shared agent workspace follows the supplied Codex reference: functional navigation rail, session sidebar, grey chat surface, readable messages and responsive composer. Keep existing session filters, grouping, history, automation controls and runtime APIs intact.

## Resource budget

On server-100, use the existing guarded SSH session and at most one heavy workload at a time across this project. Build with `NODE_OPTIONS=--max-old-space-size=1024 npm run build`; run focused Vitest checks with `--maxWorkers=1`. Avoid builds and broad suites under sustained host pressure. Accepted build heap ceiling is 1 GiB with one worker, no additional swap allowance or background process. Build output stays in `dist/`, diagnostics in ignored `.tmp/`. No GPU workload is involved.

Current `agent-herder.service` ceilings: MemoryHigh=1 GiB, MemoryMax=2 GiB, CPUQuota=4 cores and TasksMax=512. These are service ceilings, not build targets. SSH session limits enforce the resource guard in `/home/roomhacker/ServersAdministartion/templates/server100-resource-guard/README.md`. Preserve existing disk/I/O boundaries; this UI change raises no service or host quota.

## Verification

- TypeScript and Vite production build.
- Focused web-ui, web-ui-controls and launch-policy-settings tests, one worker.
- For `agent.bezrabotnyi.com`, the public `/` and `/assets/` locations are pinned to an immutable release under `/var/www/agent-herder-ui/<commit>`. The managed pin lives in `ServersAdministartion/nginx-dev/state/files/sites-available/agent.bezrabotnyi.com`; rebuilding `dist/web-static` or restarting `agent-herder.service` alone does not publish a new public UI. Stage only `dist/web-static`, update and apply that vhost through the nginx-dev workflow, then verify the active release header and the authenticated browser page. Keep the previous release intact for rollback.
- Real browser desktop and 390px mobile: open existing session messages, navigate rail sections, confirm Fast Agent and MiniMax in the new-chat form without launching work merely for a visual check.
- Mobile folder suggestions must scroll inside the form while model/Create and composer remain reachable.
- Automation keyboard navigation must reach visible controls and collapsed advanced summaries, never hidden fields.
- Capture final screenshots and real session consumer canary after all intentional backend restarts and deployment changes finish.

`npm run build` writes static output served by the running backend, so treat it as deployment-affecting. The public static pin is a separate deployment step described above. Finish source review and scoped commit/push before final deploy/build and acceptance canary.
