import { randomBytes } from "node:crypto";
import type { AutopilotRunnerInput } from "../autopilot-runner.js";

export const MARKER_REVIEW = "goal_review";
export const MARKER_COMPLETE = "goal_complete";
export const MARKER_CLOSED = "goal_closed";

type Stage = "work" | "review" | "complete" | "closed";
type SelfJudgeState = { stage: Stage; uid: string };

const stateMap = new Map<string, SelfJudgeState>();
const nextUid = () => randomBytes(4).toString("hex");

type SnapshotMessage = { role: string; text: string };
const userTexts = (input: { messages?: SnapshotMessage[] }): string[] =>
  (input.messages ?? []).filter(m => m.role === "user").map(m => (m.text ?? "").slice(0, 200));

const workPrompt = (uidValue: string, users: string[]): string => {
  const context = users.slice(2, -2).slice(0, 6).map((t, i) => `${i + 1}. ${t}`).join("\n");
  return "Продолжи выполнение цели до конца. Не останавливайся, пока не завершишь всё." +
    (context ? "\nКонтекст поручения:\n" + context : "") +
    "\nКогда закончишь работу и уверен, что всё выполнено, выведи маркер goal_review:" + uidValue;
};
const reviewPrompt = (uidValue: string, users: string[]): string => {
  const head = users.slice(0, 8);
  const tail = users.slice(-8);
  const context = [...head, ...tail].map((t, i) => `${i + 1}. ${t}`).join("\n");
  return "Проведи ревью: проверь КАЖДЫЙ пункт, который просил пользователь. Подтверди или опровергни выполнение каждого." +
    (context ? "\nПоручения пользователя (первые и последние):\n" + context : "") +
    "\nЕсли ВСЁ выполнено и подтверждено, выведи маркер goal_complete:" + uidValue +
    "\nЕсли что-то не сделано — продолжай работу (без маркера).";
};
const closePrompt = (uidValue: string): string =>
  "Ревью подтверждено: все пункты выполнены. Заверши цель: выведи маркер goal_closed:" + uidValue;

const markerRegex = /goal_(review|complete|closed):([a-f0-9]{8})/i;

export async function selfJudgeEvaluate(input: AutopilotRunnerInput & { messages?: SnapshotMessage[] }): Promise<Record<string, unknown>> {
  const key = `${input.harness}:${input.sessionId}`;
  let state = stateMap.get(key);
  if (!state) state = { stage: "work", uid: nextUid() };
  const text = input.lastAssistantMessage ?? "";
  const match = markerRegex.exec(text);

  if (state.stage === "review" && match && match[1].toLowerCase() === MARKER_REVIEW && match[2] === state.uid) {
    const newUid = nextUid();
    stateMap.set(key, { stage: "complete", uid: newUid });
    return { decision: "continue", next_goal: reviewPrompt(newUid, userTexts(input)), self_judge: true };
  }
  if (state.stage === "complete" && match && match[1].toLowerCase() === MARKER_COMPLETE && match[2] === state.uid) {
    const newUid = nextUid();
    stateMap.set(key, { stage: "closed", uid: newUid });
    return { decision: "continue", next_goal: closePrompt(newUid), self_judge: true };
  }
  if (state.stage === "closed" && match && match[1].toLowerCase() === MARKER_CLOSED && match[2] === state.uid) {
    stateMap.delete(key);
    return { decision: "terminal", terminalKind: "completed", self_judge: true };
  }

  stateMap.set(key, state);
  const users = userTexts(input);
  if (state.stage === "review") {
    return { decision: "continue", next_goal: reviewPrompt(state.uid, users), self_judge: true };
  }
  if (state.stage === "complete") {
    return { decision: "continue", next_goal: closePrompt(state.uid), self_judge: true };
  }
  return { decision: "continue", next_goal: workPrompt(state.uid, users), self_judge: true };
}
