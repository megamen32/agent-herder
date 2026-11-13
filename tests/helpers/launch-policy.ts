import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationLaunchPolicyStore, type AutomationLaunchPolicy } from "../../src/automation-launch-policy.js";

/**
 * A launch policy store on a temporary file that holds one valid document.
 *
 * The health remediation route reads the launch policy before it admits a
 * repair: the deny-only model policy is evaluated against that document, so a
 * test of the route needs a store that answers with a valid policy instead of
 * an absent or unreadable one.
 */
export async function createLaunchPolicyStore(
  overrides: Partial<AutomationLaunchPolicy> = {},
): Promise<AutomationLaunchPolicyStore> {
  const directory = await mkdtemp(join(tmpdir(), "herder-launch-policy-"));
  const store = new AutomationLaunchPolicyStore(join(directory, "automation-launch-policy.json"));
  await store.replace({
    version: 1,
    allowedHarnesses: ["opencode", "codex", "zcode", "hermes", "fast-agent"],
    preferredHarness: "opencode",
    models: {
      opencode: "minimax-coding-plan/MiniMax-M3.1-Flash",
      codex: "gpt-6.1-sol",
      zcode: "account:zai-individual-coding-plan/GLM-5.3-Flash$high",
      hermes: "gpt-5.6-luna",
      "fast-agent": "minimax/MiniMax-M3.1-Flash",
    },
    ...overrides,
  });
  return store;
}
