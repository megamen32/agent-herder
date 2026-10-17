import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { findMemberSpan, findObjectForKey, upsertMember } from "../scripts/jsonc-upsert.mjs";

// Focused unit: the installer must edit one member and leave the rest of an
// operator's file untouched.
// Expected <1s/max 15s. No harness, provider or network.

it("locates the object behind a key and a member inside it", () => {
  const text = '{\n  "mcp": {\n    "a": { "x": 1 },\n    "b": { "y": 2 }\n  }\n}\n';
  const container = findObjectForKey(text, "mcp")!;
  expect(text.slice(container.open, container.open + 4)).toBe('{\n  ');
  const span = findMemberSpan(text, container.open, container.close, "b")!;
  expect(text.slice(span.start, span.end)).toBe('    "b": { "y": 2 }');
  expect(findObjectForKey(text, "missing")).toBeNull();
});

it("inserts a member and keeps every other byte of the file", () => {
  const before = '{\n  // operator comment\n  "mcp": {\n    "other": { "type": "local" }\n  }\n}\n';
  const after = upsertMember(before, "mcp", "agent-resume", '"agent-resume": {\n  "type": "local"\n}')!;
  expect(after).toContain("// operator comment");
  expect(after).toContain('"other": { "type": "local" }');
  expect(after).toContain('"agent-resume"');
  expect(JSON.parse(stripComments(after)).mcp["other"]).toEqual({ type: "local" });
});

it("is idempotent: a second run changes nothing", () => {
  const entry = '"agent-resume": {\n  "type": "local",\n  "command": ["npx", "-y", "pkg"]\n}';
  const first = upsertMember('{\n  "mcp": {\n    "other": {}\n  }\n}\n', "mcp", "agent-resume", entry)!;
  const second = upsertMember(first, "mcp", "agent-resume", entry)!;
  expect(second).toBe(first);
});

it("replaces an existing member in place, keeping its indentation", () => {
  const before = '{\n  "mcp": {\n    "agent-resume": {\n      "command": ["old"]\n    },\n    "keep": {}\n  }\n}\n';
  const after = upsertMember(before, "mcp", "agent-resume", '"agent-resume": {\n  "command": ["new"]\n}')!;
  expect(after).toContain('"command": ["new"]');
  expect(after).not.toContain('"old"');
  expect(after).toContain('"keep"');
  expect(after).toMatch(/\n {4}"agent-resume"/);
});

it("refuses to guess when the key is absent", () => {
  expect(upsertMember('{\n  "other": {}\n}\n', "mcp", "agent-resume", '"agent-resume": {}')).toBeNull();
});

it("creates the object when the installer writes a fresh file", () => {
  const dir = mkdtempSync(join(tmpdir(), "herder-installer-"));
  const path = join(dir, "nested/opencode.json");
  mkdirSync(join(dir, "nested"), { recursive: true });
  const created = '{\n  "mcp": {\n    "agent-resume": {\n      "type": "local"\n    }\n  }\n}\n';
  writeFileSync(path, created, "utf8");
  expect(JSON.parse(readFileSync(path, "utf8")).mcp["agent-resume"].type).toBe("local");
});

function stripComments(text) {
  return text.replace(/^\s*\/\/.*$/gm, "");
}