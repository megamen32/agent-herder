import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("Herder plugin external shared MCP registration", () => {
  it("leaves authenticated MCP registration to the host without embedding credentials or starting a core", () => {
    const registrations = [];
    for (const filename of [".mcp.json", "mcp.json"]) {
      const manifest = JSON.parse(readFileSync(resolve(root, filename), "utf8"));
      expect(manifest.mcpServers).toEqual({});
      registrations.push(manifest.mcpServers);
      expect(JSON.stringify(manifest)).not.toMatch(/18787|authorization|bearer|command|token/i);
    }
    expect(registrations[0]).toEqual(registrations[1]);
  });
  it("keeps plugin entrypoints and skills while retiring only their legacy HTTP hooks", () => {
    const legacy = JSON.parse(readFileSync(resolve(root, ".codex-plugin/plugin.json"), "utf8")) as {
      hooks?: string;
      mcpServers?: string;
      skills?: string;
    };
    const portable = JSON.parse(readFileSync(resolve(root, "plugin.json"), "utf8")) as {
      extensions?: { "com.openai"?: { hooks?: string } };
    };

    expect(legacy.hooks).toBe("./com.openai/hooks/hooks.json");
    expect(portable.extensions?.["com.openai"]?.hooks).toBe(legacy.hooks);
    expect(legacy.mcpServers).toBe("./.mcp.json");
    expect(legacy.skills).toBe("./skills/");

    for (const filename of [legacy.hooks!, ".codex-plugin/hooks.json", "hooks/hooks.json"]) {
      const hooks = JSON.parse(readFileSync(resolve(root, filename), "utf8"));
      expect(hooks.hooks).toEqual({});
    }
  });
});
