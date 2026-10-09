import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function runInstaller(hooksFile: string) {
  const script = join(dirname(fileURLToPath(import.meta.url)), "../scripts/install-codex-coordination-hook.mjs");
  return spawnSync(process.execPath, [script, "--hooks-file", hooksFile], { encoding: "utf8" });
}

describe("Codex coordination hook installer", () => {
  it("preserves existing hooks and trust settings, adds one bounded callback, and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-hooks-"));
    roots.push(root);
    const hooksFile = join(root, "hooks.json");
    const original = {
      trust: { local: true },
      globalStop: { enabled: false, handlers: ["keep"] },
      hooks: {
        enabled: false,
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "existing-prompt-handler" }] }],
        SessionStart: [{ matcher: "*", hooks: [
          { type: "command", command: "existing-session-handler" },
          { type: "prompt", prompt: "Preserve this existing non-command hook" },
        ] }],
        Stop: [{ hooks: [{ type: "command", command: "existing-stop-handler", timeout: 45 }] }],
      },
    };
    await writeFile(hooksFile, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
    await chmod(hooksFile, 0o640);

    const first = runInstaller(hooksFile);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("/hooks review only this callback");
    const firstBytes = await readFile(hooksFile, "utf8");
    const installed = JSON.parse(firstBytes) as typeof original;
    expect(installed.trust).toEqual(original.trust);
    expect(installed.globalStop).toEqual(original.globalStop);
    expect(installed.hooks.enabled).toBe(false);
    expect(installed.hooks.SessionStart).toEqual(original.hooks.SessionStart);
    expect(installed.hooks.Stop).toEqual(original.hooks.Stop);
    expect((installed.hooks as any).PreToolUse).toHaveLength(1);
    expect((installed.hooks as any).PostToolUse).toHaveLength(1);
    expect(installed.hooks.UserPromptSubmit).toHaveLength(2);
    expect(installed.hooks.UserPromptSubmit[0]).toEqual(original.hooks.UserPromptSubmit[0]);
    const callback = installed.hooks.UserPromptSubmit[1]!.hooks[0]!;
    const expectedScript = join(dirname(fileURLToPath(import.meta.url)), "../scripts/coordination-hook.mjs");
    expect(callback).toMatchObject({ type: "command", timeout: 3 });
    expect(callback.command).toContain("systemd-run --user --quiet --scope");
    expect(callback.command).toContain("-p MemoryHigh=128M -p MemoryMax=256M -p MemorySwapMax=0");
    expect(callback.command).toContain("-p CPUQuota=100% -p TasksMax=32 -p IOWeight=10 -p RuntimeMaxSec=5s");
    expect(callback.command).toContain(process.execPath);
    expect(callback.command).toContain(expectedScript);
    expect((await stat(hooksFile)).mode & 0o777).toBe(0o640);

    const second = runInstaller(hooksFile);
    expect(second.status, second.stderr).toBe(0);
    expect(await readFile(hooksFile, "utf8")).toBe(firstBytes);
    expect(JSON.parse(await readFile(hooksFile, "utf8")).hooks.UserPromptSubmit).toHaveLength(2);
  });

  it("fails closed on malformed config without overwriting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-codex-hooks-malformed-"));
    roots.push(root);
    const hooksFile = join(root, "hooks.json");
    const malformed = "{\"hooks\": [this is not valid JSON\n";
    await writeFile(hooksFile, malformed, { mode: 0o600 });
    await chmod(hooksFile, 0o640);

    const result = runInstaller(hooksFile);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Cannot parse");
    expect(await readFile(hooksFile, "utf8")).toBe(malformed);
    expect((await stat(hooksFile)).mode & 0o777).toBe(0o640);
    expect(await readdir(root)).toEqual(["hooks.json"]);
  });
});
