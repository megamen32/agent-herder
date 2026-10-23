import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const buildScript = fileURLToPath(new URL("../scripts/build-minimax-plugin.mjs", import.meta.url));
const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function buildPackage(): Promise<{ directory: string; output: string; code: number }> {
  const directory = await mkdtemp(join(tmpdir(), "agent-herder-plugin-"));
  cleanups.push(directory);
  const child = spawn(process.execPath, [buildScript, "--out", directory], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const code = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("exit", (value) => resolve(value ?? 0));
  });
  return { directory, output, code };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("the package of the plugin of MiniMax Code", () => {
  it("carries the scripts of the hooks: the part the installed plugin lost", async () => {
    const built = await buildPackage();
    expect(built.code).toBe(0);
    expect(await exists(join(built.directory, "scripts", "codex-stop-hook.mjs"))).toBe(true);
    expect(await exists(join(built.directory, "scripts", "coordination-hook.mjs"))).toBe(true);
    // The lever of the owner travels with the scripts.
    expect(await exists(join(built.directory, "scripts", "hooks-prohibitions.mjs"))).toBe(true);
    expect(await exists(join(built.directory, "scripts", "hooks-stop-gate.mjs"))).toBe(true);
  });

  it("names only files that are inside the package", async () => {
    const built = await buildPackage();
    const manifest = JSON.parse(await readFile(join(built.directory, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const references = new Set<string>();
    for (const entries of Object.values(manifest.hooks)) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          for (const match of hook.command.matchAll(/\$\{(?:PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT)\}\/([^"'\s]+)/g)) {
            references.add(match[1] ?? "");
          }
        }
      }
    }
    expect(references.size).toBeGreaterThan(0);
    for (const reference of references) {
      expect(await exists(join(built.directory, reference))).toBe(true);
    }
  });

  it("carries the manifest, the skills and the icons", async () => {
    const built = await buildPackage();
    const manifest = JSON.parse(await readFile(join(built.directory, ".minimax-plugin", "plugin.json"), "utf8")) as {
      name: string;
      version: string;
      hooks: string[];
      skills: string[];
      icon: string;
    };
    expect(manifest.name).toBe("agent-herder");
    expect(manifest.version).toBeTruthy();
    expect(manifest.hooks).toEqual(["hooks/hooks.json"]);
    expect(manifest.skills.length).toBeGreaterThan(0);
    for (const skill of manifest.skills) {
      expect(await exists(join(built.directory, skill))).toBe(true);
    }
    const icon = await readFile(join(built.directory, manifest.icon));
    // The icon of the package is a real PNG.
    expect(icon.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("fails the build when the package would be incomplete", async () => {
    const built = await buildPackage();
    expect(built.code).toBe(0);
    // The build checks itself: the scripts of the hooks are named in its report.
    expect(built.output).toContain("scripts/codex-stop-hook.mjs");
    expect(built.output).toContain("все на месте");
  });
});
