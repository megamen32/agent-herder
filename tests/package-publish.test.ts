import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackageMetadata {
  bin?: Record<string, string>;
  description?: string;
  files?: string[];
  keywords?: string[];
  publishConfig?: { access?: string };
  scripts?: Record<string, string>;
}

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageMetadata = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
) as PackageMetadata;
const englishReadme = readFileSync(resolve(repositoryRoot, "README.md"), "utf8");

describe("npm package metadata", () => {
  it("exposes a one-line npx MCP entrypoint and publishes the animated asset", () => {
    expect(packageMetadata.bin?.["agent-herder"]).toBe("dist/index.js");
    expect(packageMetadata.scripts?.prepublishOnly).toContain("npm run build");
    expect(packageMetadata.publishConfig?.access).toBe("public");
    expect(packageMetadata.files).toEqual(
      expect.arrayContaining([
        "dist",
        "docs/assets/agent-herder-animated.svg",
        "README.md",
        "README.ru.md",
        "README.zh.md",
      ]),
    );

    const animatedSvg = readFileSync(
      resolve(repositoryRoot, "docs/assets/agent-herder-animated.svg"),
      "utf8",
    );
    expect(animatedSvg).toMatch(/@keyframes|<animate\b/);
  });

  it("keeps the landing page searchable and immediately actionable", () => {
    for (const phrase of [
      "Agent Herder",
      "MCP control center for coding agents",
      "Start in 30 seconds",
      "MCP server",
      "npx -y agent-herder",
      "Monitor, inspect, and coordinate",
      "OpenCode",
      "Claude Code",
      "Codex CLI",
      "Qoder",
      "find_parent",
      "list_children",
      "get_transcript",
    ]) {
      expect(englishReadme).toContain(phrase);
    }
    expect(packageMetadata.description).toContain("parent/child sessions");
    expect(packageMetadata.keywords).toEqual(
      expect.arrayContaining(["agent-orchestration", "transcript-search", "mcp-server"]),
    );
  });
});
