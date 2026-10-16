import { CORE_CONTRACT, coreContractHash } from "agent-resume-mcp";
import { CORE_CONTRACT_PIN, pinnedCoreContract } from "./core-contract-pin.js";

/**
 * The dependency edge Herder holds onto its shared core.
 *
 * Herder compiles and runs against the core package, and pins the core contract
 * hash it was built for. A core change that changes capabilities or entrypoints
 * changes that hash, so the change cannot reach a deployment until Herder
 * re-pins it — which is exactly the coupling that used to be missing.
 */
export interface ResumeCoreBinding {
  name: string;
  version: string;
  hash: string;
  pinnedHash: string;
  capabilities: readonly string[];
  upToDate: boolean;
}

export function resumeCoreBinding(): ResumeCoreBinding {
  const hash = coreContractHash();
  return {
    name: CORE_CONTRACT.name,
    version: CORE_CONTRACT.version,
    hash,
    pinnedHash: CORE_CONTRACT_PIN,
    capabilities: CORE_CONTRACT.capabilities,
    upToDate: hash === CORE_CONTRACT_PIN,
  };
}