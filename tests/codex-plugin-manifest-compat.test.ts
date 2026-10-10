import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("Codex plugin hook manifest compatibility", () => {
  it("connects plugin clients directly to the singleton HTTP endpoint without a subprocess", () => {
    for (const filename of [".mcp.json", "mcp.json"]) {
      const manifest = JSON.parse(readFileSync(resolve(root, filename), "utf8"));
      const server = manifest.mcpServers["agent-herder"];
      expect(server.url).toBe("http://127.0.0.1:18787/mcp");
      expect(server.type).toBe(filename === "mcp.json" ? "streamable-http" : "http");
      for (const field of ["command", "args", "cwd", "env"]) expect(server).not.toHaveProperty(field);
    }
  });
  it("resolves legacy and portable manifests to the same Codex hook commands", () => {
    const legacy = JSON.parse(readFileSync(resolve(root, ".codex-plugin/plugin.json"), "utf8")) as {
      hooks?: string;
    };
    const portable = JSON.parse(readFileSync(resolve(root, "plugin.json"), "utf8")) as {
      extensions?: { "com.openai"?: { hooks?: string } };
    };

    expect(legacy.hooks).toBe("./com.openai/hooks/hooks.json");
    expect(portable.extensions?.["com.openai"]?.hooks).toBe(legacy.hooks);

    const hooksPath = resolve(root, legacy.hooks!);
    const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    const commands = Object.values(hooks.hooks ?? {}).flatMap((groups) => groups.flatMap((group) =>
      (group.hooks ?? []).map((hook) => hook.command ?? "")));

    expect(commands).toContain('node "${PLUGIN_ROOT}/scripts/codex-stop-hook.mjs"');
    expect(commands).toContain('node "${PLUGIN_ROOT}/scripts/coordination-hook.mjs"');
    expect(commands.every((command) => !command.includes("CLAUDE_PLUGIN_ROOT"))).toBe(true);
  });
});
