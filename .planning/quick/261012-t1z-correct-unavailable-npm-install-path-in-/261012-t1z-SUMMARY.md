---
status: complete
verdict: PASS
---

# Standalone landing and installation guide delivered

Public URL https://agentherder.bezrabotnyi.com/. Source landing/ in this repository, static root /var/www/agentherder. The portfolio contains only an external link. GitHub About homepage and both public English/Russian READMEs point to the site, verified by GitHub API.

The Russian site contains an ivory/ink/violet hero, an explanatory session map, six documented harness names, observe/message/coordinate scenarios, two real already-public repository screenshots, image modal, source setup with clipboard button, FAQ and GitHub links. Screenshot blobs match the public repository; no fake customers, testimonials or performance claims. Existing authenticated Herder UI remains separate.

## Verified defects repaired

- Public npm package returned404. English/Russian README and landing now show source clone/ci/build/start, not the unavailable npx package. Focused docs regression confirmed2RED before the fix and3GREEN after it (about0.3s).
- src/index.ts starts HTTP/Web UI only with AGENT_HERDER_WEB_PORT set. The install command explicitly sets18787, matching the displayed UI/MCP endpoint.

## Acceptance

- HTML IDs, local assets, anchors, canonical and setup checks passed; landing.js syntax passed. Portfolio TypeScript/Vite candidate build and existing showcase contract passed in about5s.
- HTTPS200, HTTP301, all static assets200, dedicated TLS SAN correct, expiry2027-01-10. Wildcard DNS verified at authoritative SpaceWeb NS; no DNS edits.
- Real public browser1440px/390px: correct headline, no horizontal overflow, both screenshot tabs load, modal opens/Escape closes, install anchor reaches#start, FAQ opens. Clipboard write API resolves and shows success; browser clipboard readback is denied by Chromium permission, so independent readback is not claimed.
- Portfolio → О себе → Agent Herder opens the standalone URL in a new browser tab.
- Evidence .tmp/landing-20261012/desktop.png, mobile.png, install-copy.png, consumer-proof.json. Physical ingress/source and acceptance are recorded in ServersAdministartion/docs/inventory/sites/agentherder.md.
- Source ee660ea was pushed before static deployment. No runtime/dist builds, restart or foreign source edits. Existing dirty adapter/server/coordination files and active owners retained.

No clean-room product installation or coding-agent execution was part of this landing-only cycle; the setup instruction is checked against package scripts, source HTTP startup contract and public docs.
