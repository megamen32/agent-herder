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
      "Build from source",
      "MCP server",
      "git clone https://github.com/megamen32/agent-herder.git",
      "npm ci",
      "npm run build",
      "npm start",
      "Monitor, inspect, and coordinate",
      "OpenCode",
      "Claude Code",
      "Codex CLI",
      "Qoder",
      "find_parent",
      "list_children",
      "export_transcript",
    ]) {
      expect(englishReadme).toContain(phrase);
    }
    expect(packageMetadata.description).toContain("parent/child sessions");
    expect(packageMetadata.keywords).toEqual(
      expect.arrayContaining(["agent-orchestration", "transcript-export", "mcp-server"]),
    );
  });

  it("does not send first-time users to an unpublished npm package", () => {
    const russianReadme = readFileSync(resolve(repositoryRoot, "README.ru.md"), "utf8");
    for (const readme of [englishReadme, russianReadme]) {
      expect(readme).not.toContain("npx -y agent-herder");
      expect(readme).toContain("http://127.0.0.1:18787/mcp");
      expect(readme).toContain("AGENT_HERDER_WEB_PORT=18787 npm start");
    }
  });
});
