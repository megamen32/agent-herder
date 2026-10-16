/**
 * The core contract hash Herder was built against.
 *
 * Regenerate with:
 *   node -e "import('agent-resume-mcp').then(m => console.log(m.coreContractHash()))"
 *
 * and only together with a rebuild of this package — that pairing is the
 * dependency proof the monorepo relies on.
 */
export const CORE_CONTRACT_PIN = "bef86c0bada100933b4c18251062e031b2940efdb230af391999e25a2bfa4c37";

export function pinnedCoreContract(): { hash: string; source: "pinned-in-herder" } {
  return { hash: CORE_CONTRACT_PIN, source: "pinned-in-herder" };
}