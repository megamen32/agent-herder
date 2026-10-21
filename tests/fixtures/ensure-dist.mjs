import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let buildDir = "";

/**
 * Path of the compiled module that a cross-process fixture has to import.
 *
 * A second process cannot load the TypeScript sources, so the fixture needs the
 * built module. A checkout without dist/ builds it once per process into a
 * private directory, so that parallel test files never write the same output.
 */
export function ensureDist(entry) {
  const built = join(repoRoot, "dist", entry);
  if (existsSync(built)) return built;
  buildDir = join(repoRoot, ".tmp", `dist-build-${process.pid}`);
  const target = join(buildDir, entry);
  if (!existsSync(target)) {
    const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    const build = spawnSync(process.execPath, [tsc, "-p", join(repoRoot, "tsconfig.json"), "--outDir", buildDir], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (build.status !== 0) throw new Error(`the build of ${entry} failed (tsc exit ${build.status})`);
  }
  return target;
}

/** Drop the private build output of the process, if it created one. */
export function cleanupDistBuild() {
  if (!buildDir) return;
  const target = buildDir;
  buildDir = "";
  rmSync(target, { recursive: true, force: true });
}
