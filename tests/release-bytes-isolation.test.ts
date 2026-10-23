/** The bytes of a release are its own: expected 3s/max 60s. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const PROBE = join(process.cwd(), "tests", "fixtures", "release-bytes-probe.py");

// The probe runs the real tools of deploy/fleet in a temporary directory and
// reports the facts it observed. Nothing of the live fleet is touched.
function probe(scenario: string): Record<string, any> {
  const root = mkdtempSync(join(tmpdir(), "release-bytes-"));
  try {
    const result = spawnSync("/usr/bin/python3", ["-B", PROBE, scenario, root], {
      encoding: "utf-8",
      timeout: 120000,
    });
    if (result.status !== 0) throw new Error(`probe ${scenario} failed: ${result.stderr}`);
    return JSON.parse(result.stdout) as Record<string, any>;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it("the release of a node owns the bytes of its tool caches", () => {
  const facts = probe("node-materialize");
  // the tool caches of the release are its own bytes, not links of the store
  expect(facts.release_cache_nlink).toBe(1);
  expect(facts.release_cache_own_inode).toBe(true);
  expect(facts.release_vitest_nlink).toBe(1);
  expect(facts.release_vitest_own_inode).toBe(true);
  expect(facts.shared_cache_files).toEqual([]);
  // the packages stay links of the store: the release shares bytes on purpose
  expect(facts.package_stays_a_link).toBe(true);
  // the release that carries the packages of the previous one owns its caches too
  expect(facts.carried_cache_nlink).toBe(1);
  expect(facts.carried_cache_own_inode).toBe(true);
  expect(facts.carried_shared_cache_files).toEqual([]);
});

it("the manifest of a release does not change when the next release is built", () => {
  const facts = probe("build");
  // the release was materialized as a hard link copy: the tool caches are shared
  expect(facts.materialized_cache_nlink).toBe(2);
  expect(facts.materialized_cache_shared).toBe(true);
  // the build gives the release its own bytes of the tool caches
  expect(facts.cache_nlink_after_build).toBe(1);
  expect(facts.cache_own_inode_after_build).toBe(true);
  expect(facts.shared_cache_files_after_build).toEqual([]);
  // the manifest of the other release is untouched by the build of this one
  expect(facts.base_manifest_unchanged).toBe(true);
  expect(facts.base_manifest_source_sha).toBe("1".repeat(40));
  expect(facts.manifest_inodes_differ).toBe(true);
  // two releases with other content do not carry the same fingerprint
  expect(facts.fingerprints_differ).toBe(true);
  expect(facts.copied_only_tool_caches).toBe(true);
});

it("the archive of a rollout carries the bytes of the release, not its links", () => {
  const facts = probe("pack");
  expect(facts.link_members).toEqual([]);
  expect(facts.unpacked_shared).toEqual([]);
  expect(facts.unpacked_nlink).toBe(1);
});
