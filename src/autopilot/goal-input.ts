import { createHash } from "node:crypto";
import { GoalStore, type GoalIdentity, type GoalReference, type GoalRequirement, type GoalSnapshot } from "./goal-store.js";

export function goalEventId(identity: GoalIdentity, text: string, nativeCursor: string): string {
  return createHash("sha256").update(`${identity.harness}\0${identity.sessionId}\0${identity.cwd}\0${nativeCursor}\0${text}`).digest("hex");
}

/** Initial objective must come from the accepted UI event, never a Stop-hook tail. */
export async function armAutopilotGoal(store: GoalStore, input: {
  identity: GoalIdentity; fullObjective: string; eventId: string; requirements: GoalRequirement[]; refs?: GoalReference[]; source: "accepted-human-ui";
}): Promise<GoalSnapshot> {
  if (!input.fullObjective.trim()) throw new Error("A full human-authored objective is required");
  return store.arm({ identity: input.identity, goal: { eventId: input.eventId, text: input.fullObjective, refs: input.refs }, requirements: input.requirements });
}

/** Only the native accepted-human-input seam may call this; automated deliveries have no such source receipt. */
export async function acceptAutopilotHumanInput(store: GoalStore, input: {
  identity: GoalIdentity; text: string; nativeCursor: string; refs?: GoalReference[]; source: "accepted-human-ui";
}): Promise<{ snapshot: GoalSnapshot; accepted: boolean; duplicate: boolean }> {
  if (!input.text.trim()) throw new Error("accepted human input must not be empty");
  const result = await store.acceptHumanEvent(input.identity, {
    eventId: goalEventId(input.identity, input.text, input.nativeCursor), text: input.text, refs: input.refs,
  });
  return { ...result, accepted: true };
}
