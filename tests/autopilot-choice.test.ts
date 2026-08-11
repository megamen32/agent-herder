import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ChoiceRegistry,
  type AutopilotChoiceDecision,
} from "../src/autopilot/choice-registry.js";

describe("bounded autopilot choices", () => {
  it("persists 2-4 opaque choices bound to one Codex stop and claims one atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-choice-"));
    const registry = new ChoiceRegistry(join(root, "choices.json"));
    const record = await registry.create({
      sessionId: "codex-session-1",
      turnId: "turn-1",
      cwd: "/workspace",
      choices: [
        { choiceId: "choice-a", label: "Inspect logs", nextGoal: "goal-ref-a" },
        { choiceId: "choice-b", label: "Run tests", nextGoal: "goal-ref-b" },
      ],
    });

    expect(record.status).toBe("pending");
    expect(record.choices).toHaveLength(2);
    const claimed = await registry.claim(record.requestId, "choice-b");
    expect(claimed).toMatchObject({ status: "claimed", choiceId: "choice-b", nextGoal: "goal-ref-b" });
    await expect(registry.claim(record.requestId, "choice-a")).resolves.toEqual(claimed);
  });

  it("rejects malformed decision cardinality", async () => {
    const registry = new ChoiceRegistry(join(await mkdtemp(join(tmpdir(), "agent-herder-choice-")), "choices.json"));
    await expect(registry.create({
      sessionId: "s", turnId: "t", cwd: "/workspace",
      choices: [{ choiceId: "only", label: "Only", nextGoal: "goal" }],
    })).rejects.toThrow("2 to 4 choices");
  });

  it("defines the judge-facing opaque choice shape", () => {
    const decision: AutopilotChoiceDecision = {
      kind: "choice",
      choices: [
        { choiceId: "a", label: "A", nextGoal: "goal-a" },
        { choiceId: "b", label: "B", nextGoal: "goal-b" },
      ],
    };
    expect(decision.kind).toBe("choice");
  });
});
