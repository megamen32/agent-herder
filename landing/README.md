# Agent Herder public landing

Public URL: https://agentherder.bezrabotnyi.com/

Public navigation links only to product websites, not personal operator workspaces.
The main actions remain self-hosted installation and open source. The ecosystem
navigation links to ШТАТНО, Notice Place, GPTAdmin and UserIO. Airlock is marked
as a partner integration and links to https://airlockrun.ru/ (not a beta cabinet).
Run the small offline regression checks with `python3 landing/test_navigation.py`.
Navigation-only checks run sequentially inside the inherited host guard: one
Python/Node process at a time, Node heap bounded to128MiB, no GPU/daemons,
under20MiB temporary files, emergency wall/CPU budget300s. Do not rebuild the
application runtime for public navigation edits.

Buildless Russian product site. Owns index.html, styles.css, landing.js and assets. The first screen positions Agent Herder as a mesh across computers. Five unedited 1680x1050 screenshots were freshly captured from the owner's authenticated https://agent.bezrabotnyi.com/ UI on 2026-10-12: chat, session controls, statistics, activity charts and background tasks. Source/viewport/checksums are in assets/captures.json. They represent the captured state, not a promise of live counters or universal harness capabilities. No mock interface or diagram.

Source install explicitly sets AGENT_HERDER_WEB_PORT=18787 because src/index.ts enables HTTP/Web UI only with that variable. The unavailable npm package is not advertised.

Publish only owned static files to /var/www/agentherder on server-100. Assets first, index atomically last, directory755/file644. Rollback under ignored .tmp/. Do not build or restart shared Agent Herder for landing edits.

Physical ingress/DNS/TLS: ServersAdministartion docs/inventory/sites/agentherder.md. GitHub homepage points to this URL.
