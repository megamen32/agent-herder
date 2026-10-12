# Agent Herder public landing

Public URL: https://agentherder.bezrabotnyi.com/

This buildless Russian product site owns index.html, styles.css, landing.js and its assets. Screenshots are already-public copies from docs/assets/screenshots, verified against GitHub blobs. The architecture diagram is explanatory, not live runtime data. No application API, account store or forms.

Source install explicitly sets AGENT_HERDER_WEB_PORT=18787 because src/index.ts starts the HTTP/Web UI only when that variable is set. The unavailable public npm package is not advertised.

Publish only these owned static files to /var/www/agentherder on server-100. Copy assets before atomically replacing index.html; apply directory755/file644 modes for nginx. Preserve rollback under the repository's ignored .tmp/. Do not run the product runtime build or restart shared Agent Herder for a landing edit.

The physical ingress, DNS/TLS and managed vhost belong to ServersAdministartion, docs/inventory/sites/agentherder.md. GitHub's homepage points to this public URL.
