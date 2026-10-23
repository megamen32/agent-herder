/**
 * The rule of the owner about one leaf of a route — ONE place.
 *
 * A leaf is one route as the provider sees it: the provider id and the
 * provider-facing model id. The rule says which leaves may be launched, and
 * every consumer of the product asks this module:
 *
 * - the launcher (`src/autopilot/unfinished-session-launcher.ts`) admits only
 *   the leaves of the allowed families;
 * - the guard of the OpenCode integration
 *   (`integrations/opencode/agent-herder-autopilot.js`) answers with the same
 *   rule, so the panel never promises a route the guard revokes;
 * - the resume client (`packages/agent-resume/src/harness/opencode/client.ts`)
 *   answers with the same rule again.
 *
 * The rule is data, so the consumers that cannot import this module (the guard
 * is one file without a bundler, the shared core is a separate package) get a
 * generated copy of it. `scripts/generate-leaf-launch-policy.mjs` writes those
 * copies and `tests/leaf-launch-policy-single-source.test.ts` fails when they
 * drift apart, so the rule cannot be described twice by accident.
 */

/** One leaf of a route: the provider and the provider-facing model id. */
export interface ProviderLeaf {
  readonly providerId: string;
  readonly modelId: string;
}

/** One family of models the owner allows, and the pattern of its model ids. */
export interface LeafLaunchFamily {
  /** The provider ids of the family. */
  readonly providers: readonly string[];
  /** The pattern of the model ids of the family, without anchors of its own. */
  readonly modelPattern: string;
}

/** The rule of the owner about leaves, as data. */
export interface LeafLaunchPolicy {
  /** The version of the rule; the generated copies carry it. */
  readonly version: number;
  /** The pattern of the providers the owner closed for good. */
  readonly closedProviderPattern: string;
  /** The families the owner allows. */
  readonly allowedFamilies: readonly LeafLaunchFamily[];
}

/**
 * The rule itself.
 *
 * The closed providers are refused whatever the owner switches: the switch of
 * the prohibitions relaxes the routes that are merely unknown, never the
 * providers the owner closed. The allowed families are the routes the
 * launcher admits.
 */
export const LEAF_LAUNCH_POLICY: LeafLaunchPolicy = {
  version: 1,
  closedProviderPattern: "codex|claude|anthropic",
  allowedFamilies: [
    { providers: ["minimax", "minimax-code", "minimax-coding-plan"], modelPattern: "minimax|mmcode" },
    { providers: ["glm", "zai", "zai-coding-plan", "zhipu"], modelPattern: "(^|[/_-])glm([-_/]|$)" },
  ],
};

/**
 * How the refusals of the rule are announced.
 *
 * The texts live here because two consumers must say the same words: the
 * guard of the OpenCode integration throws them, and the resume client
 * recognizes the refusal of the model request by its exact text.
 */
export const LEAF_LAUNCH_REFUSAL_MESSAGES = {
  modelRequest: {
    closedProvider: "Agent Herder blocked this model request: the provider of this route is closed by the rule of the owner.",
    routeForbidden: "Agent Herder blocked this model request: the complete native provider route is forbidden or could not be verified for this project.",
  },
  subagent: {
    closedProvider: "Agent Herder blocked this child: the provider of this route is closed by the rule of the owner.",
    routeForbidden: "Agent Herder blocked this child: its complete native provider route is forbidden or could not be verified for this project.",
  },
} as const;

/** The pattern of the closed providers, compiled once. */
const CLOSED_PROVIDER_PATTERN = new RegExp(LEAF_LAUNCH_POLICY.closedProviderPattern, "u");

/** The patterns of the allowed families, compiled once. */
const ALLOWED_FAMILY_PATTERNS: readonly RegExp[] = LEAF_LAUNCH_POLICY.allowedFamilies.map(
  (family) => new RegExp(family.modelPattern, "u"),
);

/** The provider id and the model id of a leaf, as the rule reads them. */
function normalizedLeaf(leaf: ProviderLeaf): { providerId: string; modelId: string } {
  return {
    providerId: leaf.providerId.trim().toLocaleLowerCase("en-US"),
    modelId: leaf.modelId.trim().toLocaleLowerCase("en-US"),
  };
}

/**
 * True when the route leads to a provider the owner closed.
 *
 * A closed provider is refused always: no switch of the owner opens it.
 */
export function isClosedProviderLeaf(leaf: ProviderLeaf): boolean {
  const { providerId, modelId } = normalizedLeaf(leaf);
  if (!providerId || !modelId) return false;
  return CLOSED_PROVIDER_PATTERN.test(`${providerId}/${modelId}`);
}

/**
 * True when the rule of the owner lets the launcher run this leaf.
 *
 * This is the rule of the launcher: the leaf must be of an allowed family, and
 * a closed provider is never of one.
 */
export function isLeafAllowedByOwnerRule(leaf: ProviderLeaf): boolean {
  const { providerId, modelId } = normalizedLeaf(leaf);
  if (!providerId || !modelId) return false;
  if (isClosedProviderLeaf(leaf)) return false;
  return LEAF_LAUNCH_POLICY.allowedFamilies.some(
    (family, index) => family.providers.includes(providerId) && ALLOWED_FAMILY_PATTERNS[index]!.test(modelId),
  );
}

/** The answer of the rule about one leaf. */
export type LeafLaunchVerdict = "allowed" | "denied";

/**
 * The answer of the rule about one leaf, with the switch of the owner.
 *
 * The provider the owner closed is refused always. The leaf of an allowed
 * family is allowed. Every other leaf is refused while the prohibitions are
 * on, and allowed when the owner switches them off — the switch relaxes the
 * routes the rule does not know, never the providers the owner closed.
 */
export function leafLaunchVerdict(leaf: ProviderLeaf, options: { prohibitionsEnabled: boolean }): LeafLaunchVerdict {
  if (isClosedProviderLeaf(leaf)) return "denied";
  if (isLeafAllowedByOwnerRule(leaf)) return "allowed";
  return options.prohibitionsEnabled ? "denied" : "allowed";
}
