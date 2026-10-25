import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * An interpreter of the fixture with the native package of Fast Agent in its
 * site-packages.
 *
 * The real deployment keeps the package of Fast Agent in the site-packages of
 * the interpreter of its entrypoint, and the herder runs its script as a file:
 * the path of a script is the directory of that script, not the working
 * directory. The fixture keeps that shape, so that the test measures the
 * herder and not the path of the interpreter.
 */
export function fixtureInterpreter(home: string): { interpreter: string; sitePackages: string } {
  const venv = join(home, "interpreter");
  execFileSync("/usr/bin/python3", ["-m", "venv", "--without-pip", venv], { stdio: "ignore" });
  const interpreter = join(venv, "bin", "python");
  const sitePackages = execFileSync(
    interpreter,
    ["-c", "import sysconfig;print(sysconfig.get_paths()['purelib'])"],
    { encoding: "utf8" },
  ).trim();
  mkdirSync(join(sitePackages, "fast_agent", "session"), { recursive: true });
  return { interpreter, sitePackages };
}
