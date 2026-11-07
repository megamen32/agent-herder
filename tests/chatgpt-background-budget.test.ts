import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ChatGptBackgroundBudget } from "../src/adapters/chatgpt-background-budget.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herder-cooldown-")); roots.push(root);
  let now = 1_000_000;
  return { file: join(root, "state.json"), now: () => now, advance: (ms: number) => { now += ms; } };
}

it("reserves before navigation and preserves the five-minute interval across restart", () => {
  const f = fixture();
  const first = new ChatGptBackgroundBudget(f.file, f.now);
  expect(first.reserve()).toBe(true);
  expect(new ChatGptBackgroundBudget(f.file, f.now).reserve()).toBe(false);
  f.advance(299_999); expect(first.reserve()).toBe(false);
  f.advance(1); expect(first.reserve()).toBe(true);
});

it("honours Retry-After, increases repeated 429 backoff, and deduplicates the same observation", () => {
  const f = fixture(); const budget = new ChatGptBackgroundBudget(f.file, f.now);
  expect(budget.reserve()).toBe(true);
  budget.observe429("one", f.now() + 600_000);
  f.advance(599_999); expect(new ChatGptBackgroundBudget(f.file, f.now).reserve()).toBe(false);
  budget.observe429("one", 0); f.advance(1); expect(budget.reserve()).toBe(true);
  budget.observe429("two", 0); f.advance(599_999); expect(budget.reserve()).toBe(false);
  f.advance(1); expect(budget.reserve()).toBe(true);
});

it("fails closed when it cannot persist a reservation", () => {
  const f = fixture(); const budget = new ChatGptBackgroundBudget(join(f.file, "missing", "state"), f.now);
  expect(budget.reserve()).toBe(false);
});

it("does not multiply backoff when two tabs repeatedly report the same two 429s", () => {
  const f = fixture(); const budget = new ChatGptBackgroundBudget(f.file, f.now);
  expect(budget.observe429("tab-one", 0)).toBe(true);
  expect(budget.observe429("tab-two", 0)).toBe(true);
  for (let i = 0; i < 4; i++) {
    expect(new ChatGptBackgroundBudget(f.file, f.now).observe429("tab-one", 0)).toBe(true);
    expect(budget.observe429("tab-two", 0)).toBe(true);
  }
  f.advance(600_000);
  expect(budget.reserve()).toBe(true);
});
