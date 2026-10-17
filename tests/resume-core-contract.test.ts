import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CORE_CONTRACT, coreContractHash } from "agent-resume-mcp";
import { resumeCoreBinding } from "../src/resume/core-binding.js";
import { CORE_CONTRACT_PIN } from "../src/resume/core-contract-pin.js";

// Focused unit: the shared-core dependency edge itself.
// Expected <1s/max 10s. No provider, harness or native session.
const root = join(import.meta.dirname, "..");
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>;

it("Herder builds against the core it pins", () => {
  const binding = resumeCoreBinding();
  expect(binding.hash).toBe(CORE_CONTRACT_PIN);
  expect(binding.upToDate).toBe(true);
  expect(binding.name).toBe("agent-resume-core");
});

it("core, Herder and the standalone artifact share one version", () => {
  const herder = readJson("package.json");
  const core = readJson("packages/agent-resume/package.json");
  expect(core.version).toBe(herder.version);
  expect(CORE_CONTRACT.version).toBe(herder.version);
});

it("the published core declares an installable standalone entrypoint", () => {
  const core = readJson("packages/agent-resume/package.json");
  const bin = core.bin as Record<string, string>;
  // Bins must resolve inside a published directory: dist/ holds build artifacts,
  // scripts/ ships build-free .mjs installers. An unpublished path would break
  // the command right after npm install.
  expect(core.files).toContain("dist");
  expect(core.files).toContain("scripts");
  expect(Object.values(bin).every((entry) => entry.startsWith("dist/") || entry.startsWith("scripts/"))).toBe(true);
  expect(readJson("package.json").workspaces).toEqual(["packages/*"]);
  expect((readJson("package.json").dependencies as Record<string, string>)["agent-resume-mcp"]).toBe(core.version as string);
});

it("the standalone CLI reports the same contract as the library", () => {
  const printed = execFileSync(process.execPath, [join(root, "packages/agent-resume/dist/cli.js"), "contract"], {
    encoding: "utf8",
  });
  const parsed = JSON.parse(printed) as { hash: string; version: string };
  expect(parsed.hash).toBe(coreContractHash());
  expect(parsed.version).toBe(CORE_CONTRACT.version);
});

it("core capabilities never include Herder's orchestration", () => {
  const forbidden = ["coordination", "autopilot", "fleet", "mesh", "web-ui", "human-request", "choice"];
  for (const capability of CORE_CONTRACT.capabilities) {
    expect(forbidden.some((owned) => capability.includes(owned))).toBe(false);
  }
});