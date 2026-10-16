#!/usr/bin/env node
/**
 * Standalone Agent Resume entrypoint.
 *
 * Built and published from the Agent Herder monorepo, at the same version as
 * Herder. It exists so the core stays usable on its own; it is never maintained
 * outside this repository.
 */
import { CORE_CONTRACT, CORE_VERSION, coreContractHash } from "./contract.js";

const [command = "contract"] = process.argv.slice(2);

if (command === "contract") {
  process.stdout.write(`${JSON.stringify({ contract: CORE_CONTRACT, hash: coreContractHash(), version: CORE_VERSION })}\n`);
  process.exit(0);
}

process.stderr.write(`agent-resume: command '${command}' is not available in this build (core ${CORE_VERSION})\n`);
process.exitCode = 2;