import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackageMetadata {
  bin?: Record<string, string>;
  files?: string[];
  publishConfig?: { access?: string };
  scripts?: Record<string, string>;
}

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageMetadata = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
) as PackageMetadata;

describe("npm package metadata", () => {
  it("exposes a one-line npx MCP entrypoint and publishes the animated asset", () => {
    expect(packageMetadata.bin?.["agent-herder"]).toBe("dist/index.js");
    expect(packageMetadata.scripts?.prepublishOnly).toContain("npm run build");
    expect(packageMetadata.publishConfig?.access).toBe("public");
    expect(packageMetadata.files).toEqual(
      expect.arrayContaining(["dist", "docs/assets", "README.md", "README.ru.md", "README.zh.md"]),
    );

    const animatedSvg = readFileSync(
      resolve(repositoryRoot, "docs/assets/agent-herder-animated.svg"),
      "utf8",
    );
    expect(animatedSvg).toMatch(/@keyframes|<animate\b/);
  });
});
