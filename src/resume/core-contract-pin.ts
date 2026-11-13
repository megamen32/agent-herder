/**
 * The core contract hash Herder was built against.
 *
 * Regenerate with:
 *   node -e "import('agent-resume-mcp').then(m => console.log(m.coreContractHash()))"
 *
 * and only together with a rebuild of this package. That pairing is the
 * dependency proof the monorepo relies on.
 */
export const CORE_CONTRACT_PIN = "42872468e218fb3192e85ab72663c70cef824cac5bc94f5ea1143022441dc285";

export function pinnedCoreContract(): { hash: string; source: "pinned-in-herder" } {
  return { hash: CORE_CONTRACT_PIN, source: "pinned-in-herder" };
}