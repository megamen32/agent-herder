import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const indexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const commonPath = fileURLToPath(new URL("../src/types/common.ts", import.meta.url));
const stopStorePath = fileURLToPath(new URL("../src/human-stop-store.ts", import.meta.url));
const definitionsPath = fileURLToPath(new URL("../src/mcp-tools/definitions.ts", import.meta.url));
const expectedGates = [
  "ENABLE_OPENCODE",
  "ENABLE_CLAUDE",
  "ENABLE_CLAUDE_SDK",
  "ENABLE_CODEX",
  "ENABLE_QODER",
  "ENABLE_HERMES",
  "ENABLE_ZCODE",
  "ENABLE_FAST_AGENT",
  "ENABLE_MINIMAX_CODE",
];

function parseGateValue(source: string): (value: string | undefined, fallback: boolean) => boolean {
  const match = source.match(/function parseEnvBool\(val: string \| undefined, fallback: boolean\): boolean \{([\s\S]*?)\n\}/);
  if (!match) throw new Error("parseEnvBool implementation not found");
  return new Function("val", "fallback", match[1]) as (value: string | undefined, fallback: boolean) => boolean;
}

describe("adapter enable gates", () => {
  it("enables every harness by default while retaining explicit-false gates", async () => {
    const source = await readFile(indexPath, "utf8");
    const gates = Object.fromEntries(
      [...source.matchAll(/const (ENABLE_[A-Z_]+) = parseEnvBool\(process\.env\.\1, (true|false)\);/g)]
        .map(([, name, fallback]) => [name, fallback]),
    );

    expect(Object.keys(gates).sort()).toEqual([...expectedGates].sort());
    expect(gates).toEqual({
      ENABLE_OPENCODE: "true",
      ENABLE_CLAUDE: "true",
      ENABLE_CLAUDE_SDK: "true",
      ENABLE_CODEX: "true",
      ENABLE_QODER: "true",
      ENABLE_HERMES: "true",
      ENABLE_ZCODE: "true",
      ENABLE_FAST_AGENT: "false",
      ENABLE_MINIMAX_CODE: "true",
    });
    const parseEnvBool = parseGateValue(source);
    for (const gate of expectedGates) {
      const defaultEnabled = gates[gate] === "true";
      expect(gates[gate], gate).toBe(defaultEnabled ? "true" : "false");
      expect(parseEnvBool(undefined, defaultEnabled), `${gate} default`).toBe(defaultEnabled);
      expect(parseEnvBool("false", defaultEnabled), `${gate}=false`).toBe(false);
    }
  });
});

// ===== Harness delivery gates =====

/** HarnessType is the single source of truth for which harnesses exist. */
async function declaredHarnesses(): Promise<string[]> {
  const source = await readFile(commonPath, "utf8");
  const match = source.match(/export type HarnessType = ([^;]+);/);
  if (!match) throw new Error("HarnessType not found");
  return [...match[1].matchAll(/"([^"]+)"/g)].map(([, value]) => value);
}

/** Slices one declaration out of a source file so nested fields stay distinguishable. */
function blockOf(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  const rest = source.slice(start + marker.length);
  const next = rest.search(/\n(?:export )?(?:const|function|class)\s/);
  return next === -1 ? source.slice(start) : source.slice(start, start + marker.length + next);
}

/** Top level harness selectors only: nested ones live inside other fields. */
const HARNESS_FIELD = /^ {2}harness:\s*z\s*\.enum\(\[([^\]]*)\]\)/gm;
const FROM_HARNESS_FIELD = /^ {2}fromHarness:\s*z\s*\.enum\(\[([^\]]*)\]\)/gm;

const ADDRESSING_SCHEMAS = [
  "ListAgentsSchema",
  "AgentInfoSchema",
  "FindParentSchema",
  "ListChildrenSchema",
  "ExportTranscriptSchema",
  "SendMessageSchema",
  "DeliverSchema",
  "StopAgentSchema",
];

describe("harness delivery gates", () => {
  it("lets every declared harness pass the delivery receipt gate", async () => {
    const source = await readFile(stopStorePath, "utf8");
    const match = source.match(/(\[[^\]]*\])\s*as string\[\]\)\.includes\(harness\)/);
    if (!match) throw new Error("normalizeHarness whitelist not found");
    const accepted = JSON.parse(match[1]) as string[];
    expect([...accepted].sort()).toEqual([...(await declaredHarnesses())].sort());
  });

  it("lets every declared harness be addressed by the MCP tools", async () => {
    const source = await readFile(definitionsPath, "utf8");
    const harnesses = await declaredHarnesses();
    for (const schema of ADDRESSING_SCHEMAS) {
      const block = blockOf(source, `export const ${schema} =`);
      const fields = [...block.matchAll(HARNESS_FIELD)].map((match) => match[1]);
      expect(fields.length, schema).toBe(1);
      for (const harness of harnesses) {
        expect(fields[0], `${schema} -> ${harness}`).toContain(`"${harness}"`);
      }
    }
  });

  it("lets every declared harness declare itself as the message sender", async () => {
    const source = await readFile(definitionsPath, "utf8");
    const block = blockOf(source, "export const SendMessageSchema =");
    const fields = [...block.matchAll(FROM_HARNESS_FIELD)].map((match) => match[1]);
    expect(fields.length).toBe(1);
    for (const harness of await declaredHarnesses()) {
      expect(fields[0], `fromHarness -> ${harness}`).toContain(`"${harness}"`);
    }
  });

  it("keeps session creation closed to harnesses that cannot create sessions", async () => {
    const source = await readFile(definitionsPath, "utf8");
    const block = blockOf(source, "const NamedSessionBaseSchema =");
    const fields = [...block.matchAll(HARNESS_FIELD)].map((match) => match[1]);
    expect(fields.length).toBe(1);
    expect(fields[0]).not.toContain('"minimax-code"');
  });
});
