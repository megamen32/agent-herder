import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  MARKER_PATTERN,
  defaultJobResumePrompt,
  matchScore,
  rankSessions,
  validateMarker,
  type SessionCandidate,
} from "../src/harness/marker-search.js";

// Focused unit: marker correlation and session selection.
// Expected <1s/max 15s. No provider, harness or native session.
const candidate = (overrides: Partial<SessionCandidate> = {}): SessionCandidate => ({
  agent: "opencode",
  sessionId: "ses_1",
  cwd: "/home/roomhacker/agents-projects",
  title: "Канарье",
  updated: 1_000,
  ...overrides,
});

it("accepts exactly five ASCII alphanumeric characters as a marker", () => {
  expect(validateMarker("A7kQ2")).toBe("A7kQ2");
  expect(validateMarker(" a7kq2 ")).toBe("a7kq2");
  expect(validateMarker(undefined)).toBeUndefined();
  expect(validateMarker("")).toBeUndefined();
  expect(() => validateMarker("A7kQ", { required: true })).toThrow(/5 ASCII alphanumeric/);
  expect(() => validateMarker("A7kQ2x")).toThrow(/5 ASCII alphanumeric/);
  expect(() => validateMarker("A7k-2")).toThrow(/5 ASCII alphanumeric/);
  expect(MARKER_PATTERN.test("Z9z09")).toBe(true);
});

it("scores an exact marker far above a text hit", () => {
  expect(matchScore(null, "A7kQ2", "Marker: A7kQ2 — starting work")).toBe(100);
  expect(matchScore("канарье", null, "Канарье")).toBe(10);
  expect(matchScore("канарье", "A7kQ2", "Канарье Marker: A7kQ2")).toBe(110);
  expect(matchScore("нет", "Z9z09", "Канарье")).toBe(0);
  // Matching is case-insensitive on both sides.
  expect(matchScore(null, "a7kq2", "marker: A7KQ2")).toBe(100);
});

it("puts the marker match first and orders the rest by recency", () => {
  const ranked = rankSessions([
    candidate({ sessionId: "ses_old", searchableText: ["Marker: A7kQ2 — work"], updated: 500 }),
    candidate({ sessionId: "ses_new", updated: 900 }),
    candidate({ sessionId: "ses_mid", updated: 700 }),
  ], { marker: "A7kQ2" });
  expect(ranked.map((item) => item.sessionId)).toEqual(["ses_old"]);
});

it("scopes by working directory and applies the limit", () => {
  const ranked = rankSessions([
    candidate({ sessionId: "ses_here" }),
    candidate({ sessionId: "ses_elsewhere", cwd: "/home/roomhacker/ServersAdministartion" }),
    candidate({ sessionId: "ses_here2" }),
  ], { cwd: "/home/roomhacker/agents-projects", limit: 1 });
  expect(ranked.map((item) => item.sessionId)).toEqual(["ses_here"]);
});

it("returns everything when no marker or query is given", () => {
  const ranked = rankSessions([candidate({ sessionId: "a" }), candidate({ sessionId: "b", updated: 2_000 })], { limit: 10 });
  expect(ranked.map((item) => item.sessionId)).toEqual(["b", "a"]);
});

it("builds the resume prompt a watched job hands to the session", () => {
  const prompt = defaultJobResumePrompt({
    jobId: "job-1", logFile: "/tmp/job.log", note: "Таймаут", marker: "A7kQ2", state: "timeout", returncode: 1, calledAtMs: 42,
  });
  expect(prompt).toContain("Background job finished.");
  expect(prompt).toContain("Marker: A7kQ2");
  expect(prompt).toContain("Job id: job-1");
  expect(prompt).toContain("Return code: 1");
  expect(prompt).toContain("do not repeat work already completed");
});