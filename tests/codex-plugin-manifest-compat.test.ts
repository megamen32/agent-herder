import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("Codex plugin hook manifest compatibility", () => {
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
