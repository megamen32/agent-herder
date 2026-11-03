import type { AutopilotRunnerInput } from "../autopilot-runner.js";

/** The marker the model emits when it starts its final goal review. */
export const GOAL_REVIEW_MARKER = "goal_review";
/** The marker the model emits when it is certain the goal is fully complete. */
export const GOAL_COMPLETE_MARKER = "goal_complete";

/** Prompt sent when the model emits goal_review: force a strict verification
 * of every user requirement + tell it to write goal_complete to finish. */
const GOAL_REVIEW_PROMPT =
  "Проверь, что ты выполнил ВСЁ, что просил пользователь. Пройдись по каждому пункту поручения и подтверди, что оно сделано. " +
  "Если что-то осталось незавершённым — продолжи работу. " +
  "Если ты уверен, что всё завершено и больше ничего не осталось, выведи маркер goal_complete.";

/** Prompt sent when no marker is present (stall / unfinished turn): force the
 * model to continue to the end + emit the review marker when done. */
const CONTINUE_PROMPT =
  "Продолжи выполнение до конца. Не останавливайся, пока не завершишь цель. " +
  "Когда всё сделано и больше ничего не осталось, сначала выведи goal_review " +
  "(проверь, что выполнил всё, что просил пользователь), затем goal_complete.";

/** Self-judge evaluation: no external LLM judge. The model signals completion
 * via markers in its own output.
 *   - goal_complete -> terminal/completed (done).
 *   - goal_review   -> continue with the verification prompt (leads to goal_complete).
 *   - neither       -> continue with "Продолжи до конца".
 * This keeps autopilot working even when the judge LLM is unavailable. */
export async function selfJudgeEvaluate(input: AutopilotRunnerInput): Promise<Record<string, unknown>> {
  const text = input.lastAssistantMessage ?? "";
  if (new RegExp(`\\b${GOAL_COMPLETE_MARKER}\\b`, "i").test(text)) {
    return { decision: "terminal", terminalKind: "completed", self_judge: true };
  }
  if (new RegExp(`\\b${GOAL_REVIEW_MARKER}\\b`, "i").test(text)) {
    return { decision: "continue", next_goal: GOAL_REVIEW_PROMPT, self_judge: true };
  }
  return { decision: "continue", next_goal: CONTINUE_PROMPT, self_judge: true };
}
