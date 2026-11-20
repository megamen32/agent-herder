import { newInputId } from "./composer-delivery.js";
import type { ControlResult } from "../types/index.js";

/** An explicit retry after a lost HTTP response addresses the original stop. */
export async function requestBrowserStop(
  target: { hostId: string; harness: string; id: string }, observedInput: string | undefined,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, fetcher: typeof fetch = fetch,
): Promise<void> {
  const key = "agent-herder.browser-stop." + JSON.stringify([target.hostId, target.harness, target.id]);
  const saved = storage.getItem(key);
  const prior = saved ? JSON.parse(saved) as { inputId: string; observedInput?: string } : undefined;
  const inputId = prior && (!observedInput || !prior.observedInput || prior.observedInput === observedInput)
    ? prior.inputId : "stop-" + newInputId();
  const intent = JSON.stringify({ inputId, observedInput: observedInput ?? prior?.observedInput });
  storage.setItem(key, intent);
  const url = `/api/sessions/${encodeURIComponent(target.harness)}/${encodeURIComponent(target.id)}/stop`;
  const unconfirmed = "Прерывание не подтверждено. Ключ остановки сохранён для сверки.";
  let response: Response;
  let result: ControlResult | null;
  try {
    response = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ hostId: target.hostId, inputId, humanRequested: false }) });
    result = await response.json();
  } catch { throw new Error(unconfirmed); }
  if (result?.inputId === inputId && result?.sessionId === target.id && result.held === true) {
    const acknowledged = response.ok && result.ok === true && result.nativeInterrupt === "acknowledged";
    const notSent = result.nativeInterrupt === "not_sent" || result.nativeInterrupt === "not_attempted_no_known_handoff";
    if ((acknowledged || notSent) && storage.getItem(key) === intent) storage.removeItem(key);
    if (acknowledged) return;
    if (result.nativeInterrupt === "not_attempted_no_known_handoff") throw new Error("Продолжение заблокировано. У владельца сессии нет подтверждённого ввода для прерывания.");
    if (notSent) throw new Error("Продолжение заблокировано. Команда прерывания не отправлена.");
    if (result.nativeInterrupt === "required_or_reconcile") throw new Error("Продолжение заблокировано. Исход прерывания требует сверки.");
  }
  throw new Error(unconfirmed);
}
