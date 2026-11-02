# catalog-mesh-target-discovery

Description: PR25 hides mesh_route and mesh_deliver from tools/list although the consolidated deliver currently accepts only legacy flat session identity, not mesh target{hostId,harness,nativeSessionId}, sender and inputId. A fresh agent loses discoverable remote mesh delivery.
Evidence: c6f7ba9 src/mcp/tool-consolidation.ts final hidden-set block vs src/mcp/session-tools.ts DeliverSchema and src/mesh/register-tools.ts delivery/mesh_route. Confirmed by independent source review.
Blocks: guarded release of tool-consolidation PR25
Status: fixed
History:
- 2026-11-02: Independent review identified missing action facades for mesh target. Must reuse native mesh_route/mesh_deliver handlers, original validation, trustedIngress and no-retry semantics. Never permit implicit ordinary fallback.

- 2026-11-02: Fixed with hybrid deliver target{} facade delegating the same original mesh_deliver/mesh_route handler; local and remote tests 2/2 passed, and full focused suite 6/6 passed. Remote missing mesh transport refuses before any send. Legacy direct aliases remain callable.

- 2026-11-02: Full-suite verified SHA 71f8fa2: 4318 passed, 14 skipped, 0 failed/unhandled. Exact full receipt in .catalog-release-all.log; status/history preserved, no record deleted.
