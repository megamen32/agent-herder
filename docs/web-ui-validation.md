# Agent Herder web UI validation and resource budget

The shared agent workspace follows the supplied Codex reference: functional navigation rail, session sidebar, grey chat surface, readable messages and responsive composer. Keep existing session filters, grouping, history, automation controls and runtime APIs intact.

## Resource budget

On server-100, use the existing guarded SSH session and at most one heavy workload at a time across this project. Build with `NODE_OPTIONS=--max-old-space-size=1024 npm run build`; run focused Vitest checks with `--maxWorkers=1`. Avoid builds and broad suites under sustained host pressure. Accepted build heap ceiling is 1 GiB with one worker, no additional swap allowance or background process. Build output stays in `dist/`, diagnostics in ignored `.tmp/`. No GPU workload is involved.

Follow the current owner resource policy in `ServersAdministartion/templates/agent-browser-routing/README.md`: measure live load and available capacity. The owner removed the old artificial agent-stack CPU, RAM, process and I/O quotas on 2026-10-18; do not restore them from older runbooks.

## Verification

- TypeScript and Vite production build.
- Focused web-ui, web-ui-controls and launch-policy-settings tests.
- For `agent.bezrabotnyi.com`, the public `/` and `/assets/` locations are pinned to an immutable release under `/var/www/agent-herder-ui/<commit>`. The managed pin lives in `ServersAdministartion/nginx-dev/state/files/sites-available/agent.bezrabotnyi.com`; rebuilding `dist/web-static` or restarting `agent-herder.service` alone does not publish a new public UI. Stage only `dist/web-static`, update and apply that vhost through the nginx-dev workflow, then verify the active release header and the authenticated browser page. Keep the previous release intact for rollback.
- Normalize the staged public tree to root-owned directories `0755` and files `0644` before changing the pin. Build artifacts may contain private `0600` file modes; `cp -a` preserves those and nginx then returns 404 through `try_files`. Verify `sudo -u www-data test -r /var/www/agent-herder-ui/<commit>/index.html` and the staged asset files before publication.
- Real browser desktop and 390px mobile: open existing session messages, navigate rail sections, confirm Fast Agent and MiniMax in the new-chat form without launching work merely for a visual check.
- Mobile folder suggestions must scroll inside the form while model/Create and composer remain reachable.
- Automation keyboard navigation must reach visible controls and collapsed advanced summaries, never hidden fields.
- Capture final screenshots and real session consumer canary after all intentional backend restarts and deployment changes finish.

`npm run build` writes static output served by the running backend, so treat it as deployment-affecting. The public static pin is a separate deployment step described above. Finish source review and scoped commit/push before final deploy/build and acceptance canary.
