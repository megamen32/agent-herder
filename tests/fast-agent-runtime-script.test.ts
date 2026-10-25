import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import * as workloadLauncher from "../src/workload-launcher.js";
import { FastAgentFileAdapter } from "../src/adapters/fast-agent.js";
import { fixtureInterpreter } from "./helpers/fast-agent-interpreter.js";

/**
 * The script that creates a session of Fast Agent is a file of the runtime
 * state and never an argument of the command line: the command line of a
 * scope becomes the Description of the transient unit, and a line break in it
 * breaks the unit file of the scope.
 */

const cleanups: string[] = [];
const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;

beforeAll(() => {
  // The runtime state of the test: not the runtime of the user.
  process.env.XDG_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "agent-herder-fast-agent-test-"));
});
afterAll(() => {
  if (originalRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A home with the native package of Fast Agent and its Python entrypoint. */
async function fixtureHome(prefix: string): Promise<string> {
  const root = process.env.TMPDIR || join(process.cwd(), ".tmp");
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(join(root, prefix));
  cleanups.push(home);
  // The native package lives in the site-packages of the interpreter of the
  // fixture, as in the real deployment: the herder runs its script as a file,
  // and the path of a script is the directory of that script, not the working
  // directory.
  const { interpreter, sitePackages } = fixtureInterpreter(home);
  const moduleDir = join(sitePackages, "fast_agent", "session");
  await mkdir(moduleDir, { recursive: true });
  await writeFile(join(sitePackages, "fast_agent", "__init__.py"), "");
  await writeFile(join(moduleDir, "__init__.py"), "");
  await writeFile(join(moduleDir, "session_manager.py"), [
    "import json",
    "from pathlib import Path",
    "from types import SimpleNamespace",
    "class SessionManager:",
    "    def __init__(self,cwd,home_override): self.cwd=cwd; self.home=Path(home_override)",
    "    def create_session(self,name,metadata):",
    "        directory=self.home/'sessions'/name",
    "        directory.mkdir(parents=True,exist_ok=True)",
    "        (directory/'session.json').write_text(json.dumps({'session_id':name,'metadata':{'title':metadata.pop('title',None),'extras':metadata},'continuation':{'cwd':metadata.pop('cwd')}}))",
    "        return SimpleNamespace(info=SimpleNamespace(name=name))",
  ].join("\n"));
  await writeFile(join(home, "fast-agent"), `#!${interpreter}\n`);
  return home;
}

/** The arguments of the spawn that creates a session. */
async function createSessionArguments(name: string): Promise<string[]> {
  const home = await fixtureHome(`fast-agent-script-${name}-`);
  vi.stubEnv("PYTHONPATH", home);
  const isolated = vi.spyOn(workloadLauncher, "spawnIsolatedWorkload");
  const adapter = new FastAgentFileAdapter({ home, cwd: home, fastAgentBin: join(home, "fast-agent") });
  const session = await adapter.createSession({ name, cwd: home, model: "generic.MiniMax-M3" });
  expect(session.id).toMatch(new RegExp(name));
  // The native session exists: the script ran.
  expect(await readFile(join(home, "sessions", name, "session.json"), "utf8")).toContain(name);
  return isolated.mock.calls[0]?.[1] ?? [];
}

describe("the create-session script of Fast Agent", () => {
  it("keeps the text of the script out of the arguments of the spawn", async () => {
    const args = await createSessionArguments("rule-worker");
    expect(args).not.toContain("-c");
    expect(args.join("\n")).not.toContain("SessionManager");
    expect(args.join("\n")).not.toContain("sys.argv");
    for (const argument of args) expect(argument).not.toMatch(/\n/);
    const scriptPath = args[0];
    expect(scriptPath).toMatch(/^\//);
    expect(scriptPath.endsWith(".py")).toBe(true);
    const text = await readFile(scriptPath, "utf8");
    expect(text).toContain("from fast_agent.session.session_manager import SessionManager");
    expect(text).toContain("sys.argv[1:]");
  });

  it("writes the script as a file of the runtime state, addressed by its digest", async () => {
    const args = await createSessionArguments("digest-worker");
    const scriptPath = args[0];
    const text = await readFile(scriptPath, "utf8");
    const digest = createHash("sha256").update(text).digest("hex").slice(0, 16);
    expect(basename(scriptPath)).toContain(digest);
    expect(statSync(scriptPath).mode & 0o777).toBe(0o400);
    expect(statSync(dirname(scriptPath)).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(scriptPath)).uid).toBe(process.getuid?.());
  });
});
