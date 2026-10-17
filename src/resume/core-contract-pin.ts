/**
 * The core contract hash Herder was built against.
 *
 * Regenerate with:
 *   node -e "import('agent-resume-mcp').then(m => console.log(m.coreContractHash()))"
 *
 * and only together with a rebuild of this package — that pairing is the
 * dependency proof the monorepo relies on.
 */
export const CORE_CONTRACT_PIN = "1aa9b63f3a6e3dc3254d18c45c5d4a58d8494958512eca991100b473af1d0777";

export function pinnedCoreContract(): { hash: string; source: "pinned-in-herder" } {
  return { hash: CORE_CONTRACT_PIN, source: "pinned-in-herder" };
}