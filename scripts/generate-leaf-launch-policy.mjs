/**
 * The generator of the copies of the rule of the owner about leaves.
 *
 * The rule itself is written once, in `src/model-launch-policy.ts`. Two
 * consumers cannot import it: the guard of the OpenCode integration is one
 * file the owner installs without a bundler, and the shared core is a separate
 * package with its own compiler settings. Both get a generated copy:
 *
 * - the guard gets the transpiled module inside its own file, between the
 *   markers below, so the guard stays one self-contained file;
 * - the shared core gets the module itself, next to the client that uses it.
 *
 * Run `node scripts/generate-leaf-launch-policy.mjs` to write the copies and
 * `node scripts/generate-leaf-launch-policy.mjs --check` to fail when a copy
 * has drifted away from the source. The test of the single source runs the
 * check, so a copy that was edited by hand breaks the build.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const POLICY_SOURCE_PATH = "src/model-launch-policy.ts";
export const POLICY_PLUGIN_PATH = "integrations/opencode/agent-herder-autopilot.js";
export const POLICY_CORE_PATH = "packages/agent-resume/src/harness/opencode/leaf-launch-policy.generated.ts";

export const POLICY_BLOCK_BEGIN = "// >>> agent-herder:leaf-launch-policy (generated; do not edit) >>>";
export const POLICY_BLOCK_END = "// <<< agent-herder:leaf-launch-policy <<<";

const CORE_HEADER = [
  "// GENERATED FILE — do not edit it by hand.",
  `// Source: ${POLICY_SOURCE_PATH}`,
  "// Regenerate: node scripts/generate-leaf-launch-policy.mjs",
  "",
].join("\n");

/** The module of the rule as plain JavaScript, without the export keywords. */
export function renderPolicyJavaScript(source) {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      removeComments: false,
    },
    fileName: POLICY_SOURCE_PATH,
  });
  const javascript = outputText.replace(/^export /gm, "").trimEnd();
  if (/\b(?:import|require)\s*\(/.test(javascript) || /^import\s/m.test(javascript)) {
    throw new Error("the rule of the owner must stay self-contained: it cannot import anything");
  }
  return `${javascript}\n`;
}

/** The copy of the rule for the shared core: the module itself. */
export function renderCoreCopy(source) {
  return `${CORE_HEADER}${source.trimEnd()}\n`;
}

/** The copy of the rule for the guard: the module inside its own file. */
export function renderPluginFile(pluginSource, policyJavaScript) {
  const begin = pluginSource.indexOf(POLICY_BLOCK_BEGIN);
  const end = pluginSource.indexOf(POLICY_BLOCK_END);
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error(`the guard must keep the markers of the generated rule: ${POLICY_BLOCK_BEGIN}`);
  }
  const head = pluginSource.slice(0, begin + POLICY_BLOCK_BEGIN.length);
  const tail = pluginSource.slice(end);
  return `${head}\n${policyJavaScript}${tail}`;
}

/** Every copy of the rule, rendered from the source of the rule. */
export function renderArtifacts() {
  const source = readFileSync(join(REPO_ROOT, POLICY_SOURCE_PATH), "utf8");
  const policyJavaScript = renderPolicyJavaScript(source);
  const pluginSource = readFileSync(join(REPO_ROOT, POLICY_PLUGIN_PATH), "utf8");
  return [
    { path: POLICY_PLUGIN_PATH, content: renderPluginFile(pluginSource, policyJavaScript) },
    { path: POLICY_CORE_PATH, content: renderCoreCopy(source) },
  ];
}

/** The copies that do not match the source of the rule. */
export function driftedArtifacts() {
  return renderArtifacts().filter((artifact) => {
    let current;
    try {
      current = readFileSync(join(REPO_ROOT, artifact.path), "utf8");
    } catch {
      return true;
    }
    return current !== artifact.content;
  });
}

function main() {
  const check = process.argv.includes("--check");
  const drifted = driftedArtifacts();
  if (check) {
    if (drifted.length > 0) {
      console.error(`the copies of the rule of the owner drifted: ${drifted.map((item) => item.path).join(", ")}`);
      console.error("run: node scripts/generate-leaf-launch-policy.mjs");
      process.exit(1);
    }
    console.log("the copies of the rule of the owner match the source");
    return;
  }
  for (const artifact of renderArtifacts()) {
    writeFileSync(join(REPO_ROOT, artifact.path), artifact.content);
    console.log(`written: ${artifact.path}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
