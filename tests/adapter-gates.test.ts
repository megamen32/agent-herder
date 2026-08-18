import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const indexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const expectedGates = [
  "ENABLE_OPENCODE",
  "ENABLE_CLAUDE",
  "ENABLE_CLAUDE_SDK",
  "ENABLE_CODEX",
  "ENABLE_QODER",
  "ENABLE_HERMES",
  "ENABLE_ZCODE",
  "ENABLE_FAST_AGENT",
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
