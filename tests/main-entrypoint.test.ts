import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMainEntrypoint } from "../src/main-entrypoint.js";

describe("ESM main entrypoint", () => {
  it("recognizes direct and symlink launches without treating another imported module as main", async () => {
    const root = await mkdtemp(join(tmpdir(), "herder-main-"));
    try {
      const main = join(root, "main.mjs"), alias = join(root, "alias.mjs");
      const other = join(root, "other.mjs");
      await writeFile(main, ""); await writeFile(other, ""); await symlink(main, alias);
      expect(isMainEntrypoint(pathToFileURL(main).href, main)).toBe(true);
      expect(isMainEntrypoint(pathToFileURL(main).href, alias)).toBe(true);
      expect(isMainEntrypoint(pathToFileURL(alias).href, main)).toBe(true);
      expect(isMainEntrypoint(pathToFileURL(other).href, alias)).toBe(false);
      expect(isMainEntrypoint(pathToFileURL(main).href, "")).toBe(false);
      expect(isMainEntrypoint(pathToFileURL(main).href, join(root, "missing"))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
